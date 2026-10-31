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
// exec_result.rs
//
// Defines the structures representing execution results.
//-----------------------------------------------------------------------------

use std::sync::Arc;

use crate::client::ClientRef;
use crate::cursor::Cursor;
use crate::metadata::Metadata;
use crate::response::Response;
use crate::row::{DbRow, Row};
use crate::statement::{CachedStatement, Statement};

/// Represents the result returned by the database when calling
/// [Connection::execute()](`crate::Connection::execute()`),
/// [Connection::execute_named()](`crate::Connection::execute_named()`).
pub struct ExecResult {
    client_ref: ClientRef,
    column_info: Arc<Vec<Metadata>>,
    out_bind_data: Option<DbRow>,
    returned_data: Option<Vec<DbRow>>,
    implicit_results: Vec<CachedStatement>,
    rows_affected: u64,
}

impl ExecResult {
    pub(crate) fn new(
        client_ref: &ClientRef,
        statement: &CachedStatement,
        resp: &mut Response,
    ) -> Self {
        let mut out_bind_data: Option<DbRow> = None;
        let mut returned_data: Option<Vec<DbRow>> = None;
        if let Some(rows) = resp.take_rows()
            && !rows.is_empty()
        {
            let row = rows.into_iter().next().unwrap();
            if statement.is_plsql() {
                out_bind_data = Some(row)
            } else if statement.is_dml_returning() {
                returned_data = Some(row.transpose_arrays())
            }
        }
        Self {
            client_ref: client_ref.clone(),
            column_info: Arc::new(statement.out_metadata().to_vec()),
            out_bind_data,
            returned_data,
            implicit_results: resp.take_implicit_results(),
            rows_affected: resp.get_rowcount(),
        }
    }

    /// Returns the implicit resultsets sent by the database while executing the
    /// statement (TTC message 27), one [Cursor] per resultset.
    ///
    /// PL/SQL 用 `dbms_sql.return_result` 返回结果集时走这条路。每个游标都
    /// 带着列元数据和自己的 cursor id，第一次 `next()` 时才真正向服务端取行。
    /// 所有权每次调用都会转移，后续调用返回空 Vec。
    pub fn implicit_resultsets(&mut self) -> Vec<Cursor> {
        std::mem::take(&mut self.implicit_results)
            .into_iter()
            .map(|statement| {
                Cursor::new(Statement::new(self.client_ref.clone(), statement))
            })
            .collect()
    }

    /// Returns the number of rows affected by the execution of the statement.
    pub fn rows_affected(&self) -> u64 {
        self.rows_affected
    }

    /// Returns data returned by the database as OUT variables for PL/SQL. This
    /// transfers ownership of the data to the caller.
    pub fn out_bind_data(&mut self) -> Row {
        if let Some(row) = self.out_bind_data.take() {
            Row::new(&self.column_info, row)
        } else {
            Row::new_empty()
        }
    }

    /// Returns data returned by the database for DML RETURNING statements.
    /// This transfers ownership of the data to the caller.
    pub fn returned_data(&mut self) -> Vec<Row> {
        if let Some(rows) = self.returned_data.take() {
            rows.into_iter().map(|r| Row::new(&self.column_info, r)).collect()
        } else {
            Vec::new()
        }
    }
}

/// 没被 `implicit_resultsets()` 取走的子游标也要还给服务端。
///
/// `CachedStatement` 本身没有 Drop，公开的 `Statement` 才负责归还；这里
/// 持有的是裸 `CachedStatement`，不主动还就等于把服务端游标丢掉，
/// 反复执行 `dbms_sql.return_result` 而不看结果集会攒到 `open_cursors` 上限。
impl Drop for ExecResult {
    fn drop(&mut self) {
        for statement in self.implicit_results.drain(..) {
            if let Ok(mut client) = self.client_ref.lock() {
                client.return_statement(&statement);
            }
        }
    }
}

/// Represents the result returned by the database when calling
/// [Connection::execute_batch()](`crate::Connection::execute_batch()`).
pub struct ExecBatchResult {
    column_info: Arc<Vec<Metadata>>,
    out_bind_data: Option<Vec<DbRow>>,
    returned_data: Option<Vec<Vec<DbRow>>>,
    num_execs: usize,
    rows_affected: u64,
}

impl ExecBatchResult {
    pub(crate) fn new(
        statement: &CachedStatement,
        num_execs: usize,
        resp: &mut Response,
    ) -> Self {
        let mut out_bind_data: Option<Vec<DbRow>> = None;
        let mut returned_data: Option<Vec<Vec<DbRow>>> = None;
        if let Some(rows) = resp.take_rows()
            && !rows.is_empty()
        {
            if statement.is_plsql() {
                out_bind_data = Some(rows);
            } else if statement.is_dml_returning() {
                returned_data = Some(
                    rows.into_iter().map(|r| r.transpose_arrays()).collect(),
                );
            }
        }
        Self {
            column_info: Arc::new(statement.out_metadata().to_vec()),
            out_bind_data,
            returned_data,
            num_execs,
            rows_affected: resp.get_rowcount(),
        }
    }

    /// Returns the number of rows affected by the execution of the statement.
    pub fn rows_affected(&self) -> u64 {
        self.rows_affected
    }

    /// Returns data returned by the database as OUT variables in PL/SQL. This
    /// transfers ownership of the returned data to the caller.
    pub fn out_bind_data(&mut self) -> Vec<Row> {
        if let Some(rows) = self.out_bind_data.take() {
            rows.into_iter().map(|r| Row::new(&self.column_info, r)).collect()
        } else {
            std::iter::repeat_with(Row::new_empty)
                .take(self.num_execs)
                .collect()
        }
    }

    /// Returns data returned by the database for DML RETURNING statements.
    /// This transfers ownership of the data to the caller.
    pub fn returned_data(&mut self) -> Vec<Vec<Row>> {
        if let Some(rows_of_rows) = self.returned_data.take() {
            rows_of_rows
                .into_iter()
                .map(|rows| {
                    rows.into_iter()
                        .map(|r| Row::new(&self.column_info, r))
                        .collect()
                })
                .collect()
        } else {
            std::iter::repeat_with(Vec::<Row>::new)
                .take(self.num_execs)
                .collect()
        }
    }
}
