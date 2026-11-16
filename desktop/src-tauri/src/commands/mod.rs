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
mod change_shelf_cmds;
mod client_cmds;
mod compile_cmds;
mod db_cmds;
mod db_conn_cmds;
mod db_export_cmds;
mod db_import_cmds;
mod db_relations_cmds;
mod db_search_cmds;
mod db_struct_cmds;
mod db_transfer_cmds;
mod db_transfer_rows_cmds;
mod db_user_cmds;
mod db_workbench_cmds;
mod debug_advanced_cmds;
mod debug_cmds;
mod decompile_cmds;
mod deploy_cmds;
mod frontend_log_cmds;
mod hotswap_cmds;
mod jar_symbol_cmds;
mod java_diagnostics_cmds;
mod java_run_cmds;
mod lang_cache;
mod lang_cmds;
mod library_cmds;
mod linked_cmds;
mod local_history_cmds;
mod md_dict_cmds;
mod nc_log_cmds;
mod nc_manifest_cmds;
mod ncc_cmds;
mod patch_cmds;
mod project_config_cmds;
mod project_tools_cmds;
mod quit_cmds;
mod req_cmds;
mod resource_cmds;
mod search_cmds;
mod server_cmds;
mod service_log_cmds;
mod src_note_cmds;
mod svn_cmds;
mod svn_history_cmds;
mod system;
mod type_search_cmds;
mod update;
mod upm_cmds;
mod vo_map_cmds;
mod workspace_cmds;
mod workspace_edit_cmds;

pub use bmf_cmds::*;
pub use bmf_excel_cmds::*;
pub use bmf_generation_cmds::*;
pub use build_cmds::*;
pub use change_shelf_cmds::*;
pub use client_cmds::*;
pub use compile_cmds::spawn_prewarm;
pub use compile_cmds::*;
pub use db_cmds::reclaim_idle_db_slots;
pub use db_cmds::*;
pub use db_conn_cmds::*;
pub use db_export_cmds::*;
pub use db_import_cmds::*;
pub use db_relations_cmds::*;
pub use db_search_cmds::*;
pub use db_struct_cmds::*;
pub use db_transfer_cmds::*;
pub use db_transfer_rows_cmds::*;
pub use db_user_cmds::*;
pub use db_workbench_cmds::*;
pub use debug_advanced_cmds::*;
pub use debug_cmds::*;
pub use decompile_cmds::*;
pub use deploy_cmds::*;
pub use frontend_log_cmds::*;
pub use hotswap_cmds::*;
pub use jar_symbol_cmds::*;
pub use java_diagnostics_cmds::*;
pub use java_run_cmds::*;
pub use lang_cache::*;
pub use lang_cmds::*;
pub use library_cmds::*;
pub use linked_cmds::*;
pub use local_history_cmds::*;
pub use md_dict_cmds::*;
pub use nc_log_cmds::*;
pub use nc_manifest_cmds::*;
pub use ncc_cmds::*;
pub use patch_cmds::*;
pub use project_config_cmds::*;
pub use project_tools_cmds::*;
pub use quit_cmds::*;
pub use req_cmds::*;
pub use resource_cmds::*;
pub use search_cmds::*;
pub use server_cmds::*;
pub use service_log_cmds::*;
pub use src_note_cmds::*;
pub use svn_cmds::*;
pub use svn_history_cmds::*;
pub use system::*;
pub use type_search_cmds::*;
pub use update::*;
pub use upm_cmds::*;
pub use vo_map_cmds::*;
pub use workspace_cmds::*;
pub use workspace_edit_cmds::*;

/// 前端可调用的全部 Tauri 命令登记表。**唯一真源**。
///
/// 🔴 为什么用宏而不是留在 `main.rs`（2026-11-16）：
/// 表本身有 300+ 行且只增不减，留在 `main.rs` 会把它顶过 600 行体量红线
/// （实测加 3 条前端日志命令就 599 → 603，`check-source-size` 立刻红）。
/// 命令层聚合本来就是本文件的职责（见头注释），表放这里语义也更顺。
///
/// 用 `macro_rules!` 而不是函数：`tauri::generate_handler!` 要的是**字面路径列表**，
/// 它自己也是宏，没法接收运行时的数组。宏展开后与原来写在 main.rs 里完全等价。
///
/// 新增命令仍是三处：子模块 `#[tauri::command]` → 本文件 `mod` + `pub use` → 下面这张表。
/// `scripts/gen-command-contract.mjs` 以本表为真源做三层交叉校验。
#[macro_export]
macro_rules! nc_forge_commands {
    () => {
        tauri::generate_handler![
        $crate::commands::get_config,
        $crate::commands::boot_report,
        $crate::commands::boot_stage,
        $crate::commands::lang_cache_stats,
        $crate::commands::lang_cache_clear,
        $crate::commands::nc_vo_tables,
        $crate::commands::patch_config,
        $crate::commands::get_autostart,
        $crate::commands::set_autostart,
        $crate::commands::reveal_install_dir,
        $crate::commands::open_external,
        $crate::commands::get_app_info,
        $crate::commands::start_update,
        $crate::commands::install_update,
        $crate::commands::check_update,
        $crate::commands::resources_status,
        $crate::commands::resources_ensure,
        $crate::commands::pick_folder,
        $crate::commands::pick_file,
        $crate::commands::get_workspace,
        $crate::commands::set_workspace,
        $crate::commands::linked_projects,
        $crate::commands::tree_projects,
        $crate::commands::project_dependencies,
        $crate::commands::reveal_dependency_source,
        $crate::commands::set_linked_overrides,
        $crate::commands::check_artifacts,
        $crate::commands::fs_list_dir,
        $crate::commands::fs_package_dirs,
        $crate::commands::fs_java_kinds,
        $crate::commands::fs_java_outline_source,
        $crate::commands::nc_manifest,
        $crate::commands::nc_manifest_audit,
        $crate::commands::nc_upm_index,
        $crate::commands::nc_upm_lookup,
        $crate::commands::fs_read_file,
        $crate::commands::fs_write_file,
        $crate::commands::fs_create,
        $crate::commands::fs_create_java,
        $crate::commands::fs_java_preview,
        $crate::commands::fs_rename,
        $crate::commands::fs_delete,
        $crate::commands::fs_count_files,
        $crate::commands::fs_encoding_marks,
        $crate::commands::compile_module,
        $crate::commands::compile_file,
        $crate::commands::compile_all_modules,
        $crate::commands::compile_incremental,
        $crate::commands::compile_cancel,
        // 构建维护：清理 / 清理并重编 / 重建索引 / 缓存统计
        $crate::commands::build_clean_module,
        $crate::commands::build_clean_all,
        $crate::commands::build_rebuild_module,
        $crate::commands::build_rebuild_all,
        $crate::commands::build_reindex,
        $crate::commands::build_clean_tmp,
        $crate::commands::build_cache_info,
        $crate::commands::build_history,
        $crate::commands::decompile_class,
        $crate::commands::lang_start,
        $crate::commands::lang_stop,
        $crate::commands::lang_regenerate,
        $crate::commands::lang_config_set,
        $crate::commands::lang_status,
        $crate::commands::lang_request,
        $crate::commands::lang_notify,
        $crate::commands::lang_semantic_tokens,
        // 调试（DAP）：java-debug over jdt.ls → JDWP
        $crate::commands::debug_start,
        $crate::commands::debug_status,
        $crate::commands::debug_stop,
        $crate::commands::debug_set_breakpoints,
        $crate::commands::debug_set_exception_breakpoints,
        $crate::commands::debug_continue,
        $crate::commands::debug_step,
        $crate::commands::debug_pause,
        $crate::commands::debug_threads,
        $crate::commands::debug_stack_trace,
        $crate::commands::debug_scopes,
        $crate::commands::debug_variables,
        $crate::commands::debug_set_variable,
        $crate::commands::debug_exception_info,
        $crate::commands::debug_evaluate,
        $crate::commands::search_workspace,
        $crate::commands::search_workspace_stream,
        $crate::commands::search_projects,
        $crate::commands::search_list_files,
        $crate::commands::search_invalidate_files,
        $crate::commands::search_types,
        $crate::commands::search_workspace_symbols,
        $crate::commands::search_jar_symbols,
        $crate::commands::search_src_notes,
        $crate::commands::search_library_files,
        $crate::commands::read_library_file,
        $crate::commands::library_search_cancel,
        $crate::commands::read_src_file,
        $crate::commands::search_replace,
        $crate::commands::search_cancel,
        $crate::commands::search_pack_status,
        $crate::commands::local_history_capture,
        $crate::commands::local_history_list,
        $crate::commands::local_history_read,
        $crate::commands::local_history_restore,
        $crate::commands::nc_md_tables,
        $crate::commands::nc_md_dict,
        $crate::commands::nc_md_dict_text,
        $crate::commands::nc_md_dict_export,
        $crate::commands::bmf_index_scan,
        $crate::commands::bmf_doc_detail,
        $crate::commands::bmf_detail_text,
        $crate::commands::bmf_validate,
        $crate::commands::bmf_generate,
        $crate::commands::bmf_generate_plan,
        $crate::commands::bmf_gen_preview,
        $crate::commands::bmf_gen_check,
        $crate::commands::bmf_gen_target,
        $crate::commands::bmf_gen_reveal,
        $crate::commands::bmf_gen_diff,
        $crate::commands::bmf_gen_apply,
        $crate::commands::bmf_gen_export,
        $crate::commands::bmf_references,
        $crate::commands::bmf_scaffold_preview,
        $crate::commands::bmf_scaffold_write,
        $crate::commands::bmf_edit_preview,
        $crate::commands::bmf_draft_preview,
        $crate::commands::bmf_node_source,
        $crate::commands::bmf_edit_save,
        $crate::commands::bmf_publish_probe,
        $crate::commands::bmf_excel_template,
        $crate::commands::bmf_excel_preview,
        $crate::commands::bmf_history,
        $crate::commands::bmf_revision_text,
        $crate::commands::bmf_nchome_compare,
        $crate::commands::bmf_release_plan,
        $crate::commands::bmf_release_evidence,
        $crate::commands::nc_log_sources,
        $crate::commands::nc_log_query,
        $crate::commands::nc_log_trace,
        $crate::commands::nc_log_search,
        // 配置投送：工程 META-INF → NCHOME（manifest + 备份 + 清理）
        $crate::commands::deploy_preview,
        $crate::commands::deploy_apply,
        $crate::commands::deploy_cleanup,
        $crate::commands::deploy_status,
        // 前端错误落盘：崩溃现场不再依赖用户「记得点复制错误信息」
        $crate::commands::frontend_log_append,
        $crate::commands::frontend_log_read,
        $crate::commands::frontend_log_reveal,
        // NCC/BIP 报文解密：只读服务端开关，解密在前端 WebCrypto 里做
        $crate::commands::ncc_decode_config,
        $crate::commands::server_status,
        $crate::commands::server_start,
        $crate::commands::server_stop,
        // 热替换：状态查询 / 手动模式推送（编译后的自动推送不走命令）
        $crate::commands::hotswap_status,
        $crate::commands::hotswap_push_pending,
        $crate::commands::hotswap_clear_pending,
        $crate::commands::server_log,
        $crate::commands::service_log_read,
        $crate::commands::service_log_tail,
        $crate::commands::service_log_clear,
        $crate::commands::service_log_purge,
        $crate::commands::service_log_export,
        $crate::commands::service_log_cancel_export,
        $crate::commands::server_clear_log,
        $crate::commands::server_command_line,
        $crate::commands::server_reveal_log,
        $crate::commands::server_kill_port_owner,
        // NC 客户端（Swing JStarter）：独立进程，与中间件各用一套启停与日志
        $crate::commands::client_status,
        $crate::commands::client_start,
        $crate::commands::client_stop,
        $crate::commands::client_log,
        $crate::commands::client_clear_log,
        $crate::commands::client_command_line,
        $crate::commands::client_reveal_log,
        $crate::commands::client_heap_set,
        $crate::commands::nc_home_probe,
        $crate::commands::nc_home_set,
        $crate::commands::nc_home_candidates,
        $crate::commands::export_config,
        $crate::commands::import_config,
        $crate::commands::server_heap_set,
        $crate::commands::hotwebs_probe,
        $crate::commands::hotwebs_set,
        $crate::commands::nc_port_preview,
        $crate::commands::nc_port_apply,
        $crate::commands::svn_info,
        $crate::commands::svn_status,
        $crate::commands::svn_diff,
        $crate::commands::svn_history,
        $crate::commands::svn_revision_diff,
        $crate::commands::svn_blame_snapshot,
        $crate::commands::svn_conflict_snapshot,
        $crate::commands::svn_resolve_working,
        $crate::commands::svn_commit,
        $crate::commands::svn_update,
        $crate::commands::svn_revert,
        $crate::commands::svn_resolve,
        $crate::commands::svn_review_mark,
        $crate::commands::svn_review_prune,
        // 按需求审查：需求表 + cc-bridge 变更日志 + 块级已审（commands/req_cmds.rs）
        $crate::commands::req_state,
        $crate::commands::req_create,
        $crate::commands::req_rename,
        $crate::commands::req_merge,
        $crate::commands::req_set_status,
        $crate::commands::req_set_current,
        $crate::commands::req_claim,
        $crate::commands::req_note_manual,
        $crate::commands::req_record_package,
        $crate::commands::req_prune,
        $crate::commands::review_blocks_marks,
        $crate::commands::req_file_versions,
        $crate::commands::review_blocks_set,
        $crate::commands::svn_housekeeping,
        $crate::commands::svn_backup_delete,
        $crate::commands::svn_auth_set,
        // 补丁（M7）
        $crate::commands::patch_defaults,
        $crate::commands::patch_scan,
        $crate::commands::patch_build,
        $crate::commands::patch_build_cancel,
        $crate::commands::patch_set_out_dir,
        $crate::commands::patch_set_out_root,
        $crate::commands::patch_reveal,
        $crate::commands::patch_restore_backup,
        // 数据库：连接管理
        $crate::commands::db_conn_list,
        $crate::commands::db_conn_save,
        $crate::commands::db_conn_delete,
        $crate::commands::db_conn_reorder,
        $crate::commands::db_conn_test,
        $crate::commands::db_conn_import_props,
        $crate::commands::db_conn_preview_props,
        $crate::commands::db_prop_sources,
        $crate::commands::db_prop_import,
        // 数据库连接：从 DataGrip / PL/SQL Developer 导入（只导结构）
        $crate::commands::db_import_datagrip,
        $crate::commands::db_import_datagrip_zip,
        $crate::commands::db_import_plsql,
        $crate::commands::db_conn_import_apply,
        // 数据库：会话、执行、事务、元数据
        $crate::commands::db_connect,
        $crate::commands::db_disconnect,
        $crate::commands::db_exec,
        $crate::commands::db_exec_result,
        $crate::commands::db_exec_bound,
        $crate::commands::db_read_only,
        $crate::commands::db_relations,
        $crate::commands::db_cancel,
        $crate::commands::db_caps,
        $crate::commands::db_more,
        $crate::commands::db_more_result,
        $crate::commands::db_result_close,
        $crate::commands::db_lob_value,
        $crate::commands::db_tx,
        $crate::commands::db_tx_all,
        $crate::commands::db_meta,
        // 会话级默认 schema（写 SQL 不带前缀）
        $crate::commands::db_set_schema,
        // 数据库：独立会话槽（多标签各跑各的，A0）
        $crate::commands::db_slot_acquire,
        $crate::commands::db_slot_release,
        // 数据导出（NC 基础数据：insert 脚本）
        $crate::commands::db_export_insert,
        // 数据导出（流式写文件：CSV / TSV / INSERT，A4）
        $crate::commands::db_export_file,
        $crate::commands::db_transfer_pick,
        $crate::commands::db_transfer_file,
        $crate::commands::db_transfer_open,
        $crate::commands::db_export_cancel,
        $crate::commands::db_export_reveal,
        // 导入（B3）：CSV/TSV/JSON/XLSX → 表，走独立会话的事务
        $crate::commands::db_xlsx_read,
        $crate::commands::db_import_rows,
        // 表结构对比（DDL diff）：只生成脚本，绝不执行
        $crate::commands::db_struct_diff,
        // 表 → 表 直连搬运（A 库 → B 库，不落文件中转）
        $crate::commands::db_transfer_plan,
        $crate::commands::db_transfer_rows,
        $crate::commands::db_transfer_rows_cancel,
        // 全库按值反查（只读；每表一条查询 + 进度/取消）
        $crate::commands::db_value_search,
        $crate::commands::db_value_search_cancel,
        // 重置操作员密码：只读 sm_user + 生成 SQL，绝不执行
        $crate::commands::db_user_list,
        $crate::commands::db_password_reset_sql,
        // 表结构缓存 + 出包前核对
        $crate::commands::db_schema_status,
        $crate::commands::db_schema_sync,
        $crate::commands::db_schema_cache,
        $crate::commands::db_columns,
        $crate::commands::db_cached_tables,
        $crate::commands::db_check_sources,
        // 退出流程（关窗即退出，退出前确认未提交事务）
        $crate::commands::db_pending_tx,
        $crate::commands::quit_check_acked,
        $crate::commands::quit_cancel,
        $crate::commands::app_quit,
        $crate::commands::java_run,
        $crate::commands::java_run_cancel,
        $crate::commands::java_run_discover,
        $crate::commands::java_run_open_report,
        $crate::commands::java_diagnostic,
        $crate::commands::debug_set_step_filters,
        $crate::commands::workspace_apply_edit,
        $crate::commands::project_run_tool,
        $crate::commands::project_stop_tool,
        $crate::commands::project_open_terminal,
        $crate::commands::project_tools_context,
        $crate::commands::project_plan_attachment,
        $crate::commands::change_shelf_list,
        $crate::commands::change_shelf_create,
        $crate::commands::change_shelf_plan,
        $crate::commands::change_shelf_delete,
        ]
    };
}
