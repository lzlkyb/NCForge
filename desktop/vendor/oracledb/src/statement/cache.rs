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
// cache.rs
//
// Defines the structure representing a statement cache.
//-----------------------------------------------------------------------------

use std::collections::HashMap;
use std::collections::VecDeque;

use super::CachedStatement;
use super::StatementOptions;
use crate::error::Error;

/// Defines a cache that maintains a set of prepared statements. Most recently
/// used statements are retained longer.
pub(crate) struct StatementCache {
    max_size: usize,
    cached_statements: Vec<Option<CachedStatement>>,
    slots_by_name: HashMap<String, usize>,
    empty_slots: VecDeque<usize>,
    free_used_slots: VecDeque<usize>,
    cursors_to_close: Vec<u16>,
}

impl StatementCache {
    /// Returns a slot that is available in the cache. This method should only
    /// be called if there is space available in the cache. Preference is given
    /// to empty slots, but if there are no empty slots, a free used slot is
    /// used instead.
    fn get_available_slot(&mut self) -> usize {
        if let Some(slot_num) = self.empty_slots.pop_front() {
            slot_num
        } else {
            let slot_num = self.free_used_slots.pop_front().unwrap();
            let orig_info =
                self.cached_statements[slot_num - 1].take().unwrap();
            self.slots_by_name.remove(orig_info.sql());
            self.close_cursor(&orig_info);
            slot_num
        }
    }

    /// Returns a steatement when an entry exists in the cache. If a cached
    /// statement is not in use, it is removed from the cache if caching of the
    /// statement is no longer desired.
    fn get_statement_from_entry(
        &mut self,
        slot_num: usize,
        cache_statement: bool,
        options: &StatementOptions,
    ) -> CachedStatement {
        // 先把要用的东西从 `cached_statements` 里取出来（下面要 `&mut self` 关游标，
        // 不能同时持着那里的不可变借用）。
        let (mut info, fetch_lobs_changed, cached_sql) = {
            let cached_info =
                self.cached_statements[slot_num - 1].as_ref().unwrap();
            (
                cached_info.clone_with_options(options),
                cached_info.options().fetch_lobs() != options.fetch_lobs(),
                cached_info.sql().to_string(),
            )
        };
        // 复用 slot 之前一律先把这个 slot 上可能还挂着的游标关掉并清 id
        // （`clone_with_options` 会把 cursor_id 一起复制过来）。不这么做，
        // 语句就会带着旧游标执行，驱动走 REEXECUTE_AND_FETCH 拿到错位的行包。
        // 详见 `return_statement` 的注释。
        self.close_cursor(&info);
        info.clear_cursor();
        if let Some(index) =
            self.free_used_slots.iter().position(|x| *x == slot_num)
        {
            self.free_used_slots.remove(index);
            if !cache_statement {
                self.slots_by_name.remove(&cached_sql);
                self.cached_statements[slot_num - 1] = None;
                self.empty_slots.push_back(slot_num);
                info.set_cache_slot_num(0);
            }
        } else {
            info.set_cache_slot_num(0);
        }
        if fetch_lobs_changed {
            info.clear_cursor();
        }
        info
    }

    /// Returns a statement when no entry with the specified SQL exists in the
    /// cache. If requested and there is space available in the cache and the
    /// statement is not a DDL statement, the structure will be assigned a slot
    /// and cached.
    fn get_statement_no_entry(
        &mut self,
        sql: &str,
        cache_statement: bool,
        options: &StatementOptions,
    ) -> Result<CachedStatement, Error> {
        let mut statement = CachedStatement::new(sql, options)?;
        if cache_statement && !statement.is_ddl() && self.has_space() {
            let slot_num = self.get_available_slot();
            statement.set_cache_slot_num(slot_num);
            self.cached_statements[slot_num - 1] = Some(statement.clone());
            self.slots_by_name.insert(sql.to_string(), slot_num);
        }
        Ok(statement)
    }

    /// Close any cursor associated with the statement.
    pub(crate) fn close_cursor(&mut self, info: &CachedStatement) {
        if info.has_cursor() && !info.is_nested() {
            self.cursors_to_close.push(info.cursor_id());
        }
    }

    /// Returns whether the cache is able to accept more entries.
    fn has_space(&self) -> bool {
        !self.empty_slots.is_empty() || !self.free_used_slots.is_empty()
    }

    /// Returns whether the statement cache has cursors that need to be closed.
    pub(crate) fn has_cursors_to_close(&self) -> bool {
        !self.cursors_to_close.is_empty()
    }

    /// Returns a statement given the supplied SQL. The cache is searched and
    /// any entry found used; otherwise, a new structure is created and
    /// (optionally) cached.
    pub(crate) fn get_statement(
        &mut self,
        sql: &str,
        cache_statement: bool,
        options: &StatementOptions,
    ) -> Result<CachedStatement, Error> {
        match self.slots_by_name.get(sql) {
            Some(slot_num) => Ok(self.get_statement_from_entry(
                *slot_num,
                cache_statement,
                options,
            )),
            None => self.get_statement_no_entry(sql, cache_statement, options),
        }
    }

    /// Returns the maximum size of the cache.
    pub(crate) fn max_size(&self) -> usize {
        self.max_size
    }

    /// Creates a new cache of the requested size and returns it.
    pub(crate) fn new(max_size: usize) -> Self {
        Self {
            max_size,
            cached_statements: vec![None; max_size],
            slots_by_name: HashMap::new(),
            empty_slots: (1..=max_size).collect(),
            free_used_slots: VecDeque::with_capacity(max_size),
            cursors_to_close: Vec::new(),
        }
    }

    /// Resizes the cache to the new size. Currently this is only called when
    /// the maximum number of open cursors is less than the specified cache
    /// size. This method will panic if any entries are found.
    pub(crate) fn resize(&mut self, new_size: usize) {
        assert!(self.slots_by_name.is_empty());
        self.max_size = new_size;
        self.cached_statements = vec![None; new_size];
        self.empty_slots = (1..=new_size).collect();
        self.free_used_slots = VecDeque::with_capacity(new_size);
    }

    /// Returns information to the cache.
    pub(crate) fn return_statement(&mut self, info: &CachedStatement) {
        if info.is_cached() {
            let slot_num = info.cache_slot_num();
            // 🔴 语句带着没取完的分页游标回缓存时，必须先把游标记进「待关闭」队列
            // 再把 id 清掉。少了这一步，下一次同一条 SQL 命中这个 slot 时会带着
            // 旧 cursor_id 直接走 TTC_RPC_REEXECUTE_AND_FETCH：服务端按旧游标回
            // 预取行，客户端把残留字节当消息头读，报
            // `unknown TTC message type <随机值> at packet 1, offset …`，
            // 而且这条连接从此永久错位（`select * from 大表` 取一页再点查询必炸）。
            // 不同 SQL 的 slot 没有活游标，所以只有「同一条 SQL 重执行」才复现。
            let mut stored = info.clone();
            self.close_cursor(&stored);
            stored.clear_cursor();
            self.cached_statements[slot_num - 1] = Some(stored);
            self.free_used_slots.push_back(slot_num);
        } else {
            self.close_cursor(info);
        }
    }

    /// Returns the cursors that need to be closed and clears the list.
    pub(crate) fn take_cursors_to_close(&mut self) -> Vec<u16> {
        std::mem::take(&mut self.cursors_to_close)
    }
}
