# vendored `oracledb`（Oracle 官方纯 Rust 驱动）

这里是 [`oracledb` 26.0.0-beta.5](https://github.com/oracle/rust-oracledb) 的源码副本，
上游有五处硬伤挡住我们用它做数据库引擎，所以打了补丁。`desktop/src-tauri/Cargo.toml`
用 `[patch.crates.io]` 把这份副本挂上去（版本号不变，所以依赖里写的
`oracledb = "=26.0.0-beta.5"` 会自动用到这里）。

升级驱动时：把新版本的 crate 源码整个覆盖进来，然后**重新应用下面五组补丁**，
再跑一遍本文件末尾的验证。

## 补丁一：11G 密码验证器（对应上游 issue #63）

**症状**：账号只有 11G 验证器时（12.1.0.1 的默认、以及从 11g 迁移过来的 19c 账号很常见），
驱动在 `AUTH_PBKDF2_VGEN_COUNT` 那句 `.unwrap()` 上直接 panic —— 整个进程退出。

**根因**：`AuthMessage::deserialize_return_parameters` 把每个参数的 `flags` 读出来就丢了
（`resp.read_ub4()?; // flags`），于是驱动不知道服务器要求哪种验证器，一律按 12C 算。
而 `constants.rs` 里 `_VERIFIER_TYPE_11G_1 / 11G_2 / 12C` 三个常量早就定义好了没人用。

**改法**（`src/messages/auth.rs`）：

- `AUTH_VFR_DATA` 的 flags 存进 `AuthMessage::verifier_type`。
- `generate_verifier` 分两支（算法与 [python-oracledb](https://github.com/oracle/python-oracledb)
  的 thin 实现逐行对应，见其 `impl/thin/messages/auth.pyx` 的 `_generate_verifier`）：

  | | 12C | 11G_1 / 11G_2 |
  |---|---|---|
  | 口令哈希 | PBKDF2-SHA512(`pw`, vfr‖`AUTH_PBKDF2_SPEEDY_KEY`, `AUTH_PBKDF2_VGEN_COUNT`) → SHA512 → 前 32 字节 | `SHA1(pw‖vfr)` 后补 4 个 `0x00`，共 24 字节 |
  | AES 密钥长度 | 256 | **192** |
  | 会话密钥（48 字节时） | — | `md5(b[0..16]) ‖ md5(b[16..32])` 截到 24 字节，`b[i] = part_a[16+i] ^ part_b[i]` |
  | speedy key | 要发 | 不发 |

- `decrypt_cbc` / `encrypt_cbc` 按密钥长度分派 AES-128/192/256（上游写死 256）。
- 未知验证器类型 → `Error::UnsupportedVerifierType`；认证参数缺失/格式坏 →
  `Error::InvalidAuthParameter`。**不再 unwrap**。
- 为此把 `Message::pre_process` 的返回值从 `()` 改成 `Result<(), Error>`
  （只有 3 处实现，改动很小）。

## 补丁二：语句中断 / 取消（对应上游 issue #24）

**症状**：没有 `cancel`/`break` API。一次 round-trip 里 `Client` 被 `Mutex` 锁住、
socket 读是阻塞的，别的线程没有任何插入点 —— 长查询只能干等超时或杀掉整个应用。

**改法**（新增 `src/break_handle.rs`，改 `transport.rs` / `client/mod.rs` / `connection/*`）：

1. `BreakHandle`（`Send + Sync`，可跨线程）：`interrupt()` 只置一个原子位，**不拿锁、不碰 socket**。
   语义等同 JDBC 的 `Statement.cancel()`。
2. `Transport` 把阻塞读切成 ≤100ms 的片（`read_packet_sliced`），每片醒来检查一次中断请求；
   调用方设的 `call_timeout` 仍然按总时长生效。
3. 读到中断请求时**不在传输层发协议包**，而是返回 `CallTimeoutExceeded`，由既有的
   `Client::recover_from_error` 在持锁线程里发 `MARKER_TYPE_INTERRUPT` 再 `reset()`。
   这样 socket 的写永远只发生在拥有它的线程上。
4. 每次 `perform_round_trip` 开始时清一次中断位，避免「上一次查询的取消」误伤下一条语句。
5. 对外入口：`Connection::break_handle() -> Result<BreakHandle, Error>`。

真库实测（19c，2026-10-31 探针 `tests/db_break_probe.rs` + python-oracledb thin 26.1.0 对照）：

| 语句 | 中断时点 | 返回 |
|---|---|---|
| CPU 长查询（`connect by` 3000 万行，不取消要跑 ~4.4s） | 1s | **1182ms**（取消延迟 ≈182ms = ≤100ms 切片 + ~80ms 服务端） |
| `dbms_lock.sleep(30)` | 1s | 3021ms |
| `dbms_lock.sleep(20)` | 50ms ~ 1500ms 任意时点 | 恒定 ~3.01s |
| `dbms_lock.sleep(20)` | 3.1s / 4.5s / 5.5s | 恒定 ~6.01s |
| 行锁等待（`for update` 等别的事务） | 1s / 4s | 3009ms / 6017ms |
| `dbms_lock.sleep(6)` 不中断 | — | 6019ms **成功**（客户端无幻影读超时） |

两条结论：

1. **计算类语句取消 ~0.2s 生效**，与上游 python-oracledb thin 26.1.0 同场景（cancel→报错
   76ms）同量级，切片轮询只贡献 ≤100ms。
2. **等待类语句（sleep / 行锁）受服务端 ~3s 块边界支配**：边界在 3s/6s/9s…，与中断请求
   时点无关。python-oracledb thin（含 OOB urgent data 通道）在 19c 上完全一样
   （cancel@1s → 2022ms 后报 ORA-01013）⇒ **19c 服务端行为，不是本补丁的问题**。
   中断后同一连接 `select 1 from dual` 正常 —— 连接没有被弄死。

> ⚠️ 2026-10-30 首轮记录的「约 2.0 秒取消生效」**作废**：那是 interrupt 在 ~1s 时发起、
> 恰被 3s 块边界接收的假象（1s + 2s = 整句 3.0s 返回）。取消延迟的真实数据见上表。
>
> 另注：本驱动把「中断」与「真超时」统一报成 `CallTimeoutExceeded`（服务端的 ORA-01013
> 在 `reset()` 时被丢弃，python 能拿到）。引擎层 `db_rust.rs` 的 `drv_err` 已用中性文案
> 「语句已中断（点了停止，或等待超过超时时间）。会话仍然可用」覆盖，用户无感知。

## 补丁三：嵌套游标（REF CURSOR 列）取行报 ORA-01001

**症状**：`select cursor(select …) from dual` 能查到行、游标列的列名也对，
但一取子游标的数据就 `ORA-01001: 无效的游标`。同一条语句在 python-oracledb thin
上正常（`[(100,)]`）—— 是驱动自身问题，不是服务端语义限制。

**根因**：`Response::check_for_statement_error`（`src/response/mod.rs`）的判断顺序反了。

```rust
// 上游原写法
if let Some(db_error) = self.take_db_error() {
    if db_error.should_close_cursor() {          // ← 01403 不在白名单里，返回 true
        client.close_cursor(statement);          //   父游标被塞进待关闭队列
    }
    if statement.is_query()
        && db_error.code() == DB_ERR_NUM_NO_DATA_FOUND
    { self.end_of_fetch = true; Ok(()) }         // ← 到这里才当「正常结束」忽略
```

嵌套游标的 describe 阶段，服务端会随响应带一个 **ORA-01403（no data found）**。
`should_close_cursor()` 的白名单只管数据完整性错误，01403 落进「该关游标」一侧，
于是父游标先被登记关闭；下一次 piggyback（`TTC_RPC_CLOSE_CURSORS`）把它发出去，
**父游标一关，子游标跟着失效**，再拿子游标的 cursor id 去 fetch 就是 ORA-01001。

抓包证据（`PYO_DEBUG_PACKETS=1` 的 python-oracledb 与我们的消息体逐字节对比）：
取子游标行时两边发出的字节除 seq 号外**完全一致**（同样的 `TTC_RPC_EXECUTE`/FETCH
选项、同样的 cursor id 位置），唯一区别是我们多带了一个 `TTC_RPC_CLOSE_CURSORS`
piggyback，里面关的正是父游标。

**改法**：把 01403 的判断提到关闭逻辑**之前**，命中就直接 `end_of_fetch = true` 返回。
（查询遇到 no data found 本来就是「没有更多行」，不该关游标。）

**这不是「REF CURSOR 需要特殊消息」**——本次专门验证过：`TTC_RPC_FETCH` 本身对
嵌套游标完全可用；修好父游标误关之后，原来的 fetch 路径一行不用改就能取到行。
（python thin 之所以全走 EXECUTE，是因为它压根没实现 FETCH 这条 RPC。）

真库验证（19c）：

| 探针 | 修复前 | 修复后 |
|---|---|---|
| `db_refcursor_probe` R6：`select cursor(select 100 from dual) c, 42 n, 'abc' s from dual` | 列名对、普通列对，子游标取行 `ORA-01001` | 子游标 `["Z"]`，**取到 `子游标行 = 100`** |
| 同套件 R7：普通游标 500 行分页 fetch | 500 行正常 | 500 行正常（无回归） |

## 补丁四：隐式结果集（TTC 27 号消息）完全没人解析

**症状**：PL/SQL 里 `dbms_sql.return_result(rc)` 一执行，驱动报
`UnknownTtcMessageType(27) at packet 1, offset 11`。查询结果集根本到不了调用方。

**根因**：服务端确实按协议下发了 27 号消息，但客户端的分发表（`messages/mod.rs`
的 `deserialize_ttc_message`）只认 1/2/3/4/6/7/8/9/11/14/15/16/17/19/21/23/29/34，
27 号落进 `_ =>` 分支。`constants.rs` 里 `_TTC_MSG_TYPE_IMPLICIT_RESULTSET` 带下划线，
说明上游知道这一号但**从没接线**；`execute.rs` 甚至已经置了
`TTC_EXEC_FLAGS_IMPLICIT_RESULTSET` 让服务端发，属于「发了但收不了」。

**消息布局**（三方一致，可直接照写）：

```text
ub4   结果集个数
每个结果集:
  ub1  sql_len
  sql_len 字节        // ref cursor 的 SQL 文本，跳过
  describe 正文       // 从 ub4 max_row_size 开始，与 DESCRIBE_INFO 同一套解析
  ub2  cursor_id
```

出处：python-oracledb thin 26.1.0 `impl/thin/messages/base.pyx::_process_implicit_result`；
`MuhDur/rust-oracledb` `crates/oracledb-protocol/src/thin/fetch.rs`（注释直指 base.pyx）。

⚠️ **`from_cursor_response` 不能直接复用**：它读 1 个字节后直接进 describe —— 那是
**嵌套游标列**的形态（`base.pyx` 里写的是 `skip_ub1() # length (fixed value)`，那个字节
不代表长度）。27 号消息的长度字段是真长度，后面跟 N 字节 SQL 文本，少跳就整体错位。

**改法**：

| 文件 | 改动 |
|---|---|
| `src/constants.rs` | `_TTC_MSG_TYPE_IMPLICIT_RESULTSET` → `TTC_MSG_TYPE_IMPLICIT_RESULTSET`（去掉下划线） |
| `src/messages/mod.rs` | trait 加 `deserialize_implicit_result`（默认 `not_implemented`，与上游风格一致）+ 分发分支 |
| `src/statement/mod.rs` | 新增 `from_implicit_result_response`：`ub1 长度` → `advance(N)` → describe → `ub2 cursor_id`；`is_nested = false`（这些是真实游标，用完要能关） |
| `src/messages/execute.rs` | 字段 `implicit_results: Vec<CachedStatement>` + 实现该 trait 方法 |
| `src/response/mod.rs` | 字段 `implicit_results` 做中转，`add_packets`（重试时）清空 |
| `src/client/mod.rs` | `execute` 拿到响应后把 message 里的结果集搬进 response |
| `src/exec_result.rs` | 对外 `implicit_resultsets() -> Vec<Cursor>`；`Drop` 把没被取走的子语句还给服务端 |

**`Drop` 那一条是必需的，不是保险**：`CachedStatement` 本身没有 Drop（只有公开的
`Statement` 才负责归还），裸的 `CachedStatement` 被丢掉就等于把服务端游标漏在会话里。
实测把归还关掉后，连续执行 `return_result` 第 **298** 次即 `ORA-01000: 超出打开游标
的最大数`（`open_cursors` 默认 300）。探针 R11 就是盯这个的。

真库验证（19c）：

| 探针 | 修复前 | 修复后 |
|---|---|---|
| R2 / R3：`return_result` 1 个 / 2 个结果集 | `UnknownTtcMessageType(27)` | 执行成功（结果集走 R8/R9） |
| R8：1 个结果集 2 列 | 同上 | 结果集 1 个，列 `["A","B"]`，行 `(111, "abc")` |
| R9：2 个结果集顺序 | 同上 | `[["N"]=["1"], ["S"]=["x"]]` 顺序正确 |
| R10：0 行结果集 | 同上 | 列名完整（2 列）、0 行、会话正常 |
| R11：连跑 400 次不看结果集 | — | 无 `ORA-01000`（关掉 Drop 归还后第 298 次就炸，反向验证过） |

**已知限制**：隐式结果集的子语句没有走 `Response::resolve_object_types`，
所以列里含用户自定义对象类型时取值会失败（普通标量/LOB/日期都没问题）。
真遇到再补，注意要同时处理 `pending_values` 与 `implicit_results` 两处。

## 补丁五：语句缓存把未关闭的游标一起存回，同 SQL 重执行必炸连接

**症状**：对一张大表执行 `select * from T`（只取一页，游标留在引擎里），**再执行同一条 SQL**
立刻报 `internal error: unknown TTC message type 32 at packet 1, offset …`，并且这条连接
从此永久错位 —— 之后每条语句都炸。界面上表现为「刚打开一张表几秒就提示数据库会话已断开」。
换成**另一条** SQL 就完全正常。

**根因**（`src/statement/cache.rs`）：

1. `return_statement` 把语句还回缓存时直接 `info.clone()` 存回 slot —— `clone` 连同
   `cursor_id` 一起复制，既没把游标记进 `cursors_to_close` 让服务端关掉，也没清 id。
2. 下次命中这个 slot 时，`get_statement_from_entry` 又用
   `cached_info.clone_with_options(options)` 把那个**旧 cursor_id 带出去**
   （`clone_with_options` 就是 `self.clone()` 再换 options）。
3. 驱动看到 `cursor_id != 0`，按「游标还活着」处理，走 `TTC_RPC_REEXECUTE_AND_FETCH`；
   而服务端那边游标早已和客户端缓冲对不上，于是把预取的行包当消息头读 → TTC 错位。

不同 SQL 撞不到这个 slot，所以只有「同一条 SQL 重执行」复现 —— 这也解释了为什么
「翻页、换成另一条查询都好好的」。

**改法**：

- `return_statement`：归还前把 `stored` 里挂着的游标 push 进 `cursors_to_close`
  并 `clear_cursor()`，再存回 slot。
- `get_statement_from_entry`：`clone_with_options` 之后**一律**先
  `close_cursor(&info)` + `info.clear_cursor()`（顺手把原来只在部分分支才 `clear_cursor`
  的写法统一掉）。这样即使 slot 上还挂着活游标（同一个 `Cursor` 还没 Drop），
  复用它之前也一定先把旧游标关掉。

**回归**：`tests/db_rust_live.rs::表页大结果集留游标后重查同一_sql_不能打坏连接`。
注意必须用**行宽大**的真实表（`uapbd_log_h`，62 列）；窄表单列
（`select level from dual connect by level <= 50000`）即使取 201 行也会被驱动一次取完，
流上不留残余，测不出来 —— 这一点踩过，别再用它写回归。

## 补丁六：TTC 错位不再等于「会话已死」，可以对齐后续用

**症状**：报 `internal error: unknown TTC message type 0 at packet 1, offset 2906`
（类型和偏移每次不同）。界面上红条写「数据库会话已断开，执行或事务结果需核对」，
之后这条连接上任何语句都继续报同类错误，只能重连。

**为什么以前只能重连**：`unknown_ttc_message_type` 意味着流里的字节已经没法按消息
边界拆开了 —— `receive_response` 的「包不够就再收」补不回来（它不是 `out_of_data`）。
上层 `db_engine::connection_lost()` 把这条消息归进「会话丢失」，`state.lost` 一置位，
后续所有命令直接被挡。

**改法**：分两件事。

1. **能对齐**：新增 `Client::resync()`（`Connection::resync()` 对外）。
   发 `MARKER_TYPE_RESET`，然后把服务端回的东西读干净。
   🔴 只读到重置标记就停是不行的——**服务端在标记后面还会补一个被中止操作的错误响应**
   （实测 `ORA-01013: 用户请求取消当前的操作`）。只读到标记就停，那个包会留给下一条
   语句：下一条先报 01013，然后因为这次又错位一次而彻底乱掉。
   残留量不确定，所以用「读到短超时（1.5s）为止」收尾，读完恢复原来的读超时。
2. **分语义恢复**（`db_rust.rs`）：
   - 查询：`resync()` 之后**重发一次**。只读语句重发没有副作用。
   - 写入：**绝不重发**（服务端可能已经执行完，只是响应没解析出来）。只对齐，
     然后返回 `session-desync`，文案明确说「结果未确认，写入可能已生效，请到库里核对」。
   - `more()`（加载更多）：游标跟着错位流一起作废，对齐后提示重新执行查询。
   - `db_engine::record_loss` 对 `session-desync` 直接放行：会话还能用，不该标成
     「已断开」，也不该让用户重连。
3. **能定位**：`Response` 记录最近 16 条已解析的 TTC 消息类型，错位时拼进错误消息
   （`packet 1, offset 2906；已解析消息 16/列信息,6/行头,7/行,7/行,…`）。
   只有偏移量的时候，没法判断是某列解码少读/多读字节，还是消息边界本身算错了。

**回归**：`tests/db_rust_live.rs::流错位对齐之后会话仍然可用` —— 游标没取完时
`resync` 之后仍能 probe、仍能重查同一条 SQL（这条用例在补丁六之前根本无法编译，
`resync` 命令不存在；对齐只读到标记的写法会红在 ORA-01013 上）。

## 补丁七：对齐之后要作废语句缓存，否则同一条 SQL 会再错一次

**症状**：补丁六之后，错位能自动恢复了，但「过一会儿又报同一个错」——尤其是恢复后
第一条语句恰好是刚才那条 SQL 的时候。

**原因**：`resync()` 只把**字节流**拉回消息边界，`StatementCache` 里的 slot 还是坏的。
slot 里留着上一次半途而废的 `cursor_id`（服务端那边已经随 RESET 作废）和可能过期的
describe info（列定义）。同一条 SQL 再次命中缓存时，驱动的重执行路径会照着这份坏状态
再组织一次请求，于是又错在同一个位置。

**改法**：新增 `StatementCache::clear()`（清 `cached_statements`、`slots_by_name`、
`free_used_slots`，`empty_slots` 复位成 `1..=max_size`），在 `Client::resync()` 末尾
无条件调用。`cursors_to_close` 一并清掉——流刚被 RESET，那些 id 在服务端已经没有意义，
再用它们发 piggyback 关闭请求只会引出新的错位。

代价只有「下一条语句重新 parse 一次」；错位本来就在异常路径上，不在热路径。
语义与 python-oracledb 的 `clear()`（会话状态变了，缓存不能跨着用）一致。

**回归**：同一条用例覆盖——恢复后重查同一条 SQL 必须一次成功；补丁六的写法在这里会
先把坏 slot 重放一遍，再错位一次。

## 其它小改动

- `Cargo.toml` 加 `sha1`、`md-5` 两个依赖（11G 算法要 SHA1 与 MD5，都是纯 Rust 实现）。
- 删掉 `tests/`、`examples/`（上游的集成测试要真库与 rstest），保留 `doc/`
  —— `src/lib.rs` 里有 `include_str!("../doc/…")`，删了编不过。

## 验证

```bash
# 1. 本目录下的单测（AES-192 与 JCE 的交叉校验、MD5、中断状态机）
cd desktop/vendor/oracledb && cargo test --lib

# 2. 真库：connect / exec / 事务 / 元数据全量（含 12C 认证回归）
cd desktop/src-tauri && \
  NC_HOME=d:/ncc/1909home NC_DB_DS=design \
  cargo test --test db_rust_live -- --ignored --nocapture

# 3. 真库：中途取消
  cargo test --test db_rust_live 纯rust引擎能在语句执行中途取消 -- --ignored --nocapture
```

⚠️ **11G 验证器那段没有真机验证**：本机只有 19c，建不出「只有 11G 验证器」的账号。
它的正确性靠三点保证：算法与 python-oracledb thin 逐行对照、AES-192/MD5 有 JCE 参考向量
单测、代码路径有错误兜底（最坏情况是报错而不是崩进程）。真机表现等 11g 环境验收。
