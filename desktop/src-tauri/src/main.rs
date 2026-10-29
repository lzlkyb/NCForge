//! 桌面壳入口：托盘 / 单实例 / 无边框窗口 / 关窗销毁重建 / 更新命令注册。
//!
//! 这是壳子的 Rust 侧全部家当。业务模块（HTTP 服务、数据库、各域命令）在
//! `lib.rs` 里挂，本文件只管「一个常驻托盘的桌面应用」本身。
//!
//! 承自 cc-bridge 的三个关键设计，改动前先读注释：
//! 1. 关窗**销毁**窗口而不是 hide：webview 进程组实测占约 80MB，hide 一个字节都不释放；
//! 2. 拦 `ExitRequested{code:None}`：关窗销毁后「最后一个窗口关闭」不应退出应用；
//! 3. `sync_window_visibility` 5s 状态复核：mac 最小化不发窗口事件，只靠事件会漏暂停。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use png::Decoder;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
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

/// 显示主窗口；若它已被销毁（关窗时我们会真的销毁以释放 webview），
/// 则按 `tauri.conf.json` 里的原配置重建。
///
/// **安全前提（已逐条核实，别担心销毁窗口会阻功能）**：
/// - 托盘挂在 app 上（`TrayIconBuilder::build(app)`），不是窗口级；
/// - 桌面通知全走 `handle.notification()`，均为 app 级；
/// - 业务循环（服务、轮询）跑在 tokio runtime（setup 里 spawn），与窗口无关。
fn show_or_create_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        // 窗口本来就存在 → 是从隐藏态恢复，要通知前端恢复动画与轮询。
        let _ = w.emit("app:visibility", true);
        return;
    }
    // 从配置重建，保证尺寸 / 装饰 / 居中等与首次启动完全一致（不手写一份参数，
    // 否则以后改 tauri.conf.json 会两边不同步）。
    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned();
    let Some(cfg) = cfg else {
        log::error!("tauri.conf.json 里找不到 label=main 的窗口配置，无法重建窗口");
        return;
    };
    match tauri::WebviewWindowBuilder::from_config(app, &cfg) {
        // 配置里 visible=false（防启动闪烁），所以重建后需显式 show。
        Ok(builder) => match builder.build() {
            Ok(w) => {
                // 圆角要在 show 前打上，否则能看到一帧直角
                apply_window_decorations(&w);
                let _ = w.show();
                let _ = w.set_focus();
            }
            Err(e) => log::error!("重建主窗口失败: {e}"),
        },
        Err(e) => log::error!("从配置构造窗口 builder 失败: {e}"),
    }
}

/// 给窗口打上平台特异的装饰（目前只有 Win11 DWM 圆角）。
///
/// **为何抽成函数**：启动与重建两条路径共用它，否则关窗再开会从圆角变直角。
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

/// 生成托盘图标：透明底 + 居中状态色圆点（运行绿、停止灰）。
/// 用代码绘制，避免额外打包二进制图标资源。两份图标缓存在 static 中，
/// 仅泄露一次 4KB 数据，后续所有刷新都 clone 复用。
fn build_tray_icon(running: bool) -> tauri::image::Image<'static> {
    const S: u32 = 64;
    // 托盘单独用一枚简化图标：只留「榫接 N」的符号、单色、无底，且整体偏左上，
    // 把右下角让给下面的状态圆点。应用图标是「赤陶圆角 tile + 奶白色 N」，
    // 缩到 16px 后 tile 的圆角和符号之间的缝隙全糊，再加个圆点就成一团了，所以不共用。
    // 符号资源由 design/应用图标-2026-10-28/落地到应用.py 从设计稿导出，与 icons/icon.png 同源。
    const ICON_PNG: &[u8] = include_bytes!("../icons/tray.png");

    // Decode PNG → RGBA pixels
    let decoder = Decoder::new(ICON_PNG);
    let mut reader = match decoder.read_info() {
        Ok(r) => r,
        Err(_) => return fallback_dot(running),
    };
    let info = reader.info();
    let (w, h) = (info.width, info.height);
    let mut src = vec![0u8; (w * h * 4) as usize];
    if reader.next_frame(&mut src).is_err() {
        return fallback_dot(running);
    }

    // Scale to S×S using nearest-neighbor
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    for y in 0..S {
        let sy = (y as f64 * h as f64 / S as f64) as u32;
        for x in 0..S {
            let sx = (x as f64 * w as f64 / S as f64) as u32;
            let si = ((sy * w + sx) * 4) as usize;
            let di = ((y * S + x) * 4) as usize;
            rgba[di..di + 4].copy_from_slice(&src[si..si + 4]);
        }
    }

    // Draw status dot (bottom-right, 8px radius)
    let dot_r = 8i32;
    let dot_cx = S as i32 - dot_r - 1;
    let dot_cy = S as i32 - dot_r - 1;
    let (dr, dg, db) = if running {
        (34, 197, 134)
    } else {
        (148, 163, 184)
    };
    for y in 0..S as i32 {
        for x in 0..S as i32 {
            let dx = x - dot_cx;
            let dy = y - dot_cy;
            if dx * dx + dy * dy <= dot_r * dot_r {
                let idx = ((y as u32 * S + x as u32) * 4) as usize;
                rgba[idx] = dr;
                rgba[idx + 1] = dg;
                rgba[idx + 2] = db;
                rgba[idx + 3] = 255;
            }
        }
    }

    let leaked: &'static [u8] = Box::leak(rgba.into_boxed_slice());
    tauri::image::Image::new(leaked, S, S)
}

fn fallback_dot(running: bool) -> tauri::image::Image<'static> {
    const S: u32 = 64;
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    let (cr, cg, cb) = if running {
        (34, 197, 134)
    } else {
        (148, 163, 184)
    };
    let cx = S as f32 / 2.0;
    let cy = S as f32 / 2.0;
    let r = 18.0;
    for y in 0..S {
        for x in 0..S {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let alpha = if dist <= r - 1.0 {
                255u8
            } else if dist >= r + 1.0 {
                0
            } else {
                let t = (r + 1.0 - dist) / 2.0;
                (t * 255.0) as u8
            };
            let idx = ((y * S + x) * 4) as usize;
            rgba[idx] = cr;
            rgba[idx + 1] = cg;
            rgba[idx + 2] = cb;
            rgba[idx + 3] = alpha;
        }
    }
    let leaked: &'static [u8] = Box::leak(rgba.into_boxed_slice());
    tauri::image::Image::new(leaked, S, S)
}

fn tray_icon(running: bool) -> tauri::image::Image<'static> {
    static ICONS: std::sync::OnceLock<(
        tauri::image::Image<'static>,
        tauri::image::Image<'static>,
    )> = std::sync::OnceLock::new();
    let icons = ICONS.get_or_init(|| (build_tray_icon(true), build_tray_icon(false)));
    (if running { &icons.0 } else { &icons.1 }).clone()
}

/// 托盘状态刷新（带去重）：仅当 running 或 tooltip 文本真正变化时才重设图标/tooltip。
/// 消除网络抖动导致的高频 set_icon 在 Windows 上表现的图标闪烁（同状态重复重设即闪）。
fn refresh_tray(
    tray: &tauri::tray::TrayIcon,
    running: bool,
    tip: &str,
    last: &std::sync::Arc<std::sync::Mutex<(bool, String)>>,
) {
    // 中毒恢复而非 unwrap：持锁线程 panic 过就让托盘状态刷新整个线程跟着 panic，
    // 换来的是图标/tooltip 永久停更——用户看到的是"假死"。PoisonError 只标记
    // "有人中途放手"，数据本身仍一致可用（临界区是一次性的比较+赋值）。
    let mut g = last.lock().unwrap_or_else(|e| e.into_inner());
    if g.0 == running && g.1 == tip {
        return; // 无变化，跳过重设（防高频重绘闪烁）
    }
    let _ = tray.set_icon(Some(tray_icon(running)));
    // 必须在每次 set_icon 后重新声明模板属性：它挂在 NSImage 上（setTemplate:），
    // set_icon 会换一个全新的 NSImage，于是建托盘时 icon_as_template 的设置被抹掉。
    #[cfg(target_os = "macos")]
    let _ = tray.set_icon_as_template(true);
    let _ = tray.set_tooltip(Some(tip));
    *g = (running, tip.to_string());
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
/// **两项必须都查**：只查 `is_minimized()` 会**破坏托盘隐藏暂停**——收进托盘时窗口
/// `is_minimized()` 是 false，会误发 `visibility = true`，把已经暂停的轮询重新打开。
fn sync_window_visibility(handle: &tauri::AppHandle) {
    // 窗口已销毁（「关窗时释放界面内存」打开时的正常路径）→ 没有前端可通知，跳过。
    let Some(w) = handle.get_webview_window("main") else {
        return;
    };
    // 任一成立即视为不可见：收进托盘 / 系统级隐藏应用 → is_visible 为 false；
    // 最小化到 Dock 或任务栏 → is_minimized 为 true。
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
            // 重复启动：把界面唤到前台。窗口可能已被销毁（省内存模式），
            // 所以走 or_create——否则用户双击图标会没任何反应。
            show_or_create_main_window(app);
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
            // 中毒恢复而非 unwrap：同 refresh_tray 的理由——一次 panic 不该让后续
            // 每个 setup 路径都连锁 panic。
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
                // 与重建路径共用同一份装饰逻辑（见 `apply_window_decorations`）
                apply_window_decorations(&window);
                let _ = window.show();
                let _ = window.set_focus();
            }

            // System tray
            let show_item = MenuItem::with_id(app, "show", "打开面板", true, None::<&str>)?;
            let check_update_item =
                MenuItem::with_id(app, "check_update", "检查更新", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &check_update_item, &quit_item])?;

            TrayIconBuilder::with_id("main-tray")
                .tooltip(branding::APP_DISPLAY_NAME)
                .menu(&menu)
                .icon(tray_icon(true))
                // macOS 菜单栏要求**模板图标**：系统只取 alpha 通道、自己上色，以适配
                // 浅色/深色菜单栏与高亮选中态。我们的图标是代码绘制的**彩色状态圆点**，
                // 不声明为 template 在 mac 上会显得很突兀。
                //
                // 注意：只在这里设一次**不够**——`refresh_tray` 里的 `set_icon` 会换掉
                // NSImage、连带抹掉模板属性，那边已补上 `set_icon_as_template(true)`。
                .icon_as_template(cfg!(target_os = "macos"))
                // **必须显式设它**：Tauri 的 `show_menu_on_left_click` 默认为 `true`，
                // 而我们又在 `on_tray_icon_event` 里自己接了左键——于是左键会**同时**
                // 弹菜单（Tauri 默认行为）+ 切换窗口（我们的 handler）。
                //
                // 两个平台惯例相反，所以这里按平台分开：
                // - Windows：左键 = 开/收面板，右键 = 菜单。所以关掉它。
                // - macOS：菜单栏图标的惯例是**左键就开菜单**（右键在菜单栏几乎无人用），
                //   而菜单里已经有「打开面板」，所以保留 true，并在 handler 里跳过左键 toggle。
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_tray_icon_event(move |tray_app, event| {
                    // mac 上左键已由系统用于展开菜单，不再额外 toggle 窗口；
                    #[cfg(target_os = "macos")]
                    let _ = (tray_app, &event);
                    // 左键抬起：toggle 主窗口显隐（右键由 menu 接管）
                    #[cfg(not(target_os = "macos"))]
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        match tray_app.app_handle().get_webview_window("main") {
                            Some(w) if w.is_visible().unwrap_or(false) => {
                                // 收起：走正常关闭流程，由 `CloseRequested` 根据
                                // 「关窗时释放界面内存」开关决定销毁还是仅隐藏——
                                // 判断只写在一处，这里不重复。
                                let _ = w.close();
                            }
                            // 窗口存在但不可见（秒开模式隐藏态，或最小化）→ 恢复；
                            // 窗口已被销毁（省内存模式）→ 重建。两种情况同一个入口。
                            _ => show_or_create_main_window(tray_app.app_handle()),
                        }
                    }
                })
                .on_menu_event(move |tray_app, event| match event.id.as_ref() {
                    "show" => show_or_create_main_window(tray_app.app_handle()),
                    "check_update" => {
                        // 托盘直接触发后端更新任务（不依赖前端 webview 是否活着）。
                        // 状态由 update:* 事件推给前端；webview 不在时任务是孤儿但仍会
                        // 下载安装（安装由插件在 Rust 侧完成，与前端无关）。
                        commands::start_update(tray_app.app_handle().clone());
                    }
                    "quit" => {
                        tray_app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let tray_last: std::sync::Arc<std::sync::Mutex<(bool, String)>> =
                std::sync::Arc::new(std::sync::Mutex::new((
                    true,
                    branding::APP_DISPLAY_NAME.to_string(),
                )));
            {
                // 后台任务够着 AppHandle 的范式：setup 里克隆一份 move 进去
                //（不要在 AppState 里存 AppHandle——setup 之前它还不存在）。
                let bg_handle = app.handle().clone();
                let last = tray_last.clone();
                // 窗口可见性 5s 状态复核（mac 最小化不发窗口事件的兜底，见函数注释）。
                // G1 范式：套 spawn_supervised，panic 后自愈重启而非永久静默停止。
                spawn_supervised("窗口可见性复核", move || {
                    let bg = bg_handle.clone();
                    let last = last.clone();
                    Box::pin(async move {
                        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
                        loop {
                            ticker.tick().await;
                            sync_window_visibility(&bg);
                            // 业务应用把「刷新托盘状态」也放这里（承自 cc-bridge 的
                            // refresh_and_report_ip_change），本壳子无业务状态，
                            // 只保留去重刷新的调用范式。
                            if let Some(tray) = bg.tray_by_id("main-tray") {
                                refresh_tray(&tray, true, &branding::tray_tip_running(), &last);
                            }
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
            // 数据库只读查询（M7）
            commands::db_defaults,
            commands::db_connect,
            commands::db_query,
            commands::db_tables,
            commands::db_disconnect,
            // 表结构缓存 + 出包前核对（M7 第三条）
            commands::db_schema_status,
            commands::db_schema_sync,
            commands::db_columns,
            commands::db_cached_tables,
            commands::db_check_sources,
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // 读「关窗时释放界面内存」开关。同步回调里不能 await，所以用 try_read；
                // 拿不到锁（仅当恰有写者持锁，极罕见）时按配置默认值 true 处理。
                // 为何不用 AtomicBool 镜像：配置写入点可能有多处，逐处同步镜像容易漏；
                // 直接读配置才是单一事实源。
                let release = window
                    .app_handle()
                    .state::<Arc<AppState>>()
                    .config
                    .try_read()
                    .map(|c| c.release_webview_on_close)
                    .unwrap_or(true);
                if release {
                    // 省内存模式：**不** prevent_close；让窗口连同 webview 一起销毁，
                    // 释放约 80MB。应用不会退出——下面 `RunEvent::ExitRequested` 里拦住了
                    // 「最后一个窗口关闭」引发的退出。需要界面时由托盘重建。
                } else {
                    // 秒开模式：仅隐藏，webview 保留，所以要通知前端暂停动画与轮询。
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit("app:visibility", false);
                }
            }
            // OS 级最小化 / 还原。**仅 Windows 有效**——mac 上最小化到 Dock 尺寸不变，
            // tao 不会发 `Resized`，详见 `sync_window_visibility` 头注释。
            // 1. Windows 上最小化只会触发 `Resized`，Tauri 没有独立的 Minimized 事件；
            // 2. WebView2 在宿主窗口最小化时**不发** visibilitychange（实测最小化前后
            //    webview CPU 几乎没降），所以前端的 `document.hidden` 兜底拿不到信号。
            // 不处理的后果：暂停动画只在「收进托盘」路径生效，最小化照旧烧 CPU。
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
            // 只有 macOS 分支用得上 app_handle，其它平台不能让它变成未使用参数
            // （clippy 带 -D warnings）。
            #[cfg(not(target_os = "macos"))]
            let _ = app_handle;
            // macOS：点 Dock 图标。
            //
            // 不处理的后果：窗口是真被销毁的，Dock 上图标还在但点下去什么都不发生——
            // 用户只能从菜单栏图标唤回，而他很可能以为应用已经死了。
            //
            // `has_visible_windows` 为 true 时不管：系统自己会把窗口提到前面。
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                show_or_create_main_window(app_handle);
                return;
            }
            // 关掉最后一个窗口**不应**退出应用。
            //
            // Tauri 默认行为是“所有窗口关闭 → 退出进程”，而本壳子是常驻托盘应用：
            // 关窗会真的销毁窗口，若不拦住这里，应用会跟着退出。
            //
            // 只拦 `code: None`：那是“窗口全关”触发的退出。托盘菜单「退出」走的是
            // `tray_app.exit(0)`，会带 `code: Some(0)`，不在此列，因此真退出仍然正常。
            if let tauri::RunEvent::ExitRequested { code: None, ref api, .. } = event {
                api.prevent_exit();
            }
            // 真退出时杀掉 jdt.ls，不留孤儿 Java 进程
            if let tauri::RunEvent::Exit = event {
                if let Some(st) = app_handle.try_state::<std::sync::Arc<AppState>>() {
                    let session = st.lang.lock().unwrap_or_else(|e| e.into_inner()).session.take();
                    if let Some(s) = session {
                        s.client.kill();
                    }
                }
            }
        });

    Ok(())
}
