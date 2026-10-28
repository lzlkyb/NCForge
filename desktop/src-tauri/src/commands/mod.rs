//! 前端 → 后端的 Tauri IPC 命令层。**本文件只做聚合，不含任何实现。**
//!
//! 组织范式（承自 cc-bridge，可直接照用）：
//! - 每个关注点一个子模块 `xxx.rs` 或 `xxx_cmds.rs`（后者用于与 crate 根下同名
//!   实现模块冲突时，如 `backup` vs `backup_cmds`）。
//! - 本文件 `mod` + `pub use` 重导出，`main.rs` 的 `invoke_handler![...]` 列
//!   `commands::xxx` 即可——拆分命令层是内部结构调整，调用方零改动。
//! - 新增命令：在子模块写 `#[tauri::command]` → 此处 `mod` + `pub use` →
//!   `main.rs` 的 `invoke_handler!` 加一行。三处，缺一不可。

mod compile_cmds;
mod search_cmds;
mod server_cmds;
mod system;
mod update;
mod workspace_cmds;

pub use compile_cmds::*;
pub use search_cmds::*;
pub use server_cmds::*;
pub use system::*;
pub use update::*;
pub use workspace_cmds::*;
