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
// response.rs
//
// Defines the structures used for handling the response to a request sent by
// the client to the server.
//-----------------------------------------------------------------------------

mod error_info;

use std::borrow::Cow;

use crate::client::Client;
use crate::client::ClientRef;
use crate::constants;
use crate::db_value::DbValue;
use crate::db_value::PendingDbValue;
use crate::error::Error;
use crate::metadata::Metadata;
use crate::packet::Packet;
use crate::read_buffer::FromBuf;
use crate::read_buffer::FromBufFallible;
use crate::read_buffer::ReadBuffer;
use crate::row::DbRow;
use crate::rowid::Rowid;
use crate::rowid::convert_logical_rowid;
use crate::statement::CachedStatement;

pub use error_info::DbError;
use error_info::ErrorInfo;

pub(crate) struct Response {
    packets: Vec<Packet>,
    buf: ReadBuffer,
    error_info: Option<ErrorInfo>,
    edition: Option<String>,
    current_schema: Option<String>,
    warning: Option<String>,
    rows: Option<Vec<DbRow>>,
    pending_values: Vec<Option<PendingDbValue>>,
    prev_fetch_last_row: Option<DbRow>,
    bit_vector: Option<Vec<u8>>,
    num_columns: usize,
    call_status: u32,
    end_of_fetch: bool,
    flush_out_binds: bool,
    /// 隐式结果集（TTC 消息 27）解析出来的子语句，由 execute 消息填充。
    implicit_results: Vec<CachedStatement>,
    /// 【NCForge 补丁六】已经解析过的 TTC 消息类型（只留最近 16 条）。
    ///
    /// 错位报错时把它带进错误消息：真的错位时，靠「解析到哪一类消息之后开始读错」
    /// 才能判断是行数据解码少读/多读字节，还是消息边界本身算错了。
    /// 现场只有一个 `unknown TTC message type 0 at packet 1, offset 2906` 没法定位。
    message_types: Vec<u8>,
}

impl Response {
    /// Resolves object types in the supplied statement and pending REF cursors.
    fn resolve_object_types(
        &mut self,
        client: &mut Client,
        client_ref: &ClientRef,
        statement: &mut CachedStatement,
    ) -> Result<(), Error> {
        let cursors =
            self.pending_values.iter_mut().filter_map(|value| match value {
                Some(PendingDbValue::Cursor(statement)) => Some(statement),
                _ => None,
            });
        for statement in std::iter::once(statement).chain(cursors) {
            for metadata in statement.out_metadata_mut() {
                metadata.resolve_object_type(|identity| {
                    client.get_type(client_ref, &identity.lookup_name())
                })?;
            }
        }
        Ok(())
    }

    /// Takes database error information associated with the response and
    /// transfers ownership of it to the caller.
    fn take_db_error(&mut self) -> Option<DbError> {
        self.error_info.as_mut().and_then(|i| i.take_db_error())
    }

    /// Adds packets to the response in preparation for an attempt at
    /// deserializing the database response. Prior to Oracle Database 26ai, the
    /// database does not give any indication of when the end of a response has
    /// been reached. The only way to know is by attempting to parse the
    /// response, and if during that attempt, the end of data is reached, more
    /// packets are clearly required for that response. Since the response
    /// contains state, that state must be reset so that it doesn't interfere
    /// with another attempt at deserializing the response.
    pub(crate) fn add_packets(&mut self, packets: Vec<Packet>) {
        self.packets.extend(packets);
        self.buf = ReadBuffer::from_packets(&self.packets);
        self.error_info = None;
        self.edition = None;
        self.current_schema = None;
        self.warning = None;
        self.rows = None;
        self.pending_values.clear();
        self.bit_vector = None;
        self.end_of_fetch = false;
        self.flush_out_binds = false;
        self.implicit_results.clear();
        self.message_types.clear();
    }

    /// 记录一条已经解析过的 TTC 消息类型（补丁六，只保留最近 16 条）。
    pub(crate) fn record_message_type(&mut self, message_type: u8) {
        if self.message_types.len() >= 16 {
            self.message_types.remove(0);
        }
        self.message_types.push(message_type);
    }

    /// Records one pending value position while deserializing rows.
    pub(crate) fn add_pending_db_value(
        &mut self,
        value: Option<PendingDbValue>,
    ) {
        self.pending_values.push(value);
    }

    pub(crate) fn advance(&mut self, cnt: usize) -> Result<(), Error> {
        self.buf.read_bytes(cnt)?;
        Ok(())
    }

    /// Returns the call status of the response.
    pub(crate) fn call_status(&self) -> u32 {
        self.call_status
    }

    /// Checks to see if any error has taken place and, if so, returns it.
    pub(crate) fn check_for_error(&mut self) -> Result<(), Error> {
        self.take_db_error().map_or(Ok(()), |e| Err(Error::db_error(e)))
    }

    /// Checks to see if any error has taken place after executing a statement
    /// or fetching rows from a cursor, and if so, returns it. The error "no
    /// data found" when found for a query is ignored and the end of fetch
    /// marker is set instead.
    pub(crate) fn check_for_statement_error(
        &mut self,
        client: &mut Client,
        statement: &mut CachedStatement,
    ) -> Result<(), Error> {
        if let Some(db_error) = self.take_db_error() {
            // 【NCForge 补丁三】查询遇到 ORA-01403（no data found）是正常的
            // 「没有更多行」信号，必须**先**返回，绝不能走下面的关闭游标分支。
            //
            // 上游顺序反过来：先 `should_close_cursor()`（01403 不在白名单里，
            // 返回 true）把游标塞进待关闭队列，再把错误当正常结束忽略。
            // 后果是 `select cursor(...)` 这类嵌套游标：describe 子游标时服务端
            // 会带一个 ORA-01403，父游标因此被标记关闭，下一次 piggyback
            // （TTC_RPC_CLOSE_CURSORS）就把父游标关掉，子游标随之失效，
            // 取子游标行时报 `ORA-01001: 无效的游标`。
            if statement.is_query()
                && db_error.code() == constants::DB_ERR_NUM_NO_DATA_FOUND
            {
                self.end_of_fetch = true;
                return Ok(());
            }
            if db_error.should_close_cursor() {
                client.close_cursor(statement);
            }
            Err(Error::db_error(db_error))
        } else {
            Ok(())
        }
    }

    /// Cleans up any pending values. This method is called when an error takes
    /// place during deserialization and the response cannot be returned for
    /// further processing.
    pub(crate) fn cleanup_pending_values(&mut self, client: &mut Client) {
        for value in self.pending_values.drain(..).flatten() {
            value.cleanup(client);
        }
    }

    /// Returns the current location in the response.
    pub(crate) fn current_location(&self) -> ResponseLocation {
        let mut packet_num = 1;
        let mut offset = self.buf.get_pos();
        for packet in &self.packets {
            if offset <= packet.buf.len() {
                offset += packet.header_size();
                break;
            }
            packet_num += 1;
            offset -= packet.buf.len();
        }
        ResponseLocation {
            packet_num,
            offset,
            recent: self.message_types.clone(),
        }
    }

    pub(crate) fn deserialize_bit_vector(&mut self) -> Result<(), Error> {
        let num_columns = self.read_ub2()? as usize;
        if self.num_columns == 0 {
            self.num_columns = num_columns;
        }
        let mut num_bytes = self.num_columns / 8;
        if !self.num_columns.is_multiple_of(8) {
            num_bytes += 1;
        }
        self.bit_vector = Some(self.buf.read_bytes(num_bytes)?.into());
        Ok(())
    }

    pub(crate) fn deserialize_row_data(
        &mut self,
        client: &Client,
        statement: &CachedStatement,
        in_fetch: bool,
    ) -> Result<(), Error> {
        let metadata = statement.out_metadata();
        let mut column_values: Vec<Option<DbValue>> =
            Vec::with_capacity(metadata.len());
        for (i, metadata) in statement.out_metadata().iter().enumerate() {
            let value = DbValue::from_response(
                self, client, statement, metadata, in_fetch, i,
            )?;
            column_values.push(value);
        }
        let db_row = DbRow::new(column_values);
        if let Some(rows) = self.rows.as_mut() {
            rows.push(db_row);
        } else {
            self.rows = Some(vec![db_row]);
        }
        Ok(())
    }

    /// Deserializes a server side piggyback. These contain data from the
    /// server on which the client may need to operate.
    pub(crate) fn deserialize_server_side_piggyback(
        &mut self,
    ) -> Result<(), Error> {
        let opcode = self.read_u8()?;
        match opcode {
            constants::TTC_SERVER_PIGGYBACK_LTXID => {
                let _ltxid = self.read_bytes_with_double_length()?;
            }
            constants::TTC_SERVER_PIGGYBACK_QUERY_CACHE_INVALIDATION
            | constants::TTC_SERVER_PIGGYBACK_TRACE_EVENT => {}
            constants::TTC_SERVER_PIGGYBACK_OS_PID_MTS => {
                let _ = self.read_ub2()?;
                let _ = self.read_bytes_with_length()?;
            }
            constants::TTC_SERVER_PIGGYBACK_SYNC => {
                let _num_dtys = self.read_ub2()?;
                let _dty_length = self.read_u8()?;
                let num_elements = self.read_ub2()?;
                let _len = self.read_u8()?;
                self.process_keyword_value_pairs(num_elements)?;
                let _overall_flags = self.read_ub4()?;
            }
            constants::TTC_SERVER_PIGGYBACK_EXT_SYNC => {
                let _num_dtys = self.read_ub2()?;
                let _dty_length = self.read_u8()?;
            }
            constants::TTC_SERVER_PIGGYBACK_AC_REPLAY_CONTEXT => {
                let _num_dtys = self.read_ub2()?;
                let _dty_length = self.read_u8()?;
                let _flags = self.read_ub4()?;
                let _error_code = self.read_ub4()?;
                let _queue = self.read_u8()?;
                let _replay_context = self.read_bytes_with_double_length()?;
            }
            constants::TTC_SERVER_PIGGYBACK_SESS_RET => {
                self.read_ub2()?;
                self.read_u8()?;
                let num_elements = self.read_ub2()?;
                if num_elements > 0 {
                    self.read_u8()?;
                    for _ in 0..num_elements {
                        if self.read_ub2()? > 0 {
                            let _key = self.read_bytes_with_length()?;
                        }
                        if self.read_ub2()? > 0 {
                            let _value = self.read_bytes_with_length()?;
                        }
                        let _session_flags = self.read_ub2()?;
                    }
                }
                let _flags = self.read_ub4()?;
                let _session_id = self.read_ub4()?;
                let _serial_num = self.read_ub2()?;
            }
            constants::TTC_SERVER_PIGGYBACK_SESS_SIGNATURE => {
                let _num_dtys = self.read_ub2()?;
                let _dty_length = self.read_u8()?;
                let _signature_flags = self.read_ub8()?;
                let _client_signature = self.read_ub8()?;
                let _server_signature = self.read_ub8()?;
            }
            _ => {
                return Err(Error::unknown_server_side_piggyback(opcode));
            }
        }
        Ok(())
    }

    /// Deserializes call status from the buffer.
    pub(crate) fn deserialize_status(&mut self) -> Result<(), Error> {
        self.call_status = self.read_ub4()?;
        let _seq_num = self.read_ub2()?;
        Ok(())
    }

    /// Deserializes a universal rowid from the buffer.
    pub(crate) fn deserialize_urowid(
        &mut self,
    ) -> Result<Option<String>, Error> {
        if self.read_bytes_with_length()?.is_empty() {
            Ok(None)
        } else {
            let mut buf =
                ReadBuffer::from_bytes(&self.read_bytes_with_length()?);
            if buf.read_u8()? == 1 {
                Ok(Some(Rowid::from_buf(&mut buf)?.to_string()))
            } else {
                Ok(Some(convert_logical_rowid(buf.read_remaining_bytes())))
            }
        }
    }

    pub(crate) fn deserialize_warning(&mut self) -> Result<(), Error> {
        let error_num = self.read_ub2()?;
        let num_bytes = self.read_ub2()?;
        let _flags = self.read_ub2()?;
        if error_num != 0 && num_bytes > 0 {
            let message = self.read_utf8_with_length()?;
            self.warning = Some(message.trim_end().to_string());
        }
        Ok(())
    }

    /// Attaches resolved object metadata and finalizes LOB and cursor handles.
    pub(crate) fn complete_values(
        &mut self,
        client: &mut Client,
        client_ref: &ClientRef,
        statement: &mut CachedStatement,
    ) -> Result<(), Error> {
        self.resolve_object_types(client, client_ref, statement)
            .and_then(|_| {
                self.finalize_rows(
                    client,
                    client_ref,
                    statement.out_metadata(),
                )
            })
            .inspect_err(|_| self.cleanup_pending_values(client))
    }

    /// Finalizes pending objects, LOBs and cursors after type discovery.
    fn finalize_rows(
        &mut self,
        client: &Client,
        client_ref: &ClientRef,
        metadata: &[Metadata],
    ) -> Result<(), Error> {
        let values = std::mem::take(&mut self.pending_values);
        if !values.is_empty() {
            let column_nums: Vec<usize> = metadata
                .iter()
                .enumerate()
                .filter_map(|(column_num, metadata)| {
                    metadata.should_defer_value().then_some(column_num)
                })
                .collect();
            let mut values = values.into_iter();
            for row in self.rows.as_mut().unwrap() {
                for column_num in &column_nums {
                    if let Some(data) = values.next().unwrap() {
                        row.finalize_column(
                            *column_num,
                            client,
                            client_ref,
                            data,
                            &metadata[*column_num],
                        )?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Returns the cursor id returned by the error response.
    pub(crate) fn get_cursor_id(&self) -> u16 {
        self.error_info.as_ref().map(|i| i.cursor_id()).unwrap_or(0)
    }

    /// Returns whether or not the response requires out binds to be flushed.
    pub(crate) fn get_flush_out_binds(&self) -> bool {
        self.flush_out_binds
    }

    /// Returns the last row that was fetched.
    pub(crate) fn get_last_row_fetched(&self) -> &DbRow {
        if let Some(rows) = self.rows.as_ref() {
            rows.last().unwrap()
        } else {
            self.prev_fetch_last_row.as_ref().unwrap()
        }
    }

    /// Returns the packet flags of the first packet of the response.
    pub(crate) fn get_packet_flags(&self) -> u8 {
        self.packets.first().unwrap().packet_flags
    }

    /// Returns the packet type of the first packet of the response.
    pub(crate) fn get_packet_type(&self) -> u8 {
        self.packets.first().unwrap().packet_type
    }

    /// Returns the rowcount returned by the database.
    pub(crate) fn get_rowcount(&self) -> u64 {
        self.error_info.as_ref().map(|i| i.rowcount()).unwrap_or(0)
    }

    pub(crate) fn is_duplicate_data(&self, column_num: usize) -> bool {
        if let Some(bit_vector) = self.bit_vector.as_ref() {
            let byte_num = column_num / 8;
            let bit_num = column_num % 8;
            bit_vector[byte_num] & (1 << bit_num) == 0
        } else {
            false
        }
    }

    pub(crate) fn is_end_of_fetch(&self) -> bool {
        self.end_of_fetch
    }

    pub(crate) fn new() -> Response {
        Response {
            packets: Vec::new(),
            buf: ReadBuffer::from_packets(&[]),
            error_info: None,
            edition: None,
            current_schema: None,
            warning: None,
            rows: None,
            pending_values: Vec::new(),
            prev_fetch_last_row: None,
            bit_vector: None,
            num_columns: 0,
            call_status: 0,
            end_of_fetch: false,
            flush_out_binds: false,
            implicit_results: Vec::new(),
            message_types: Vec::new(),
        }
    }

    pub(crate) fn process_keyword_value_pairs(
        &mut self,
        num_pairs: u16,
    ) -> Result<(), Error> {
        for _ in 0..num_pairs {
            let text_value = self.read_utf8_with_double_length()?.to_string();
            let _binary_value = self.read_bytes_with_double_length()?;
            let keyword_num = self.read_ub2()?;
            match keyword_num {
                constants::TTC_KEYWORD_NUM_CURRENT_SCHEMA => {
                    self.current_schema = Some(text_value);
                }
                constants::TTC_KEYWORD_NUM_EDITION => {
                    self.edition = Some(text_value);
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub(crate) fn read_bit_vector(&mut self) -> Result<(), Error> {
        let num_bytes = self.read_ub4()?;
        if num_bytes == 0 {
            self.bit_vector = None;
        } else {
            let bit_vector = self.read_bytes_with_length()?;
            self.bit_vector = Some(bit_vector.into());
        }
        Ok(())
    }

    pub(crate) fn read_bytes(
        &mut self,
        num_bytes: usize,
    ) -> Result<&[u8], Error> {
        self.buf.read_bytes(num_bytes)
    }

    pub(crate) fn read_bytes_with_length(
        &mut self,
    ) -> Result<Cow<'_, [u8]>, Error> {
        self.buf.read_bytes_with_length()
    }

    pub(crate) fn read_bytes_with_double_length(
        &mut self,
    ) -> Result<Cow<'_, [u8]>, Error> {
        self.buf.read_bytes_with_double_length()
    }

    pub(crate) fn read_error_info(
        &mut self,
        client: &Client,
    ) -> Result<(), Error> {
        let error_info = ErrorInfo::deserialize(self, client)?;
        if error_info.is_compilation_warning() {
            self.warning =
                Some("creation succeeded with compilation errors".to_string());
        }
        self.error_info = Some(error_info);
        Ok(())
    }

    pub(crate) fn read_i8(&mut self) -> Result<i8, Error> {
        self.buf.read_i8()
    }

    pub(crate) fn read_short_length(&mut self) -> Result<u8, Error> {
        self.buf.read_short_length()
    }

    /// Called when a value is being read from the buffer. The value is assumed
    /// to contain a simple set of encoded bytes which can be transformed into
    /// the target type without error.
    pub(crate) fn read_value<T>(&mut self) -> Result<Option<T>, Error>
    where
        T: FromBuf,
    {
        self.buf.read_value::<T>()
    }

    /// Called when a value is being read from a value-based LOB. The value is
    /// assumed to contain a complex set of encoded bytes which will need to be
    /// decoded in a fallible fashion.
    pub(crate) fn read_value_lob<T>(&mut self) -> Result<Option<T>, Error>
    where
        T: FromBufFallible,
    {
        self.buf.read_value_lob::<T>()
    }

    pub(crate) fn read_sb4(&mut self) -> Result<i32, Error> {
        self.buf.read_sb4()
    }

    pub(crate) fn read_sb8(&mut self) -> Result<i64, Error> {
        self.buf.read_sb8()
    }

    pub(crate) fn read_ub2(&mut self) -> Result<u16, Error> {
        self.buf.read_ub2()
    }

    pub(crate) fn read_ub4(&mut self) -> Result<u32, Error> {
        self.buf.read_ub4()
    }

    pub(crate) fn read_ub8(&mut self) -> Result<u64, Error> {
        self.buf.read_ub8()
    }

    pub(crate) fn read_u8(&mut self) -> Result<u8, Error> {
        self.buf.read_u8()
    }

    pub(crate) fn read_u16be(&mut self) -> Result<u16, Error> {
        self.buf.read_u16be()
    }

    pub(crate) fn read_u16le(&mut self) -> Result<u16, Error> {
        self.buf.read_u16le()
    }

    pub(crate) fn read_u32be(&mut self) -> Result<u32, Error> {
        self.buf.read_u32be()
    }

    /// Reads the specified number of bytes from the buffer which are assumed
    /// to be valid UTF-8 encoded bytes, and returns a string reference.
    pub(crate) fn read_utf8(
        &mut self,
        num_bytes: usize,
    ) -> Result<&str, Error> {
        self.buf.read_utf8(num_bytes)
    }

    /// Reads an encoded unsigned integer from the buffer followed by
    /// length-encoded bytes which are assumed to be valid UTF-8 encoded bytes.
    /// An error is returned if either the integer or the bytes cannot be read
    /// from the buffer.
    pub(crate) fn read_utf8_with_double_length(
        &mut self,
    ) -> Result<Cow<'_, str>, Error> {
        self.buf.read_utf8_with_double_length()
    }

    /// Reads length encoded bytes which are assumed to be valid UTF-8 encoded
    /// bytes. An error is returned if such a string cannot be read from the
    /// buffer.
    pub(crate) fn read_utf8_with_length(
        &mut self,
    ) -> Result<Cow<'_, str>, Error> {
        self.buf.read_utf8_with_length()
    }

    /// Specifies that the response requires out binds to be flushed. The
    /// packet data is cleared as well since the real response comes after the
    /// flush out binds packet is sent!
    pub(crate) fn set_flush_out_binds(&mut self) {
        self.flush_out_binds = true;
        self.packets.clear();
    }

    pub(crate) fn set_prev_fetch_last_row(&mut self, last_row: Option<DbRow>) {
        self.prev_fetch_last_row = last_row;
    }

    pub(crate) fn set_num_columns(&mut self, num_columns: usize) {
        self.num_columns = num_columns;
    }

    /// Records the statements parsed out of an implicit resultset message.
    pub(crate) fn set_implicit_results(
        &mut self,
        statements: Vec<CachedStatement>,
    ) {
        self.implicit_results = statements;
    }

    /// Takes the implicit resultset statements out of the response.
    pub(crate) fn take_implicit_results(&mut self) -> Vec<CachedStatement> {
        std::mem::take(&mut self.implicit_results)
    }

    /// Takes the rows from the response and returns them.
    pub(crate) fn take_rows(&mut self) -> Option<Vec<DbRow>> {
        self.rows.take()
    }

    /// Takes the warning from the response and returns them.
    pub(crate) fn take_warning(&mut self) -> Option<String> {
        self.warning.take()
    }

    /// Transfers information from another response that was received earlier.
    /// Preserves row and pending-value order when combining executions or fetches.
    pub(crate) fn transfer_info(&mut self, other_resp: &mut Response) {
        if self.rows.is_none() {
            self.rows = other_resp.take_rows();
        } else if let Some(mut other_rows) = other_resp.take_rows() {
            let mut final_rows = self.rows.take().unwrap();
            other_rows.append(&mut final_rows);
            self.rows = Some(other_rows);
        }
        let mut pending_values =
            std::mem::take(&mut other_resp.pending_values);
        pending_values.append(&mut self.pending_values);
        self.pending_values = pending_values;
        if let Some(error_info) = self.error_info.as_mut()
            && let Some(other_error_info) = other_resp.error_info.as_mut()
        {
            error_info.transfer_into(other_error_info);
        }
    }

    /// Returns an error indicating that an unknown TTC message type was
    /// encountered. It first calculates the packet number and offset into the
    /// packet to aid in debugging.
    pub(crate) fn unknown_ttc_message_type(&self, message_type: u8) -> Error {
        Error::unknown_ttc_message_type(message_type, self.current_location())
    }
}

#[derive(Debug, PartialEq)]
pub struct ResponseLocation {
    packet_num: usize,
    offset: usize,
    /// 出错前刚解析过的 TTC 消息类型（补丁六）。空 = 还没解析过任何消息。
    recent: Vec<u8>,
}

impl std::fmt::Display for ResponseLocation {
    fn fmt(&self, fmt: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(fmt, "packet {}, offset {}", self.packet_num, self.offset)?;
        if !self.recent.is_empty() {
            let names: Vec<String> = self
                .recent
                .iter()
                .map(|t| format!("{t}/{}", ttc_message_name(*t)))
                .collect();
            write!(fmt, "；已解析消息 {}", names.join(","))?;
        }
        Ok(())
    }
}

/// 把 TTC 消息类型翻成名字，只用于错位报错，认不出的直接写数字。
fn ttc_message_name(message_type: u8) -> &'static str {
    match message_type {
        constants::TTC_MSG_TYPE_PROTOCOL => "协议",
        constants::TTC_MSG_TYPE_DATA_TYPES => "数据类型",
        constants::TTC_MSG_TYPE_FUNCTION => "执行",
        constants::TTC_MSG_TYPE_ERROR => "错误",
        constants::TTC_MSG_TYPE_ROW_HEADER => "行头",
        constants::TTC_MSG_TYPE_ROW_DATA => "行",
        constants::TTC_MSG_TYPE_PARAMETER => "返回参数",
        constants::TTC_MSG_TYPE_STATUS => "状态",
        constants::TTC_MSG_TYPE_IO_VECTOR => "IO",
        constants::TTC_MSG_TYPE_LOB_DATA => "LOB",
        constants::TTC_MSG_TYPE_WARNING => "警告",
        constants::TTC_MSG_TYPE_DESCRIBE_INFO => "列信息",
        constants::TTC_MSG_TYPE_PIGGYBACK => "piggyback",
        constants::TTC_MSG_TYPE_FLUSH_OUT_BINDS => "flush",
        constants::TTC_MSG_TYPE_BIT_VECTOR => "空值位图",
        constants::TTC_MSG_TYPE_SERVER_SIDE_PIGGYBACK => "服务端piggyback",
        constants::TTC_MSG_TYPE_IMPLICIT_RESULTSET => "隐式结果集",
        constants::TTC_MSG_TYPE_END_OF_RESPONSE => "响应结束",
        _ => "?",
    }
}
