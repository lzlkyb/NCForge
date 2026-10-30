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
#[cfg(feature = "notifications")]
use tauri_plugin_notification::NotificationExt;

use nc_forge::*;

/// 统一 toast 通知辅助：notifications feature 关闭时为 no-op。
/// 集中一处门控，避免每个调用点重复 #[cfg]。
#[cfg(feature = "notifications")]
#[allow(dead_code)] // 壳子暂无调用点；业务要发桌面通知时调它，并删掉这两行 allow
fn notify_toast(handle: &tauri::AppHandle, body: &str) {
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
#[allow(dead_code)] // 同上：无调用点的模板件，业务接入后删除
fn notify_toast(_handle: &tauri::AppHandle, _body: &str) {}

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
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = handle
                .path()
                .app_config_dir()
                .map_err(|e| std::io::Error::other(format!("无法解析应用配置目录：{e}")))?;
            std::fs::create_dir_all(&config_dir)
                .map_err(|e| std::io::Error::other(format!("无法创建应用配置目录：{e}")))?;

            let app_config = config::load_config(&config_dir);
            let app_state = AppState::new(app_config, config_dir.clone());
            app.manage(app_state.clone());

            // 资源包启动自检：缺包时置备（下载 jdtls / ecj / svnkit 到 config_dir/resources）。
            // 异步 spawn，不阻塞启动；进度经 resource:* 事件推给前端。已在跑就忽略
            // （命令层的单飞闸兜底，这里提前挡一次少发一个无用任务）。
            // dev 构建默认跳过（resource_cmds.rs 的 dev_auto_skip）：开发期资源由
            // `npm run jdtls:fetch` 拉进源码树，finder 回退用它；设
            // APP_RESOURCES_ENDPOINT 可强制跑自检（联调下载流程）。
            {
                let bg = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    commands::ensure_resources_async(bg, false);
                });
            }

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
            commands::check_update,
            commands::resources_status,
            commands::resources_ensure,
            commands::get_workspace,
            commands::set_workspace,
            commands::fs_list_dir,
            commands::fs_read_file,
            commands::fs_write_file,
            commands::fs_create,
            commands::fs_rename,
            commands::fs_delete,
            commands::fs_count_files,
            commands::fs_encoding_marks,
            commands::compile_module,
            commands::compile_cancel,
            commands::lang_start,
            commands::lang_stop,
            commands::lang_regenerate,
            commands::lang_config_set,
            commands::lang_status,
            commands::lang_request,
            commands::lang_notify,
            commands::search_workspace,
            commands::search_list_files,
            commands::server_status,
            commands::server_start,
            commands::server_stop,
            commands::server_log,
            commands::server_clear_log,
            commands::server_command_line,
            commands::server_reveal_log,
            commands::server_kill_port_owner,
            commands::nc_home_probe,
            commands::nc_home_set,
            commands::server_heap_set,
            commands::nc_port_preview,
            commands::nc_port_apply,
            commands::svn_info,
            commands::svn_status,
            commands::svn_diff,
            commands::svn_log,
            commands::svn_blame,
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
            commands::patch_set_out_dir,
            commands::patch_set_out_root,
            commands::patch_reveal,
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
            commands::db_cancel,
            commands::db_caps,
            commands::db_more,
            commands::db_tx,
            commands::db_meta,
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
