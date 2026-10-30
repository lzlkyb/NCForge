//-----------------------------------------------------------------------------
// Copyright (c) 2026, Oracle and/or its affiliates.
//
// This software is dual-licensed to you under the Universal Permissive License
// (UPL) 1.0 as shown at https://oss.oracle.com/licenses/upl and Apache License
// 2.0 as shown at http://www.apache.org/licenses/LICENSE-2.0. You may choose
// either license.
//
// If you elect to accept the software under the Apache License, Version 2.0,
// the following applies:
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//-----------------------------------------------------------------------------

//-----------------------------------------------------------------------------
// break_handle.rs
//
// 语句中断（对应上游 issue oracle/rust-oracledb#24「没有 cancel/break API」）。
//
// 难点在于：一次 round-trip 里 `Client` 被 `Mutex` 锁住、socket 读是阻塞的，
// 别的线程没有任何插入点。这里的做法分三层：
//
//   1. `BreakHandle` 里只有一个 `Arc<BreakState>`（一个原子量）。`interrupt()`
//      **不拿锁、不碰 socket**，所以查询执行期间调用也不会死锁 —— 这正是 JDBC
//      `Statement.cancel()` 的语义。
//   2. 传输层把阻塞读切成 ≤100ms 的片（见 `transport::Transport::read_packet_sliced`），
//      每片醒来检查一次有没有人请求中断。
//   3. 发现中断请求后**不在这里发协议包**，而是让这次读返回「调用超时」错误，
//      由既有的 `Client::recover_from_error` 在持锁线程里发 INTERRUPT 标记再 reset。
//      这样 socket 的写永远只发生在拥有它的那个线程上，不需要跨线程写 socket。
//
// 中断请求是一次性的：被消费掉或者下一次 round-trip 开始时清掉，避免「上一次查询
// 的取消」误伤下一条语句（`Client::perform_round_trip` 里调 `clear()`）。
// -----------------------------------------------------------------------------

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 读 socket 的切片长度。越短中断越及时，但每片醒来都要多一次系统调用。
pub(crate) const BREAK_SLICE_MS: u64 = 100;

/// 中断状态的共享体：连接对象与句柄各持一份 `Arc`。
#[derive(Default)]
pub(crate) struct BreakState {
    pending: AtomicBool,
}

impl BreakState {
    /// 记录一次中断请求。**不阻塞、不拿锁**，可以在任意线程调用。
    pub(crate) fn request(&self) {
        self.pending.store(true, Ordering::SeqCst);
    }

    /// 取走中断请求：有请求返回 true 并清掉，之后这次读就要收尾了。
    pub(crate) fn take(&self) -> bool {
        self.pending.swap(false, Ordering::SeqCst)
    }

    /// 丢掉还没被消费的请求（开始新一次 round-trip 时调）。
    pub(crate) fn clear(&self) {
        self.pending.store(false, Ordering::SeqCst);
    }
}

/// 可以从**另一个线程**触发的语句中断句柄。
///
/// ```ignore
/// let handle = conn.break_handle()?;
/// std::thread::spawn(move || { /* … */ handle.interrupt(); });
/// ```
///
/// 语义与 JDBC 的 `Statement.cancel()` 一致：只是「请求服务器别再算下去了」，
/// 被中断的语句会以错误返回（服务端通常回 ORA-01013），连接本身仍然可用。
#[derive(Clone)]
pub struct BreakHandle {
    state: Arc<BreakState>,
}

impl BreakHandle {
    pub(crate) fn new(state: Arc<BreakState>) -> Self {
        Self { state }
    }

    /// 请求中断当前正在执行的语句。
    ///
    /// 只有「调用这一刻正在等数据库回包」的那次请求会受影响；如果没有请求在执行，
    /// 这个中断会被下一次 round-trip 开始时丢掉，不会误伤后面的语句。
    pub fn interrupt(&self) {
        self.state.request();
    }
}

impl std::fmt::Debug for BreakHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BreakHandle").finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 中断请求是一次性的() {
        let h = BreakHandle::new(Arc::new(BreakState::default()));
        h.interrupt();
        assert!(h.state.take(), "第一次应当取到请求");
        assert!(!h.state.take(), "取走之后不该再返回 true");
    }

    #[test]
    fn 开始新的往返会丢掉旧请求() {
        let h = BreakHandle::new(Arc::new(BreakState::default()));
        h.interrupt();
        h.state.clear();
        assert!(!h.state.take(), "被清掉的请求不该生效");
    }

    #[test]
    fn 句柄可以跨线程持有() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<BreakHandle>();
    }
}
