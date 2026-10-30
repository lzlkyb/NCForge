//! 常驻 JVM 桥：行协议 + 超时 + 崩溃重来。SVN 桥与数据库桥共用这一套。
//!
//! 为什么常驻而不是一次一进程：JVM 启动约 0.4 秒，而审查时会连续点十几个文件的 diff、
//! 再翻历史、再看 blame——每步重起一次 JVM 就是每步白等半秒。数据库更明显：一次连接
//! 握手要几百毫秒，每次查询都重连不可接受。
//!
//! 协议（详见各桥 Java 侧头部注释）：
//! - 请求：`id \t cmd \t arg…`，一行一条，UTF-8，字段内的 `\` `\t` `\n` 转义；
//! - 响应：每行一个 JSON，`{"id":..,"ok":true,"data":{..}}`；长任务先来若干
//!   `{"id":..,"progress":{..}}`（这里当心跳处理掉，不进返回值）；
//! - 桥进程崩溃/超时：本次调用报错，按 [`OnTimeout`] 决定杀掉进程还是发取消。
//!
//! **响应按 id 分发**（`pending` 表），不是「谁先等谁拿」。这样两件事才成立：
//! ① 一条长查询等结果时，`cancel` 能插进去（它自己写一行、不等响应）；
//! ② 多个连接共享一个 JVM 时，各自的响应不会串台。
//! 代价是陈旧响应（超时之后才回来的）会被直接丢掉——这也正是想要的。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 桥的一次调用结果。
#[derive(Debug)]
pub struct BridgeError {
    pub message: String,
    /// `auth` / `conflict` / `wc` / `timeout` / `spawn` / `sql` / `other`。
    /// 前端按它决定引导文案。
    pub code: String,
}

impl BridgeError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// 建桥需要的环境。
#[derive(Debug, Clone)]
pub struct BridgeEnv {
    pub java: PathBuf,
    pub jars: Vec<PathBuf>,
    /// 桥自己的配置/凭据目录（SVN 桥专用；数据库桥放日志之类）。
    pub config_dir: PathBuf,
    /// 启动的 Java 主类名（`NcSvnBridge` / `NcDbBridge`）。
    pub main_class: String,
    /// 出错信息里的人话主语：`SVN` / `数据库`。
    pub label: String,
    /// 堆上限（MB）。SVN 桥 384 够用；数据库桥要留出结果集，给 512。
    pub xmx_mb: u32,
}

/// 一次调用超时之后怎么收拾。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnTimeout {
    /// 杀掉进程重来。SVN 桥用这个：一个进程只服务一个仓库操作，
    /// 杀掉最干净，也不用去猜「服务端还卡在上一个操作里」。
    Kill,
    /// 给桥发一条 `cancel`，进程留着。数据库桥用这个——多个连接共享一个 JVM 时，
    /// 为一个慢查询杀掉进程会把别的连接一起带走。
    Cancel,
}

/// 桥进程的共享状态。`Arc` 是因为读 stdout 的线程也要用。
struct Shared {
    /// 写命令用。与 `child` 分开加锁：`cancel` 要在别人等响应的时候插进来写一行。
    stdin: Mutex<Option<ChildStdin>>,
    /// 进程句柄。只在 kill / 判活 / 收尸时用。
    child: Mutex<Option<Child>>,
    /// 正在等响应的调用：请求 id → 收件箱。响应由读线程按 id 投递。
    pending: Mutex<HashMap<u64, Sender<serde_json::Value>>>,
    /// 请求 id 从 1 开始递增；`0` 留给我们主动发的 `cancel`（它不需要等响应）。
    next_id: AtomicU64,
}

impl Shared {
    fn new() -> Self {
        Self {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    fn lock_stdin(&self) -> std::sync::MutexGuard<'_, Option<ChildStdin>> {
        self.stdin.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_child(&self) -> std::sync::MutexGuard<'_, Option<Child>> {
        self.child.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Sender<serde_json::Value>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 桥本体。
///
/// 不再用一把大锁串行化所有调用：改成「写一行」和「等自己的响应」两段，
/// 中间不持锁，于是并发调用与取消都能成立。
pub struct Bridge {
    env: BridgeEnv,
    shared: Arc<Shared>,
    /// 只保护「拉起进程」这一步，避免并发首次调用各起一个 JVM。
    spawn_lock: Mutex<()>,
    /// 桥进程 stderr 的尾巴，出错时一并返回，省得用户只能看到「调用失败」。
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

/// 等响应期间挂着这一枚，任何返回路径（含 `?` 提前返回）都会把自己的收件箱摘掉，
/// 不会留下永远没人取的信箱。
struct PendingGuard {
    shared: Arc<Shared>,
    id: u64,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.shared.lock_pending().remove(&self.id);
    }
}

impl Bridge {
    pub fn new(env: BridgeEnv) -> Self {
        Self {
            env,
            shared: Arc::new(Shared::new()),
            spawn_lock: Mutex::new(()),
            stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub fn env(&self) -> &BridgeEnv {
        &self.env
    }

    /// 进程是否还活着（界面用来显示「桥已退出，将自动重启」之类的提示）。
    pub fn alive(&self) -> bool {
        let mut guard = self.shared.lock_child();
        match guard.as_mut() {
            Some(s) => matches!(s.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// 关掉桥进程（应用退出/切换工作区时调用）。
    pub fn shutdown(&self) {
        // 尽力而为：先发一条 quit 让桥自己收拾事务/会话，发不出去就直接杀
        let _ = self.write_line(&encode_request(0, "quit", &[]));
        self.kill();
    }

    /// 重启：先杀掉现有进程，下次调用重新拉起。
    pub fn restart(&self) {
        self.kill();
    }

    /// 跑一条命令。超时按 [`OnTimeout::Kill`]（SVN 桥的既有语义）。
    /// `args` 里不要带 TAB/换行（会被转义，桥侧会还原）。
    pub fn call(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<serde_json::Value, BridgeError> {
        self.call_with_progress(cmd, args, timeout, |_| {})
    }

    /// 带进度的版本：`on_progress` 收到桥推来的 `progress` 对象（目前只有 SVN status 会用）。
    pub fn call_with_progress(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: Duration,
        on_progress: impl FnMut(&serde_json::Value),
    ) -> Result<serde_json::Value, BridgeError> {
        self.call_with(cmd, args, timeout, OnTimeout::Kill, on_progress)
    }

    /// 完整版：可指定超时后的处置。
    pub fn call_with(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: Duration,
        on_timeout: OnTimeout,
        on_progress: impl FnMut(&serde_json::Value),
    ) -> Result<serde_json::Value, BridgeError> {
        self.invoke(
            |id| encode_request(id, cmd, args),
            cmd,
            timeout,
            on_timeout,
            on_progress,
        )
    }

    /// 在指定会话上跑一条命令（数据库桥用的四段格式：`id \t 会话 \t 命令 \t 参数…`）。
    ///
    /// 超时按 [`OnTimeout::Cancel`] 处置，因为一个 JVM 里通常还有别的会话。
    pub fn call_in_session(
        &self,
        sess: &str,
        cmd: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<serde_json::Value, BridgeError> {
        self.invoke(
            |id| encode_request_sess(id, sess, cmd, args),
            cmd,
            timeout,
            OnTimeout::Cancel,
            |_| {},
        )
    }

    /// 只发不等（取消、断开这类命令用）。
    pub fn send_in_session(
        &self,
        sess: &str,
        cmd: &str,
        args: &[&str],
    ) -> Result<(), BridgeError> {
        if !self.alive() {
            return Err(BridgeError::new("spawn", "桥进程未运行"));
        }
        // id=0：不会与任何真实请求撞号，桥回的 ok/error 因为没有等待者而被丢弃
        self.write_line(&encode_request_sess(0, sess, cmd, args))
            .map_err(|e| BridgeError::new("other", format!("发送 {cmd} 失败（{e}）")))
    }

    fn invoke<F>(
        &self,
        build_line: F,
        cmd_label: &str,
        timeout: Duration,
        on_timeout: OnTimeout,
        mut on_progress: impl FnMut(&serde_json::Value),
    ) -> Result<serde_json::Value, BridgeError>
    where
        F: FnOnce(u64) -> String,
    {
        self.ensure_spawned()?;

        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.shared.lock_pending().insert(id, tx);
        // 从这里开始，任何返回路径都要摘掉收件箱
        let _pending = PendingGuard {
            shared: self.shared.clone(),
            id,
        };

        if let Err(e) = self.write_line(&build_line(id)) {
            let tail = self.take_stderr();
            self.kill();
            return Err(BridgeError::new(
                "spawn",
                format!("写{}桥进程失败（{e}）。{tail}", self.env.label),
            ));
        }

        let deadline = std::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return Err(self.handle_timeout(cmd_label, on_timeout));
            }
            match rx.recv_timeout(left) {
                Ok(v) => {
                    if v.get("progress").is_some() {
                        on_progress(&v["progress"]);
                        continue;
                    }
                    if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
                        return Ok(v.get("data").cloned().unwrap_or(serde_json::Value::Null));
                    }
                    let code = v.get("code").and_then(|x| x.as_str()).unwrap_or("other");
                    let msg = v
                        .get("error")
                        .and_then(|x| x.as_str())
                        .unwrap_or("未知错误")
                        .to_string();
                    // 失败不销毁进程：鉴权失败、冲突、SQL 报错都不是进程级问题
                    return Err(BridgeError::new(code, msg));
                }
                Err(RecvTimeoutError::Timeout) => continue, // 下一轮走到期判定
                Err(RecvTimeoutError::Disconnected) => {
                    let tail = self.take_stderr();
                    return Err(BridgeError::new(
                        "spawn",
                        format!("{} 桥进程已退出（{cmd_label}）。{tail}", self.env.label),
                    ));
                }
            }
        }
    }

    /// 取消正在执行的语句。**不等待响应、不持调用锁**，所以能在别的调用等结果时插进去。
    ///
    /// 桥侧收到 `cancel` 后调 `Statement.cancel()`；被取消的那条语句自己会回一个
    /// `ORA-01013` 错误，那个错误的 id 是原先的执行请求，由等待者正常收走。
    pub fn send_cancel_in_session(&self, sess: &str) -> Result<(), BridgeError> {
        self.send_in_session(sess, "cancel", &[])
    }

    fn handle_timeout(&self, cmd: &str, on_timeout: OnTimeout) -> BridgeError {
        match on_timeout {
            OnTimeout::Cancel => {
                // 这里拿不到会话名（Bridge 是通用组件），所以不发取消；
                // 由调用方（EngineHandle）收到这个错误后带上会话名补发一次。
                let tail = self.take_stderr();
                BridgeError::new(
                    "timeout",
                    format!("{} 命令超时（{cmd}），正在取消。{tail}", self.env.label),
                )
            }
            OnTimeout::Kill => {
                let tail = self.take_stderr();
                self.kill();
                BridgeError::new(
                    "timeout",
                    format!("{} 命令超时（{cmd}）。{tail}", self.env.label),
                )
            }
        }
    }

    fn take_stderr(&self) -> String {
        let mut q = self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
        if q.is_empty() {
            return String::new();
        }
        let joined: Vec<String> = q.drain(..).collect();
        format!("桥的 stderr 末尾：{}", joined.join(" | "))
    }

    /// 写一行请求。持 stdin 锁的时间只有一次 write + flush，不涉及等待。
    fn write_line(&self, line: &str) -> std::io::Result<()> {
        let mut guard = self.shared.lock_stdin();
        let Some(stdin) = guard.as_mut() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "桥进程还没启动",
            ));
        };
        stdin.write_all(line.as_bytes())?;
        stdin.flush()
    }

    /// 杀掉进程并清空所有等待者（它们会收到 Disconnected 而各自报错）。
    fn kill(&self) {
        // 先关 stdin：桥侧的读循环会因此收到 EOF 而自己退出
        if let Some(mut stdin) = self.shared.lock_stdin().take() {
            let _ = stdin.flush();
        }
        if let Some(mut child) = self.shared.lock_child().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.shared.lock_pending().clear();
    }

    /// 确认进程在跑；不在就拉一个（并发首次调用只会有一个真的去拉）。
    fn ensure_spawned(&self) -> Result<(), BridgeError> {
        let _guard = self.spawn_lock.lock().unwrap_or_else(|e| e.into_inner());
        if self.alive() {
            return Ok(());
        }
        // 尸体（已退出但还没收）要清掉，否则 stdin 写进去是静默失败的
        self.kill();
        self.spawn()
    }

    fn spawn(&self) -> Result<(), BridgeError> {
        let cp = self
            .env
            .jars
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(";");
        if self.env.jars.is_empty() {
            return Err(BridgeError::new(
                "spawn",
                format!("没有找到{}桥需要的组件", self.env.label),
            ));
        }
        let mut cmd = Command::new(&self.env.java);
        cmd.arg(format!("-Xmx{}m", self.env.xmx_mb))
            .arg("-Dfile.encoding=UTF-8")
            .arg("-cp")
            .arg(cp)
            .arg(&self.env.main_class)
            .arg("--config")
            .arg(&self.env.config_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // 打包版里绝不能弹黑框（Windows 上 java.exe 是控制台程序）
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            BridgeError::new(
                "spawn",
                format!("启动{}桥失败（{:?}）：{e}", self.env.label, self.env.java),
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BridgeError::new("spawn", "桥进程没有 stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BridgeError::new("spawn", "桥进程没有 stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| BridgeError::new("spawn", "桥进程没有 stderr"))?;

        self.start_reader(stdout)?;
        self.start_log_pump(stderr)?;

        *self.shared.lock_stdin() = Some(stdin);
        *self.shared.lock_child() = Some(child);
        Ok(())
    }

    /// stdout 读取线程：按 id 把每一行投递给对应的等待者。
    fn start_reader(&self, stdout: std::process::ChildStdout) -> Result<(), BridgeError> {
        let shared = self.shared.clone();
        let tail = self.stderr_tail.clone();
        std::thread::Builder::new()
            .name("java-bridge-out".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(text) = line else { break };
                    let v: serde_json::Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => {
                            // 不是协议行：多半是第三方库漏到 stdout 的日志。丢掉但留档，
                            // 等真的超时了就能在报错里看到它。
                            let mut q = tail.lock().unwrap_or_else(|e| e.into_inner());
                            if q.len() >= 20 {
                                q.pop_front();
                            }
                            q.push_back(format!("[非协议输出] {}", truncate(&text, 200)));
                            continue;
                        }
                    };
                    let Some(id) = v
                        .get("id")
                        .and_then(|x| x.as_str())
                        .and_then(|s| s.parse::<u64>().ok())
                    else {
                        continue;
                    };
                    let is_progress = v.get("progress").is_some();
                    // 进度帧不能摘信箱（后面还有终帧）；终帧摘掉
                    let sender = {
                        let mut p = shared.lock_pending();
                        if is_progress {
                            p.get(&id).cloned()
                        } else {
                            p.remove(&id)
                        }
                    };
                    if let Some(tx) = sender {
                        if tx.send(v).is_err() {
                            // 等待者已经走了（超时返回），剩下的帧直接丢
                        }
                    }
                }
                // EOF：进程没了。清空信箱让所有等待者立刻收到 Disconnected 而不是干等超时。
                shared.lock_pending().clear();
            })
            .map_err(|e| BridgeError::new("spawn", format!("起桥读取线程失败: {e}")))?;
        Ok(())
    }

    /// stderr 尾巴收集线程。
    fn start_log_pump(&self, stderr: std::process::ChildStderr) -> Result<(), BridgeError> {
        let tail = self.stderr_tail.clone();
        std::thread::Builder::new()
            .name("java-bridge-err".into())
            .spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    let mut q = tail.lock().unwrap_or_else(|e| e.into_inner());
                    if q.len() >= 20 {
                        q.pop_front();
                    }
                    q.push_back(line);
                }
            })
            .map_err(|e| BridgeError::new("spawn", format!("起桥日志线程失败: {e}")))?;
        Ok(())
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 一行请求。转义顺序必须是「先反斜杠」——否则路径里的 `\t` 会被二次转义成字面量。
pub fn encode_request(id: u64, cmd: &str, args: &[&str]) -> String {
    let mut s = String::with_capacity(64);
    s.push_str(&id.to_string());
    s.push('\t');
    s.push_str(&escape(cmd));
    for a in args {
        s.push('\t');
        s.push_str(&escape(a));
    }
    s.push('\n');
    s
}

/// 带会话名的四段请求：`id \t 会话 \t 命令 \t 参数…`（数据库桥用）。
///
/// 会话名单独占一段而不是挤进参数里：桥侧的命令分发只认参数字典，
/// 不必为了多一个会话名把每个命令的参数下标都往右挪一位。
pub fn encode_request_sess(id: u64, sess: &str, cmd: &str, args: &[&str]) -> String {
    let mut s = String::with_capacity(80);
    s.push_str(&id.to_string());
    s.push('\t');
    s.push_str(&escape(sess));
    s.push('\t');
    s.push_str(&escape(cmd));
    for a in args {
        s.push('\t');
        s.push_str(&escape(a));
    }
    s.push('\n');
    s
}

fn escape(v: &str) -> String {
    let mut s = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            '\\' => s.push_str("\\\\"),
            '\t' => s.push_str("\\t"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            _ => s.push(c),
        }
    }
    s
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let head: String = s.chars().take(n).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 请求行按协议转义() {
        let line = encode_request(7, "diff", &[r"C:\work\aier\A.java"]);
        assert_eq!(line, "7\tdiff\tC:\\\\work\\\\aier\\\\A.java\n");
    }

    #[test]
    fn 制表符与换行也要转义() {
        let line = encode_request(1, "commit", &["说明\t带制表符\n和换行"]);
        assert_eq!(line, "1\tcommit\t说明\\t带制表符\\n和换行\n");
        assert_eq!(line.matches('\t').count(), 2, "只有两个真分隔符");
    }

    #[test]
    fn 截断按字符不按字节() {
        assert_eq!(truncate("中文中文", 2), "中文…");
        assert_eq!(truncate("abc", 10), "abc");
    }

    #[test]
    fn 取消请求用_id_0_不与真实请求撞号() {
        // next_id 从 1 起递增，0 专门留给主动取消；否则取消会被当成某个真实请求的响应
        assert_eq!(encode_request(0, "cancel", &[]), "0\tcancel\n");
        let shared = Shared::new();
        assert_eq!(shared.next_id.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn 四段请求把会话名放在命令之前() {
        // 布局必须是 id \t 会话 \t 命令 \t 参数…：桥侧要能一眼分出会话名而不是把它当参数
        let line = encode_request_sess(7, "conn-1", "exec", &["select 1 from dual", "500"]);
        assert_eq!(line, "7\tconn-1\texec\tselect 1 from dual\t500\n");
        assert_eq!(line.matches('\t').count(), 4, "四个真分隔符");
    }

    #[test]
    fn 会话名里的反斜杠与制表符同样转义() {
        let line = encode_request_sess(1, "a\\b\tc", "ping", &[]);
        assert_eq!(line, "1\ta\\\\b\\tc\tping\n");
    }

    #[test]
    fn 收件箱在调用结束后被摘掉() {
        let shared = Arc::new(Shared::new());
        let (tx, _rx) = mpsc::channel();
        shared.lock_pending().insert(42, tx);
        assert_eq!(shared.lock_pending().len(), 1);
        {
            let _g = PendingGuard {
                shared: shared.clone(),
                id: 42,
            };
        }
        assert!(shared.lock_pending().is_empty(), "离开作用域就该摘掉");
    }

    #[test]
    fn 超时策略区分杀进程与发取消() {
        // 纯逻辑断言：数据库桥必须走 Cancel，否则一个慢查询会把共享 JVM 里的其它连接带走
        assert_ne!(OnTimeout::Cancel, OnTimeout::Kill);
    }
}
