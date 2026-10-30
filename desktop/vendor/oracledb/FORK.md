# vendored `oracledb`（Oracle 官方纯 Rust 驱动）

这里是 [`oracledb` 26.0.0-beta.5](https://github.com/oracle/rust-oracledb) 的源码副本，
上游有两处硬伤挡住我们用它做数据库引擎，所以打了补丁。`desktop/src-tauri/Cargo.toml`
用 `[patch.crates.io]` 把这份副本挂上去（版本号不变，所以依赖里写的
`oracledb = "=26.0.0-beta.5"` 会自动用到这里）。

升级驱动时：把新版本的 crate 源码整个覆盖进来，然后**重新应用下面两组补丁**，
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

真库实测（19c，2026-10-30）：`begin dbms_lock.sleep(30); end;` 执行中调用
`interrupt()`，约 **2.0 秒**后语句以错误返回（整条语句 3.0 秒结束），随后同一连接
`select 1 from dual` 正常 —— 连接没有被弄死。

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
