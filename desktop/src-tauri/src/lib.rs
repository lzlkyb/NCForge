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

pub mod atomic_file;
pub mod bmf_export;
pub mod bmf_gen;
pub mod bmf_index;
pub mod bmf_model;
pub mod bmf_publish;
pub mod bmf_refs;
pub mod bmf_rules;
pub mod bmf_scaffold;
pub mod bmf_write;
pub mod branding;
pub mod commands;
pub mod compile;
pub mod compile_diag;
pub mod config;
pub mod config_io;
pub mod db_bridge;
pub mod db_conns;
pub mod db_engine;
pub mod db_file_export;
pub mod db_rust;
pub mod db_schema;
pub mod db_value_search;
pub mod db_zh;
pub mod debug;
pub mod decompile;
pub mod eclipse_cp;
pub mod encoding_reg;
pub mod java_bridge;
pub mod java_type_completion;
pub mod java_types;
pub mod lang;
pub mod launch;
pub mod local_history;
pub mod lsp;
pub mod md_dict;
pub mod md_dict_sql;
pub mod nc_home;
pub mod nc_index;
pub mod nc_log;
pub mod nc_log_rules;
pub mod nc_log_search;
pub mod nc_manifest;
pub mod nc_password;
pub mod nc_port;
pub mod nc_upm;
pub mod nchome_deploy;
pub mod patch_build;
pub mod patch_view;
pub mod resource_pack;
pub mod retry;
pub mod search;
pub mod security;
pub mod server;
pub mod shadow;
pub mod sql_export;
pub mod sql_refs;
pub mod state;
pub mod status_probe;
pub mod svn_backup;
pub mod svn_bridge;
pub mod svn_cred;
pub mod svn_history;
pub mod svn_review;
pub mod svn_view;
pub mod watcher;
pub mod workspace;

// main.rs 用 `use nc_forge::*;` 一把引入；AppState 是最常被引用的托管状态，
// 在根上再导出，避免 main.rs 里写 `use nc_forge::state::AppState` 的长路径。
pub use state::AppState;

/// 统一桌面通知入口：`notifications` feature 关闭时是 no-op。
///
/// **放在 lib 而不是 main**：业务侧（服务、下载、更新）都要能调它，而 `main.rs` 是
/// 二进制 crate，那里的函数对外不可见、也没有调用方——以前它挂在 `main.rs` 上，
/// 只能靠 `#[allow(dead_code)]` 压住 warning（审查报告 P2-10）。作为 lib 的公开
/// API 之后，它既是真的接入点，也不再是「需要读者相信只是暂时没用」的死代码。
///
/// 调用方只需要「发一句话」，不必重复 `#[cfg(feature = ...)]`。
#[cfg(feature = "notifications")]
pub fn notify_toast(handle: &tauri::AppHandle, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    // 失败必须留痕：插件 desktop 侧 permission_state() 硬编码返回 Granted，
    // 查不出真实授权状态——show() 的 Err 是唯一信号，`let _ =` 吞掉会静默。
    if let Err(e) = handle
        .notification()
        .builder()
        .title(branding::APP_DISPLAY_NAME)
        .body(body)
        .show()
    {
        log::warn!("桌面通知发送失败：{e}");
    }
}

#[cfg(not(feature = "notifications"))]
pub fn notify_toast(_handle: &tauri::AppHandle, _body: &str) {}
