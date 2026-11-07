//! 前端 → 后端的 Tauri IPC 命令层。**本文件只做聚合，不含任何实现。**
//!
//! 组织范式（承自 cc-bridge，可直接照用）：
//! - 每个关注点一个子模块 `xxx.rs` 或 `xxx_cmds.rs`（后者用于与 crate 根下同名
//!   实现模块冲突时，如 `backup` vs `backup_cmds`）。
//! - 本文件 `mod` + `pub use` 重导出，`main.rs` 的 `invoke_handler![...]` 列
//!   `commands::xxx` 即可——拆分命令层是内部结构调整，调用方零改动。
//! - 新增命令：在子模块写 `#[tauri::command]` → 此处 `mod` + `pub use` →
//!   `main.rs` 的 `invoke_handler!` 加一行。三处，缺一不可。

mod bmf_cmds;
mod bmf_excel_cmds;
mod bmf_generation_cmds;
mod build_cmds;
mod build_engine;
mod client_cmds;
mod compile_cmds;
mod db_cmds;
mod db_conn_cmds;
mod db_export_cmds;
mod db_import_cmds;
mod db_relations_cmds;
mod db_search_cmds;
mod db_transfer_cmds;
mod db_user_cmds;
mod db_workbench_cmds;
mod debug_cmds;
mod decompile_cmds;
mod deploy_cmds;
mod lang_cmds;
mod linked_cmds;
mod local_history_cmds;
mod md_dict_cmds;
mod nc_log_cmds;
mod nc_manifest_cmds;
mod ncc_cmds;
mod patch_cmds;
mod quit_cmds;
mod resource_cmds;
mod search_cmds;
mod server_cmds;
mod service_log_cmds;
mod svn_cmds;
mod svn_history_cmds;
mod system;
mod type_search_cmds;
mod update;
mod upm_cmds;
mod workspace_cmds;

pub use bmf_cmds::*;
pub use bmf_excel_cmds::*;
pub use bmf_generation_cmds::*;
pub use build_cmds::*;
pub use client_cmds::*;
pub use compile_cmds::spawn_prewarm;
pub use compile_cmds::*;
pub use db_cmds::*;
pub use db_conn_cmds::*;
pub use db_export_cmds::*;
pub use db_import_cmds::*;
pub use db_relations_cmds::*;
pub use db_search_cmds::*;
pub use db_transfer_cmds::*;
pub use db_user_cmds::*;
pub use db_workbench_cmds::*;
pub use debug_cmds::*;
pub use decompile_cmds::*;
pub use deploy_cmds::*;
pub use lang_cmds::*;
pub use linked_cmds::*;
pub use local_history_cmds::*;
pub use md_dict_cmds::*;
pub use nc_log_cmds::*;
pub use nc_manifest_cmds::*;
pub use ncc_cmds::*;
pub use patch_cmds::*;
pub use quit_cmds::*;
pub use resource_cmds::*;
pub use search_cmds::*;
pub use server_cmds::*;
pub use service_log_cmds::*;
pub use svn_cmds::*;
pub use svn_history_cmds::*;
pub use system::*;
pub use type_search_cmds::*;
pub use update::*;
pub use upm_cmds::*;
pub use workspace_cmds::*;
