//! 桌面壳入口：单实例 / 无边框窗口 / 关窗退出 / 更新命令注册。
//!
//! 这是壳子的 Rust 侧全部家当。业务模块（HTTP 服务、数据库、各域命令）在
//! `lib.rs` 里挂，本文件只管「一个普通桌面应用」本身。
//!
//! **这不是常驻托盘应用**（2026-10-31 改）：点 X 就是退出，没有托盘图标、没有
//! 后台常驻。因此**关窗路径上的事务确认是必须的**——见 `CloseRequested` 与
//! `commands::quit_cmds`。历史包袱（关窗销毁/隐藏两模式）已一并删除，别再加回来。
//!
//! 另一个关键设计：`sync_window_visibility` 5s 状态复核：mac 最小化不发窗口事件，
//! 只靠事件会漏暂停。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Emitter;
use tauri::Manager;

use nc_forge::*;

// 桌面通知入口在 lib 里（`nc_forge::notify_toast`，按 feature 门控 no-op）：
// 业务侧也要能调，而 main.rs 的函数对外不可见。

/// 给窗口打上平台特异的装饰（目前只有 Win11 DWM 圆角）。
///
/// **为何抽成函数**：无边框窗口的圆角要在 `show()` 之前打上，否则能看到一帧直角；
/// 抽出来也让以后新增的窗口（如果有）能共用同一份设置。
fn apply_window_decorations(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
        };
        if let Ok(hwnd) = window.hwnd() {
            let preference: i32 = 2; // DWMWCP_ROUND = 2（标准圆角）
            unsafe {
                if let Err(e) = DwmSetWindowAttribute(
                    HWND(hwnd.0 as isize),
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    &preference as *const i32 as *const _,
                    std::mem::size_of::<i32>() as u32,
                ) {
                    log::warn!("DWM 圆角设置失败: {:?}", e);
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

/// 复核主窗口「是否对用户不可见」，仅在状态翻转时通知前端暂停 / 恢复轮询与动画。
///
/// **为何需要它（而不是只靠窗口事件）**：mac 上最小化到 Dock **不产生任何 tao 窗口事件**
/// （查过 tao 0.35.3 的 macOS 实现：Resized 只从 windowDidResize 发出，最小化时尺寸没变；
/// 没有 miniaturize / 遮挡事件）。于是 `on_window_event` 的 Resized 分支在 mac 上永不触发，
/// 前端收不到 `app:visibility = false`，轮询和 CSS 动画在最小化后照常跑。
///
/// **为何查状态而不是补事件**：状态检查天然覆盖「任何没发事件的隐藏路径」，也不必写 objc
/// （那种代码在 Windows 上一行都测不到）。代价是最长 5s 才暂停——省电优化不是正确性问题。
///
/// **两项必须都查**：`is_minimized()` 只覆盖任务栏/Dock 最小化，漏掉
/// 「系统级隐藏应用」（mac 的 Cmd+H：`is_visible()` 为 false 但没最小化），
/// 漏了那种情况轮询会照旧跑。
/// **为何不再提托盘**：2026-10-31 去掉了托盘常驻，关窗即退出，所以能"不可见"的
/// 只剩最小化与系统隐藏两条路。状态复核照旧保留——mac 最小化仍然不发窗口事件。
fn sync_window_visibility(handle: &tauri::AppHandle) {
    // 窗口已销毁（退出流程走到一半）→ 没有前端可通知，跳过。
    let Some(w) = handle.get_webview_window("main") else {
        return;
    };
    // 系统级隐藏应用 → is_visible 为 false；最小化到 Dock / 任务栏 → is_minimized 为 true。
    // 读失败一律按「可见」处理：宁可漏暂停，也不能误暂停，把用户正看着的界面冻住。
    let hidden = !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false);
    // 边沿触发：不加这层，5s 一次的 tick 会稳定产生每分钟 12 次无谓 IPC。
    static LAST_HIDDEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if LAST_HIDDEN.swap(hidden, std::sync::atomic::Ordering::Relaxed) != hidden {
        let _ = w.emit("app:visibility", !hidden);
    }
}

/// 后台周期任务加 panic 恢复：任务 panic 后该循环会**永久静默停止**，用户和日志都无感知。
/// 用 JoinHandle 的 panic 检测做自愈：内层任务 panic → 记录错误日志 → 短暂延迟后重新 spawn。
fn spawn_supervised<F>(name: &'static str, make_task: F)
where
    F: Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        loop {
            let handle = tauri::async_runtime::spawn(make_task());
            match handle.await {
                Ok(()) => {
                    log::warn!("后台任务「{name}」意外正常退出（预期是永久循环），1s 后重启");
                }
                Err(e) => {
                    log::error!("后台任务「{name}」 panic，1s 后自愈重启：{e}");
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 重复启动：把已存在的窗口提到前台。点 X 就是退出，所以窗口一定还在——
            // 原来那条"已销毁 → 按配置重建"的路随托盘一起去掉了。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.emit("app:visibility", true);
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_process::init());

    #[cfg(feature = "notifications")]
    let builder = builder.plugin(tauri_plugin_notification::init());

    builder
        .plugin(tauri_plugin_opener::init())
        // 工程目录只让用户通过系统文件夹选择器挑，不再手填路径
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = handle
                .path()
                .app_config_dir()
                .map_err(|e| std::io::Error::other(format!("无法解析应用配置目录：{e}")))?;
            std::fs::create_dir_all(&config_dir)
                .map_err(|e| std::io::Error::other(format!("无法创建应用配置目录：{e}")))?;

            let app_config = config::load_config(&config_dir);
            let startup_root = app_config.workspace_root.clone();
            let app_state = AppState::new(app_config, config_dir.clone());
            app.manage(app_state.clone());

            // 上次的工作区在启动时就挂上文件监听：树第一次列目录后，外部改动立即自动刷新。
            // 失败只记日志（没有自动刷新，展开 / 手动刷新照常可用）。
            if let Some(root) = startup_root {
                commands::restart_watcher(app.handle(), &app_state, &root);
            }

            // 资源只在用户选择组件或功能提示中请求下载；启动读取本地状态，不联网置备。

            // 注入 AppHandle 供需要发桌面通知的代码用（feature 关闭时不注入）。
            // 中毒恢复而非 unwrap：一次 panic 不该让后续每个 setup 路径都连锁 panic。
            #[cfg(feature = "notifications")]
            {
                *app_state
                    .app_handle
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(app.handle().clone());
            }

            // Updater 插件容错注册：pubkey 与签名私钥配对（见 tauri.conf.json）。
            // 更新源优先级：环境变量 APP_UPDATE_ENDPOINT（逗号分隔多 URL，按顺序故障转移）>
            // tauri.conf.json 的 plugins.updater.endpoints。
            // 用 match 兜底，避免 dev 环境端点不可达或配置误改导致 updater 初始化失败时
            // 拖垮整个应用启动。
            match app
                .handle()
                .plugin(tauri_plugin_updater::Builder::new().build())
            {
                Ok(_) => log::info!(
                    "Updater 插件已启用（更新源默认 tauri.conf.json 的 plugins.updater.endpoints，可用环境变量 APP_UPDATE_ENDPOINT 覆盖）"
                ),
                Err(e) => log::warn!("初始化 Updater 插件失败，已跳过：{e}"),
            }

            // Show main window (config: visible=false, decorations=false)
            if let Some(window) = app.get_webview_window("main") {
                // 圆角要在 show 之前打上，否则能看到一帧直角
                apply_window_decorations(&window);
                let _ = window.show();
                let _ = window.set_focus();
            }

            {
                // 后台任务够着 AppHandle 的范式：setup 里克隆一份 move 进去
                //（不要在 AppState 里存 AppHandle——setup 之前它还不存在）。
                let bg_handle = app.handle().clone();
                // 窗口可见性 5s 状态复核（mac 最小化不发窗口事件的兜底，见函数注释）。
                // G1 范式：套 spawn_supervised，panic 后自愈重启而非永久静默停止。
                // 原来这个循环还顺带刷新托盘图标，托盘删掉后它只剩这一件事。
                spawn_supervised("窗口可见性复核", move || {
                    let bg = bg_handle.clone();
                    Box::pin(async move {
                        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
                        loop {
                            ticker.tick().await;
                            sync_window_visibility(&bg);
                        }
                    })
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::patch_config,
            commands::get_autostart,
            commands::set_autostart,
            commands::reveal_install_dir,
            commands::open_external,
            commands::get_app_info,
            commands::start_update,
            commands::install_update,
            commands::check_update,
            commands::resources_status,
            commands::resources_ensure,
            commands::pick_folder,
            commands::pick_file,
            commands::get_workspace,
            commands::set_workspace,
            commands::linked_projects,
            commands::tree_projects,
            commands::project_dependencies,
            commands::reveal_dependency_source,
            commands::set_linked_overrides,
            commands::check_artifacts,
            commands::fs_list_dir,
            commands::fs_package_dirs,
            commands::fs_java_kinds,
            commands::fs_java_outline_source,
            commands::nc_manifest,
            commands::nc_manifest_audit,
            commands::nc_upm_index,
            commands::nc_upm_lookup,
            commands::fs_read_file,
            commands::fs_write_file,
            commands::fs_create,
            commands::fs_rename,
            commands::fs_delete,
            commands::fs_count_files,
            commands::fs_encoding_marks,
            commands::compile_module,
            commands::compile_file,
            commands::compile_all_modules,
            commands::compile_cancel,
            commands::decompile_class,
            commands::lang_start,
            commands::lang_stop,
            commands::lang_regenerate,
            commands::lang_config_set,
            commands::lang_status,
            commands::lang_request,
            commands::lang_notify,
            commands::lang_semantic_tokens,
            // 调试（DAP）：java-debug over jdt.ls → JDWP
            commands::debug_start,
            commands::debug_status,
            commands::debug_stop,
            commands::debug_set_breakpoints,
            commands::debug_set_exception_breakpoints,
            commands::debug_continue,
            commands::debug_step,
            commands::debug_pause,
            commands::debug_threads,
            commands::debug_stack_trace,
            commands::debug_scopes,
            commands::debug_variables,
            commands::debug_set_variable,
            commands::debug_exception_info,
            commands::debug_evaluate,
            commands::search_workspace,
            commands::search_projects,
            commands::search_list_files,
            commands::search_replace,
            commands::search_cancel,
            commands::local_history_capture,
            commands::local_history_list,
            commands::local_history_read,
            commands::local_history_restore,
            commands::nc_md_tables,
            commands::nc_md_dict,
            commands::nc_md_dict_text,
            commands::nc_md_dict_export,
            commands::bmf_index_scan,
            commands::bmf_doc_detail,
            commands::bmf_detail_text,
            commands::bmf_validate,
            commands::bmf_generate,
            commands::bmf_generate_plan,
            commands::bmf_gen_diff,
            commands::bmf_gen_apply,
            commands::bmf_gen_export,
            commands::bmf_references,
            commands::bmf_scaffold_preview,
            commands::bmf_scaffold_write,
            commands::bmf_edit_preview,
            commands::bmf_draft_preview,
            commands::bmf_node_source,
            commands::bmf_edit_save,
            commands::bmf_publish_probe,
            commands::bmf_excel_template,
            commands::bmf_excel_preview,
            commands::bmf_history,
            commands::bmf_revision_text,
            commands::bmf_nchome_compare,
            commands::bmf_release_plan,
            commands::bmf_release_evidence,
            commands::nc_log_sources,
            commands::nc_log_query,
            commands::nc_log_trace,
            commands::nc_log_search,
            // 配置投送：工程 META-INF → NCHOME（manifest + 备份 + 清理）
            commands::deploy_preview,
            commands::deploy_apply,
            commands::deploy_cleanup,
            commands::deploy_status,
            // NCC/BIP 报文解密：只读服务端开关，解密在前端 WebCrypto 里做
            commands::ncc_decode_config,
            commands::server_status,
            commands::server_start,
            commands::server_stop,
            commands::server_log,
            commands::server_clear_log,
            commands::server_command_line,
            commands::server_reveal_log,
            commands::server_kill_port_owner,
            // NC 客户端（Swing JStarter）：独立进程，与中间件各用一套启停与日志
            commands::client_status,
            commands::client_start,
            commands::client_stop,
            commands::client_log,
            commands::client_clear_log,
            commands::client_command_line,
            commands::client_reveal_log,
            commands::client_heap_set,
            commands::nc_home_probe,
            commands::nc_home_set,
            commands::export_config,
            commands::import_config,
            commands::server_heap_set,
            commands::hotwebs_probe,
            commands::hotwebs_set,
            commands::nc_port_preview,
            commands::nc_port_apply,
            commands::svn_info,
            commands::svn_status,
            commands::svn_diff,
            commands::svn_history,
            commands::svn_revision_diff,
            commands::svn_blame_snapshot,
            commands::svn_conflict_snapshot,
            commands::svn_resolve_working,
            commands::svn_commit,
            commands::svn_update,
            commands::svn_revert,
            commands::svn_resolve,
            commands::svn_review_mark,
            commands::svn_review_prune,
            commands::svn_housekeeping,
            commands::svn_backup_delete,
            commands::svn_auth_set,
            // 补丁（M7）
            commands::patch_defaults,
            commands::patch_scan,
            commands::patch_build,
            commands::patch_build_cancel,
            commands::patch_set_out_dir,
            commands::patch_set_out_root,
            commands::patch_reveal,
            commands::patch_restore_backup,
            // 数据库：连接管理
            commands::db_conn_list,
            commands::db_conn_save,
            commands::db_conn_delete,
            commands::db_conn_reorder,
            commands::db_conn_test,
            commands::db_conn_import_props,
            commands::db_prop_sources,
            commands::db_prop_import,
            // 数据库：会话、执行、事务、元数据
            commands::db_connect,
            commands::db_disconnect,
            commands::db_exec,
            commands::db_exec_bound,
            commands::db_read_only,
            commands::db_relations,
            commands::db_cancel,
            commands::db_caps,
            commands::db_more,
            commands::db_tx,
            commands::db_tx_all,
            commands::db_meta,
            // 数据库：独立会话槽（多标签各跑各的，A0）
            commands::db_slot_acquire,
            commands::db_slot_release,
            // 数据导出（NC 基础数据：insert 脚本）
            commands::db_export_insert,
            // 数据导出（流式写文件：CSV / TSV / INSERT，A4）
            commands::db_export_file,
            commands::db_export_cancel,
            commands::db_export_reveal,
            // 导入（B3）：CSV/TSV → 表，走独立会话的事务
            commands::db_import_rows,
            // 全库按值反查（只读；每表一条查询 + 进度/取消）
            commands::db_value_search,
            commands::db_value_search_cancel,
            // 重置操作员密码：只读 sm_user + 生成 SQL，绝不执行
            commands::db_user_list,
            commands::db_password_reset_sql,
            // 表结构缓存 + 出包前核对
            commands::db_schema_status,
            commands::db_schema_sync,
            commands::db_schema_cache,
            commands::db_columns,
            commands::db_cached_tables,
            commands::db_check_sources,
            // 退出流程（关窗即退出，退出前确认未提交事务）
            commands::db_pending_tx,
            commands::quit_check_acked,
            commands::quit_cancel,
            commands::app_quit,
        ])
        .on_window_event(|window, event| match event {
            // 点 X / Alt+F4 / 标题栏关闭按钮 = 退出应用（2026-10-31 起不再收进托盘）。
            //
            // 但**不能直接放行**：退出会带走未提交的事务（Oracle 隐式回滚），用户
            // 点一下就把刚做的批量更新丢了。所以先拦一次，让前端查一遍再说——见
            // `commands::quit_cmds` 的时序说明。`begin_quit_check` 返回 true 就代表
            // 已经拦住了；返回 false 时什么都不做，窗口照常关闭、进程随后退出。
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if commands::begin_quit_check(window) {
                    api.prevent_close();
                }
            }
            // OS 级最小化 / 还原。**仅 Windows 有效**——mac 上最小化到 Dock 尺寸不变，
            // tao 不会发 `Resized`，详见 `sync_window_visibility` 头注释。
            // 1. Windows 上最小化只会触发 `Resized`，Tauri 没有独立的 Minimized 事件；
            // 2. WebView2 在宿主窗口最小化时**不发** visibilitychange（实测最小化前后
            //    webview CPU 几乎没降），所以前端的 `document.hidden` 兜底拿不到信号。
            // 不处理的后果：最小化后动画与轮询照旧烧 CPU。
            tauri::WindowEvent::Resized(_) => {
                // Resized 在拖动窗口边框时高频触发，只在最小化状态真正翻转时才发事件。
                static LAST_MINIMIZED: std::sync::atomic::AtomicBool =
                    std::sync::atomic::AtomicBool::new(false);
                let minimized = window.is_minimized().unwrap_or(false);
                if LAST_MINIMIZED.swap(minimized, std::sync::atomic::Ordering::Relaxed)
                    != minimized
                {
                    let _ = window.emit("app:visibility", !minimized);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())?
        .run(|app_handle, event| {
            // 真退出时（点 X / 更新器重启 / 系统关机）杀掉 jdt.ls，不留孤儿 Java 进程。
            //
            // **不再拦 `ExitRequested{code:None}`**：那是「最后一个窗口关闭」触发的退出。
            // 本应用现在的语义就是关窗即退出，拦住它只会得到一个关不掉的幽灵进程
            // （托盘已经没了，用户连唤回界面都做不到）。
            if let tauri::RunEvent::Exit = event {
                if let Some(st) = app_handle.try_state::<std::sync::Arc<AppState>>() {
                    let session = st.lang.lock().unwrap_or_else(|e| e.into_inner()).session.take();
                    if let Some(s) = session {
                        s.client.kill();
                    }
                    // 调试连接：不关的话 java-debug 的适配器会话会挂在 jdt.ls 里。
                    // 两个目标各一条，退出时都要收。
                    let (server_debug, client_debug) = {
                        let mut run = st.debug.lock().unwrap_or_else(|e| e.into_inner());
                        (run.server.session.take(), run.client.session.take())
                    };
                    for s in [server_debug, client_debug].into_iter().flatten() {
                        s.client.kill();
                    }
                    // 数据库桥同理：每个连接一个 JVM，未提交的事务随进程结束由 Oracle 回滚
                    let bridges: Vec<_> = st
                        .db
                        .lock()
                        .map(|mut m| m.drain().map(|(_, b)| b).collect())
                        .unwrap_or_default();
                    for b in bridges {
                        b.shutdown();
                    }
                }
            }
        });

    Ok(())
}
