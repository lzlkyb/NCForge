//! 资源包链路集成测试：本地 HTTP 假源跑通「拉清单 → 下载 → 校验 → 原子安装」，
//! 以及三个失败/容错模式：SHA-256 不符、zip-slip 投毒、换源后续传。
//!
//! 与 `update_flow.rs` 同款范式：std::net::TcpListener 起一次性本地源，mock 应用
//! 直接驱动命令，断言事件序列与落盘结果，全程无头。放 tests/ 而非 src 内
//! #[cfg(test)] 的缘故同 update_flow（comctl32 v6 manifest，见 build.rs 长注释）。
//!
//! 🔴 四个场景必须在**同一个** #[test] 里串行跑：端点经环境变量
//! APP_RESOURCES_ENDPOINT 注入，而 env 是进程级全局的——并行测试会互相抢。
//! update_flow 用 APP_UPDATE_ENDPOINT（另一个变量），与本文件无交叉。

use nc_forge::commands::ensure_resources_async;
use nc_forge::resource_pack::{external_root, pack_dir, PacksState, PACK_ECJ};
use nc_forge::state::AppState;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};
use tauri::test::mock_builder;
use tauri::Listener;
use tauri::Manager;

/// 一次性 HTTP 资源源：`/resources.json` 返回清单，`/packs/<name>` 返回包字节。
/// 端口由内核分配，返回前 URL 里的占位已由调用方填好（manifest 延迟生成）。
fn spawn_local_source(manifest: String, packs: Vec<(String, Vec<u8>)>) -> u16 {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定临时端口失败");
    let port = listener.local_addr().expect("读取临时端口失败").port();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(20) {
            let Ok(mut stream) = stream else { break };
            stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
            let mut reader = BufReader::new(match stream.try_clone() {
                Ok(s) => s,
                Err(_) => continue,
            });
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) if line.trim().is_empty() => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let path = request_line.split_whitespace().nth(1).unwrap_or("").to_string();
            let body: Vec<u8> = if path == "/resources.json" {
                manifest.clone().into_bytes()
            } else if let Some(name) = path.strip_prefix("/packs/") {
                packs
                    .iter()
                    .find(|(n, _)| n == name)
                    .map(|(_, b)| b.clone())
                    .unwrap_or_else(|| b"not found".to_vec())
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

/// 造一个合法 ecj 包 zip（含 ecj-3.17.jar，探针能过）。
fn ecj_pack_zip() -> Vec<u8> {
    let mut buf = Vec::new();
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let opts: zip::write::SimpleFileOptions = Default::default();
    w.start_file("ecj-3.17.jar", opts).unwrap();
    std::io::Write::write_all(&mut w, b"fake-jar-bytes").unwrap();
    w.finish().unwrap();
    buf
}

/// 造一个带 ../ 逃逸条目的投毒 zip（sha 由调用方按内容算，下载校验能过，
/// 把投毒点完全集中在解压环节）。
fn zipslip_pack_zip() -> Vec<u8> {
    let mut buf = Vec::new();
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let opts: zip::write::SimpleFileOptions = Default::default();
    w.start_file("ecj-3.17.jar", opts).unwrap();
    std::io::Write::write_all(&mut w, b"fake-jar-bytes").unwrap();
    w.start_file("../escape.txt", opts).unwrap();
    std::io::Write::write_all(&mut w, b"evil").unwrap();
    w.finish().unwrap();
    buf
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;
    let mut h = Sha256::new();
    h.update(bytes);
    let mut s = String::new();
    for b in h.finalize() {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn manifest_json(port: u16, version: &str, sha: &str, size: u64) -> String {
    format!(
        r#"{{"packs":[{{"id":"ecj","version":"{version}","title":"Java 编译器","notes":"编译 NC 模块","size":{size},"sha256":"{sha}","url":"http://127.0.0.1:{port}/packs/ecj.zip"}}]}}"#
    )
}

/// 起一个带 AppState 的 mock 应用，返回 (app, config_dir)。
fn mock_app(tag: &str) -> (tauri::App<tauri::test::MockRuntime>, std::path::PathBuf) {
    let config_dir = std::env::temp_dir().join(format!("ncforge-rp-it-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&config_dir).unwrap();
    let app = mock_builder()
        .build(tauri::generate_context!())
        .expect("mock 应用构建失败");
    app.manage(AppState::new(
        nc_forge::config::AppConfig::default(),
        config_dir.clone(),
    ));
    (app, config_dir)
}

/// 注册全部 resource:* 监听（同步注册，范式同 update_flow），返回接收端。
fn watch(app: &tauri::App<tauri::test::MockRuntime>) -> Receiver<(String, String)> {
    let (tx, rx) = channel::<(String, String)>();
    for name in [
        "resource:checking",
        "resource:available",
        "resource:uptodate",
        "resource:downloading",
        "resource:progress",
        "resource:installed",
        "resource:ready",
        "resource:error",
    ] {
        let tx = tx.clone();
        let name = name.to_string();
        app.listen(name.clone(), move |event| {
            let _ = tx.send((name.clone(), event.payload().to_string()));
        });
    }
    rx
}

/// 等到 `until` 事件或超时，返回按序收集到的全部事件。
fn wait_until(rx: &Receiver<(String, String)>, until: &str, timeout: Duration) -> Vec<(String, String)> {
    let deadline = Instant::now() + timeout;
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(ev) => {
                let is_target = ev.0 == until;
                seen.push(ev);
                if is_target {
                    break;
                }
            }
            Err(_) => continue,
        }
    }
    seen
}

fn names(events: &[(String, String)]) -> Vec<&str> {
    events.iter().map(|(n, _)| n.as_str()).collect()
}

#[test]
fn local_source_drives_install_failures_and_failover() {
    // ─── 场景 1：正常全链路 ───
    let zip = ecj_pack_zip();
    let zip_len = zip.len() as u64;
    let sha = sha256_hex(&zip);
    let version = sha[..12].to_string();
    let port = spawn_local_source(
        manifest_json(0, &version, &sha, zip_len),
        vec![("ecj.zip".to_string(), zip)],
    );
    // 端口已分配，用带正确端口的清单重起一个源（第一个没人请求，自然空转回收）。
    let port2 = spawn_local_source(
        manifest_json(port, &version, &sha, zip_len),
        vec![("ecj.zip".to_string(), ecj_pack_zip())],
    );
    std::env::set_var(
        "APP_RESOURCES_ENDPOINT",
        format!("http://127.0.0.1:{port2}/resources.json"),
    );

    let (app, config_dir) = mock_app("happy");
    let rx = watch(&app);
    ensure_resources_async(app.handle().clone(), false);
    let events = wait_until(&rx, "resource:ready", Duration::from_secs(30));
    let seen = names(&events);

    for expected in [
        "resource:checking",
        "resource:available",
        "resource:downloading",
        "resource:installed",
        "resource:ready",
    ] {
        assert!(seen.contains(&expected), "事件序列缺少 {expected}: {seen:?}");
    }
    // available 应带包清单与总大小
    let available = events.iter().find(|(n, _)| n == "resource:available").unwrap();
    assert!(available.1.contains("\"id\":\"ecj\""), "available 应带 ecj: {}", available.1);
    assert!(available.1.contains("\"totalBytes\""), "available 应带总字节: {}", available.1);

    // 落盘核对：版本目录 + 内容 + state
    let dir = pack_dir(&config_dir, PACK_ECJ, &version);
    assert!(dir.join("ecj-3.17.jar").is_file(), "包应解压到 {dir:?}");
    let st = PacksState::load(&config_dir);
    let rec = st.packs.get(PACK_ECJ).expect("state 应记录 ecj");
    assert_eq!(rec.version, version);
    assert!(!rec.legacy);

    // 幂等：再跑一次应直接 uptodate（不重下）
    let rx2 = watch(&app);
    ensure_resources_async(app.handle().clone(), false);
    let events2 = wait_until(&rx2, "resource:uptodate", Duration::from_secs(30));
    assert!(
        names(&events2).contains(&"resource:uptodate"),
        "第二次 ensure 应命中 uptodate: {:?}",
        names(&events2)
    );

    // ─── 场景 2：SHA-256 不符 ⇒ error(signature)，且不落任何包 ───
    let (app2, config_dir2) = mock_app("badsha");
    let bad_port = spawn_local_source(
        manifest_json(0, "v1", &"0".repeat(64), 100),
        vec![("ecj.zip".to_string(), ecj_pack_zip())],
    );
    let bad_port2 = spawn_local_source(
        manifest_json(bad_port, "v1", &"0".repeat(64), 100),
        vec![("ecj.zip".to_string(), ecj_pack_zip())],
    );
    std::env::set_var(
        "APP_RESOURCES_ENDPOINT",
        format!("http://127.0.0.1:{bad_port2}/resources.json"),
    );
    let rx2 = watch(&app2);
    ensure_resources_async(app2.handle().clone(), false);
    // ensure 内部对下载重试 2 次（1s+2s 退避）才报错，给足超时
    let events2 = wait_until(&rx2, "resource:error", Duration::from_secs(30));
    let err = events2
        .iter()
        .find(|(n, _)| n == "resource:error")
        .unwrap_or_else(|| panic!("坏 sha 应触发 resource:error: {:?}", names(&events2)));
    assert!(
        err.1.contains("\"signature\""),
        "错误码应为 signature: {}",
        err.1
    );
    let st2 = PacksState::load(&config_dir2);
    assert!(
        !st2.packs.contains_key(PACK_ECJ),
        "SHA-256 不符的包不得记为已安装: {:?}",
        st2.packs
    );
    assert!(
        !external_root(&config_dir2).join("ecj@v1").exists(),
        "坏包不得留下版本目录"
    );

    // ─── 场景 3：zip-slip 投毒（sha 正确）⇒ error(corrupt)，恶意文件不逃逸 ───
    let (app3, config_dir3) = mock_app("zipslip");
    let evil = zipslip_pack_zip();
    let evil_sha = sha256_hex(&evil);
    let evil_version = evil_sha[..12].to_string();
    let evil_port = spawn_local_source(
        manifest_json(0, &evil_version, &evil_sha, evil.len() as u64),
        vec![("ecj.zip".to_string(), evil.clone())],
    );
    let evil_port2 = spawn_local_source(
        manifest_json(evil_port, &evil_version, &evil_sha, evil.len() as u64),
        vec![("ecj.zip".to_string(), evil)],
    );
    std::env::set_var(
        "APP_RESOURCES_ENDPOINT",
        format!("http://127.0.0.1:{evil_port2}/resources.json"),
    );
    let rx3 = watch(&app3);
    ensure_resources_async(app3.handle().clone(), false);
    let events3 = wait_until(&rx3, "resource:error", Duration::from_secs(30));
    let err3 = events3
        .iter()
        .find(|(n, _)| n == "resource:error")
        .unwrap_or_else(|| panic!("投毒包应触发 resource:error: {:?}", names(&events3)));
    assert!(
        err3.1.contains("\"corrupt\""),
        "错误码应为 corrupt: {}",
        err3.1
    );
    // 逃逸文件一个都不能有（解压目标在 config_dir3/resources/.tmp-* 里，
    // 逃逸目标是 config_dir3/escape.txt）
    assert!(
        !config_dir3.join("escape.txt").exists(),
        "zip-slip 条目逃逸出了资源根"
    );
    let leaked = std::fs::read_dir(external_root(&config_dir3))
        .map(|d| {
            d.filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().starts_with("ecj@"))
        })
        .unwrap_or(false);
    assert!(!leaked, "投毒包不应留下任何版本目录");

    // ─── 场景 4：源 1 的包 sha 不符 ⇒ 换源 2 装好（端点故障转移 + 断点续传） ───
    // ensure_packs 对单个包的下载重试 2 次（1s+2s 退避）后换下一个源；
    // 已装好的包记在 state 里，换源后自动跳过。这里验证「换源后从源 2
    // 拿到正确的包」——装上的必须是源 2 的版本，不是源 1 清单里的坏版本。
    let (app4, config_dir4) = mock_app("failover");
    let good = ecj_pack_zip();
    let good_sha = sha256_hex(&good);
    let good_version = good_sha[..12].to_string();
    let bad_sha = "0".repeat(64);
    // 每个源都先起一个占位监听拿端口，再用真端口起一个（清单里的包 URL 才有效）
    let bad_p1 = spawn_local_source(
        manifest_json(0, "badver000001", &bad_sha, good.len() as u64),
        vec![("ecj.zip".to_string(), good.clone())],
    );
    let good_p1 = spawn_local_source(
        manifest_json(0, &good_version, &good_sha, good.len() as u64),
        vec![("ecj.zip".to_string(), good.clone())],
    );
    let bad_p2 = spawn_local_source(
        manifest_json(bad_p1, "badver000001", &bad_sha, good.len() as u64),
        vec![("ecj.zip".to_string(), good.clone())],
    );
    let good_p2 = spawn_local_source(
        manifest_json(good_p1, &good_version, &good_sha, good.len() as u64),
        vec![("ecj.zip".to_string(), good)],
    );
    std::env::set_var(
        "APP_RESOURCES_ENDPOINT",
        format!("http://127.0.0.1:{bad_p2}/resources.json,http://127.0.0.1:{good_p2}/resources.json"),
    );
    let rx4 = watch(&app4);
    ensure_resources_async(app4.handle().clone(), false);
    // 源 1 下载失败重试 2 次（1s+2s 退避）+ 源 2 下载安装，给足超时
    let events4 = wait_until(&rx4, "resource:ready", Duration::from_secs(45));
    let seen4 = names(&events4);
    assert!(seen4.contains(&"resource:ready"), "换源后应能装完: {seen4:?}");
    assert!(
        !seen4.contains(&"resource:error"),
        "有可用源就不该报全局失败: {seen4:?}"
    );
    // 装上的必须是源 2 的版本（内容寻址），不是源 1 清单里的坏版本
    let dir4 = pack_dir(&config_dir4, PACK_ECJ, &good_version);
    assert!(dir4.join("ecj-3.17.jar").is_file(), "应从源 2 装好: {dir4:?}");
    assert!(
        !external_root(&config_dir4).join("ecj@badver000001").exists(),
        "坏版本的目录不该存在"
    );
    let st4 = PacksState::load(&config_dir4);
    assert_eq!(
        st4.packs.get(PACK_ECJ).map(|r| r.version.as_str()),
        Some(good_version.as_str()),
        "state 应记源 2 的版本: {:?}",
        st4.packs
    );

    std::env::remove_var("APP_RESOURCES_ENDPOINT");
    for d in [&config_dir, &config_dir2, &config_dir3, &config_dir4] {
        std::fs::remove_dir_all(d).ok();
    }
}
