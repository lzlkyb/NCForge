//! 壳子 crate 根。业务模块在此声明（与 commands/ 的子模块一一对应）。
//!
//! 现有模块即壳子全部家当：
//! - `branding`：显示名单一来源
//! - `commands`：IPC 命令层（聚合，实现在 commands/ 子模块）
//! - `config` / `state`：配置与托管状态
//! - `security`：安全原语（路径白名单）
//!
//! 加业务模块时在此 `pub mod xxx;`，实现放 `src/xxx.rs`（关注点够大就开目录），
//! 命令层在 `src/commands/xxx_cmds.rs`，在 `commands/mod.rs` 声明 + `pub use`，
//! 最后在 `main.rs` 的 `invoke_handler!` 注册。四处，缺一不可。

pub mod branding;
pub mod commands;
pub mod compile;
pub mod config;
pub mod db_bridge;
pub mod db_schema;
pub mod encoding_reg;
pub mod java_bridge;
pub mod lang;
pub mod launch;
pub mod lsp;
pub mod nc_home;
pub mod nc_index;
pub mod nc_port;
pub mod patch_build;
pub mod patch_view;
pub mod search;
pub mod security;
pub mod server;
pub mod shadow;
pub mod sql_refs;
pub mod state;
pub mod svn_bridge;
pub mod svn_cred;
pub mod svn_review;
pub mod svn_view;
pub mod workspace;

// main.rs 用 `use nc_forge::*;` 一把引入；AppState 是最常被引用的托管状态，
// 在根上再导出，避免 main.rs 里写 `use nc_forge::state::AppState` 的长路径。
pub use state::AppState;
