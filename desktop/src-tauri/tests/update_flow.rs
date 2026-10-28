//! 更新链路集成测试：本地 HTTP 假源跑通「检查 → 下载 → 验签失败」。
//!
//! 为什么值得写（对应 cc-bridge 更新测试指南 §6 的缺口）：这条链路此前零自动化
//! 覆盖，全靠人工点 UI；而 UI 取证依赖「屏幕解锁 + 窗口置顶」，锁屏机器上整条
//! 链路无法验证。本测试用 std::net::TcpListener 起一个一次性本地源，直接驱动
//! check_update / start_update 两个命令，断言事件序列与错误码，全程无头，
//! CI 也能跑。
//!
//! 为什么放在 tests/ 而不是 src 里的 #[cfg(test)] mod tests：
//! 本测试构建 mock 应用会把 wry 运行时的原生对话框代码链进测试二进制，
//! 导入表含 comctl32.dll!TaskDialogIndirect（仅 comctl32 v6 有）。
//! build.rs 用 cargo:rustc-link-arg-tests 给测试目标补嵌 comctl32 v6
//! manifest——但该指令只作用于 tests/ 下的集成测试目标，不覆盖
//! `cargo test --lib` 的 lib 测试二进制（cargo 会拒绝/不应用，
//! 详见 build.rs 长注释）。放错目录 = 二进制启动即 0xc0000139。
//!
//! 依赖说明：`cargo test --release` 时 debug_assertions 关闭，插件会拒绝 http
//! 更新源，需要 tauri.conf.json 的 plugins.updater.dangerousInsecureTransportProtocol
//! = true（本地联调开关，见 scripts/fake-update-server.mjs 头注）。debug 两者皆可。

use nc_forge::commands::{check_update, start_update};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};
use tauri::test::mock_builder;
use tauri::Listener;

/// 起一个一次性 HTTP 更新源，返回端口。`manifest_for_port` 延迟到端口分配后
/// 再生成 manifest（URL 里要嵌端口）。最多服务 10 个连接：check 一次 manifest、
/// start_update 内复查一次 manifest、验签失败最多重试 3 次安装包，之后监听
/// 线程自行退出。
fn spawn_local_update_source<F>(manifest_for_port: F, artifact: Vec<u8>, artifact_path: &str) -> u16
where
    F: FnOnce(u16) -> String,
{
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定临时端口失败");
    let port = listener.local_addr().expect("读取临时端口失败").port();
    let manifest = manifest_for_port(port);
    let artifact_path = artifact_path.to_string();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(10) {
            let Ok(mut stream) = stream else { break };
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .ok();
            let mut reader = BufReader::new(match stream.try_clone() {
                Ok(s) => s,
                Err(_) => continue,
            });
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }
            // 读完剩余请求头（空行即结束）
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) if line.trim().is_empty() => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let path = request_line
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .to_string();
            let body: Vec<u8> = if path == "/updater.json" {
                manifest.clone().into_bytes()
            } else if path == artifact_path {
                artifact.clone()
            } else {
                b"not found".to_vec()
            };
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
            let _ = stream.flush();
        }
    });
    port
}

#[test]
fn local_http_source_drives_check_download_and_signature_failure() {
    // mock 应用 + 真实 tauri.conf.json（pubkey / endpoints / http 允许均从那里读）。
    // build_updater 依赖 updater 插件初始化时插入的 UpdaterState，必须注册插件。
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(tauri::generate_context!())
        .expect("mock 应用构建失败");

    // manifest 版本 = 当前版本 patch+1：保证「有更新」且不写死
    // （真实版本变化后测试依然成立，不会静默失效）。
    let v = app.package_info().version.clone();
    let next_version = format!("{}.{}.{}", v.major, v.minor, v.patch + 1);
    let artifact_path = format!("/shell-fake_{next_version}_x64-setup.exe");

    // 假签名：合法 base64、内容乱码 ⇒ 下载完成即验签失败 ⇒ 走不到安装，
    // 对测试进程安全（不会 process::exit，也不会拉起安装器）。
    let fake_sig = "ZmFrZS1zaWduYXR1cmUtZm9yLXVwZGF0ZXItdGVzdA==";
    // 假安装包：64KB 确定性字节（内容无所谓，反正验签必失败）。
    let artifact: Vec<u8> = (0..65_536u32).map(|i| (i % 251) as u8).collect();

    // manifest 的平台键必须与当前编译目标一致：updater 未显式指定 target 时，
    // 依次在 platforms 里找 `{os}-{arch}-{installer}` 和 `{os}-{arch}`
    // （见插件 get_urls 的回退列表）。写死 windows-x86_64 会让 macOS 直接
    // TargetsNotFound（2026-10-28 CI 实测）。target() 返回的正是 `{os}-{arch}`，
    // 必然命中第二顺位；生产 updater.json 的 macOS 键也是 darwin-aarch64
    // （generate-updater-json.mjs），与这里一致。
    let platform_key = tauri_plugin_updater::target().expect("当前平台应能推出 updater target");

    let port = spawn_local_update_source(
        |port| {
            format!(
                concat!(
                    r#"{{"version":"{v}","notes":"本地集成测试","pub_date":"2026-10-27T00:00:00Z","#,
                    r#""platforms":{{"{pk}":{{"signature":"{sig}","#,
                    r#""url":"http://127.0.0.1:{port}{path}"}}}}}}"#
                ),
                v = next_version,
                sig = fake_sig,
                pk = platform_key,
                port = port,
                path = artifact_path,
            )
        },
        artifact,
        &artifact_path,
    );

    // 命令从进程环境读端点（resolve_update_endpoints），测完清掉避免影响其它测试。
    std::env::set_var(
        "APP_UPDATE_ENDPOINT",
        format!("http://127.0.0.1:{port}/updater.json"),
    );

    // 订阅全部更新事件，按 (事件名, payload) 收集。
    let (tx, rx) = channel::<(String, String)>();
    for name in [
        "update:checking",
        "update:available",
        "update:downloading",
        "update:progress",
        "update:ready",
        "update:error",
        "update:uptodate",
    ] {
        let tx = tx.clone();
        let name = name.to_string();
        app.listen(name.clone(), move |event| {
            let _ = tx.send((name.clone(), event.payload().to_string()));
        });
    }

    // 第一跳：只检查 ⇒ 应收到 available 且版本为 next_version。
    check_update(app.handle().clone());
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut saw_available = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok((name, payload)) => match name.as_str() {
                "update:available" => {
                    assert!(
                        payload.contains(&format!("\"version\":\"{next_version}\"")),
                        "available 事件应携带新版本 {next_version}: {payload}"
                    );
                    saw_available = true;
                    break;
                }
                "update:error" => panic!("检查链路不应失败: {payload}"),
                _ => {}
            },
            Err(_) => break,
        }
    }
    assert!(saw_available, "未收到 update:available（检查链路断裂）");

    // 第二跳：下载 + 安装。假签名 ⇒ 重试 3 次后发 error{signature}。
    // ready 绝不该出现（2026-10-18 假签名实测抓到的回归点）。
    start_update(app.handle().clone());
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut saw_downloading = false;
    let mut saw_progress = false;
    let mut saw_signature_error = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok((name, payload)) => match name.as_str() {
                // start_update 内部会复查，重复发这两个属预期
                "update:checking" | "update:available" => {}
                "update:downloading" => saw_downloading = true,
                "update:progress" => saw_progress = true,
                "update:ready" => panic!("假签名不应走到 ready: {payload}"),
                "update:error" => {
                    assert!(
                        payload.contains("\"code\":\"signature\""),
                        "验签失败应归类为 signature: {payload}"
                    );
                    saw_signature_error = true;
                    break;
                }
                _ => {}
            },
            Err(_) => break,
        }
    }
    std::env::remove_var("APP_UPDATE_ENDPOINT");
    assert!(saw_downloading, "未收到 update:downloading（下载链路断裂）");
    assert!(saw_progress, "未收到 update:progress（进度事件断裂）");
    assert!(
        saw_signature_error,
        "未收到验签失败的 update:error{{signature}}"
    );
}
