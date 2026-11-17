//! 一键诊断包：把「排障需要的东西」打成一个 zip，让用户 30 秒内能把它发出来。
//!
//! 🔴 为什么值得做：用户遇到问题时能给的只有「刚点了一下就没了」。IDEA 的
//! `Help › Collect Logs and Diagnostic Data` 是行业基准，我们的用户就是从那儿过来的。
//!
//! 🔴 **这是新的数据外泄面**，所以三条硬约束写死在代码里，改动前请先读完：
//! 1. **白名单，不是黑名单**。本文件只列举「打包什么」，绝不遍历目录后再排除。
//!    黑名单的典型失败是「新增一种日志忘了加排除」，而白名单的失败只是「少打一份」。
//! 2. **脱敏在生成侧，不在展示侧**。`state.json` 由 [`sanitize_ui`] 从固定字段重建，
//!    前端传什么额外键都会被丢掉——不依赖前端自觉。
//! 3. **路径只留哈希与末级目录名**。工程全路径可能带客户名、项目代号。
//!
//! 打包前必须由界面逐项展示并让用户确认（`diagnostics_preview` → 用户勾选 →
//! `export_diagnostics`），不偷偷打包。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;

/// 日志源白名单。`in_zip` 是包内路径，`file` 是相对 `config_dir` 的真实路径。
pub struct LogSource {
    pub in_zip: &'static str,
    pub file: &'static str,
    pub label: &'static str,
}

/// 显式列举，顺序即包内顺序。**加新日志类型时只该改这里**（`plan` 与 `collect`
/// 都从这份表走，不会出现「预览列了、打包没打」的漂移）。
pub const LOG_SOURCES: &[LogSource] = &[
    LogSource {
        in_zip: "logs/frontend.log",
        file: "logs/frontend.log",
        label: "界面错误记录",
    },
    LogSource {
        in_zip: "logs/frontend.log.1",
        file: "logs/frontend.log.1",
        label: "界面错误记录（上一份）",
    },
    LogSource {
        in_zip: "logs/client.log",
        file: "logs/client.log",
        label: "NC 客户端输出",
    },
    LogSource {
        in_zip: "logs/client.log.1",
        file: "logs/client.log.1",
        label: "NC 客户端输出（上一份）",
    },
    LogSource {
        in_zip: "logs/middleware.log",
        file: "logs/middleware.log",
        label: "中间件输出",
    },
    LogSource {
        in_zip: "logs/middleware.log.1",
        file: "logs/middleware.log.1",
        label: "中间件输出（上一份）",
    },
    LogSource {
        in_zip: "crashes/rust-panic.log",
        file: "logs/rust-panic.log",
        label: "后端崩溃记录",
    },
    LogSource {
        in_zip: "crashes/rust-panic.log.1",
        file: "logs/rust-panic.log.1",
        label: "后端崩溃记录（上一份）",
    },
];

/// 自动生成、不来自磁盘的条目。预览时必须一起列出来，否则用户不知道包里还有这些。
pub const GENERATED: &[(&str, &str)] = &[
    ("meta.json", "版本 / 系统 / 启动耗时"),
    ("state.json", "界面档位与会话概况（已脱敏）"),
    ("manifest.txt", "包内文件清单"),
    ("README.txt", "说明：有什么、没有什么、发给谁"),
];

const README: &str = "\
NCForge 诊断包
==============

这个压缩包里只有排障需要的信息，**不含**：
  · 数据库密码、连接串、账号
  · 源码内容、工程文件正文
  · 任何网络请求内容

里面的东西：
  meta.json      版本、操作系统、启动各阶段耗时
  state.json     界面档位（密度/外观/主题）、打开的标签数、
                 工程路径的哈希与末级目录名
  logs/          应用日志（界面错误、NC 客户端输出、中间件输出）
  crashes/       后端崩溃记录（含调用栈）
  manifest.txt   这份清单
  README.txt     本文件

日志里可能包含文件路径与 SQL 片段。发送给他人之前，建议自己先解压看一眼。
";

/// 前端上报的界面概况。**只认这几个字段**，多余的键在 [`sanitize_ui`] 里被丢弃。
///
/// 🔴 刻意**不含** `workspaceRoot`：工作区路径后端自己就知道（`config.workspace_root`），
/// 让前端传等于给「多传一个键就能带出敏感信息」留口子。凡是后端已知的信息都不从前端收。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSnapshot {
    pub density: Option<String>,
    pub appearance: Option<String>,
    pub theme: Option<String>,
    pub open_tabs: Option<u32>,
    pub webview: Option<String>,
}

/// 预览条目：给确认页用，不含内容。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub path: String,
    pub label: String,
    /// 0 = 自动生成（内容在导出时才产生）。
    pub bytes: u64,
    /// 源文件是否存在。不存在时界面标灰，而不是假装有。
    pub present: bool,
}

/// 只 stat，不读内容。确认页打开时不该把 6 份日志全读进内存。
///
/// 🔴 条目顺序必须与 [`collect`] 完全一致（同一个 zip 里顺序不同会让「预览 12 项、
/// 实际 12 项但换了个序」这种漂移逃过测试）。
pub fn plan(config_dir: &Path) -> Vec<PlanItem> {
    let generated = |path: &'static str| PlanItem {
        path: path.to_string(),
        label: generated_label(path).to_string(),
        bytes: 0,
        present: true,
    };
    let mut items = vec![generated("meta.json"), generated("state.json")];
    for src in LOG_SOURCES {
        let meta = fs::metadata(config_dir.join(src.file)).ok();
        items.push(PlanItem {
            path: src.in_zip.to_string(),
            label: src.label.to_string(),
            bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            present: meta.is_some(),
        });
    }
    items.push(generated("README.txt"));
    items.push(generated("manifest.txt"));
    items
}

fn generated_label(path: &str) -> &'static str {
    GENERATED
        .iter()
        .find(|(p, _)| *p == path)
        .map(|(_, label)| *label)
        .unwrap_or("自动生成")
}

/// 收集并打包。`include` 为 `None` 时全打；给了就只打其中的（且必须在白名单内，
/// 越权项静默忽略而不是报错——前端传错不该让整个导出失败）。
pub fn collect(
    config_dir: &Path,
    ui: &UiSnapshot,
    include: Option<&[String]>,
) -> Vec<(String, Vec<u8>)> {
    let allowed =
        |path: &str| -> bool { include.is_none_or(|list| list.iter().any(|p| p.as_str() == path)) };
    let mut out: Vec<(String, Vec<u8>)> = Vec::new();

    if allowed("meta.json") {
        out.push(("meta.json".into(), meta_json().into_bytes()));
    }
    if allowed("state.json") {
        out.push(("state.json".into(), state_json(config_dir, ui).into_bytes()));
    }
    for src in LOG_SOURCES {
        if !allowed(src.in_zip) {
            continue;
        }
        // 🔴 只读白名单里这一条，不 read_dir：目录里多出来的东西永远进不了包。
        if let Ok(bytes) = fs::read(config_dir.join(src.file)) {
            out.push((src.in_zip.to_string(), bytes));
        }
    }
    if allowed("README.txt") {
        out.push(("README.txt".into(), README.as_bytes().to_vec()));
    }
    if allowed("manifest.txt") {
        out.push(("manifest.txt".into(), manifest_text(&out).into_bytes()));
    }
    out
}

/// 包内清单由**实际打进去的条目**生成，不是由白名单猜——否则清单会说明不存在的东西。
pub fn manifest_text(entries: &[(String, Vec<u8>)]) -> String {
    let mut out = format!(
        "NCForge 诊断包清单\n生成时间(unix ms)：{}\n条目数：{}\n\n",
        crate::crash::now_ms(),
        entries.len()
    );
    for (path, bytes) in entries {
        // manifest 自己还没进 entries，行内不会出现自我引用。
        out.push_str(&format!("  {:<28} {:>9} 字节\n", path, bytes.len()));
    }
    out
}

/// 元信息。启动耗时来自 `boot_timing::snapshot()`，不是从日志正则抠。
pub fn meta_json() -> String {
    let boot = crate::boot_timing::snapshot();
    let stages: serde_json::Map<String, serde_json::Value> = boot
        .stages
        .iter()
        .map(|(name, ms)| ((*name).to_string(), serde_json::json!(ms)))
        .collect();
    serde_json::json!({
        "app": "NCForge",
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "generatedAtMs": crate::crash::now_ms(),
        "boot": {
            "firstFrameMs": boot.first_frame_ms,
            "stages": stages,
        },
    })
    .to_string()
}

/// 会话概况。**从固定字段重建**，前端多传的键一律丢弃。
pub fn state_json(config_dir: &Path, ui: &UiSnapshot) -> String {
    let mut value = sanitize_ui(ui);
    if let Some(prev) = crate::crash::previous_run() {
        value["previousRun"] = serde_json::json!({
            "crashed": prev.had_panic,
            "startedAtMs": prev.started_at_ms,
        });
    }
    // 工作区只报「有没有」+ 哈希 + 末级目录名，全路径不出去。
    let config = crate::config::load_config(config_dir);
    value["workspace"] = match config.workspace_root.as_deref() {
        Some(root) => {
            let (hash, tail) = sanitize_path(root);
            serde_json::json!({ "hash": hash, "tail": tail })
        }
        None => serde_json::Value::Null,
    };
    value.to_string()
}

/// 白名单式脱敏：只挑已知字段，且值必须在已知集合内。
pub fn sanitize_ui(ui: &UiSnapshot) -> serde_json::Value {
    fn pick(v: &Option<String>, allowed: &[&str]) -> serde_json::Value {
        match v.as_deref().map(str::trim) {
            Some(s) if allowed.contains(&s) => serde_json::json!(s),
            _ => serde_json::Value::Null,
        }
    }
    let webview = ui
        .webview
        .as_deref()
        .map(|s| s.replace(['\n', '\r'], " "))
        .map(|s| s.chars().take(160).collect::<String>());
    serde_json::json!({
        "ui": {
            "density": pick(&ui.density, &["compact", "standard", "comfortable"]),
            "appearance": pick(&ui.appearance, &["classic", "glass"]),
            "theme": pick(&ui.theme, &["light", "dark"]),
            "openTabs": ui.open_tabs,
        },
        "webview": webview,
    })
}

/// 路径脱敏：返回（稳定哈希，末级目录名）。
///
/// 哈希只用于「同一台机器上两个包是不是同一个工程」，不需要抗碰撞。
pub fn sanitize_path(path: &str) -> (String, String) {
    let hash = format!("{:016x}", crate::crash::fingerprint(path));
    let tail = path
        .rsplit(['\\', '/'])
        .find(|s| !s.is_empty())
        .map(|s| s.chars().take(40).collect::<String>())
        .unwrap_or_default();
    (hash, tail)
}

/// 打包并落盘，返回 zip 的绝对路径。
pub fn write_zip(dir: &Path, entries: &[(String, Vec<u8>)]) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("建导出目录失败: {e}"))?;
    let name = format!("ncforge-diagnostics-{}.zip", crate::crash::now_ms());
    let path = dir.join(name);
    let file = fs::File::create(&path).map_err(|e| format!("创建诊断包失败: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        zip.start_file(name.as_str(), options)
            .map_err(|e| format!("写入 {name} 失败: {e}"))?;
        zip.write_all(bytes)
            .map_err(|e| format!("写入 {name} 失败: {e}"))?;
    }
    zip.finish().map_err(|e| format!("收尾失败: {e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        crate::test_support::tmp(tag)
    }

    /// 预览列出的路径集合必须与真正会打进去的完全一致。
    /// 🔴 这条钉的是「预览说 12 项、实际打 10 项」这类漂移——用户勾选就失去意义了。
    #[test]
    fn 预览与打包的条目集合一致() {
        let dir = tmp("diag-plan");
        fs::create_dir_all(dir.join("logs")).unwrap();
        // 每个来源都造一份，保证 present 全为真
        for src in LOG_SOURCES {
            fs::write(dir.join(src.file), b"x").unwrap();
        }
        let planned: Vec<String> = plan(&dir).into_iter().map(|p| p.path).collect();
        let packed: Vec<String> = collect(&dir, &UiSnapshot::default(), None)
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert_eq!(planned, packed, "预览与打包必须同源");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 白名单之外的文件即使躺在日志目录里，也绝不能进包。
    #[test]
    fn 不打包白名单之外的文件() {
        let dir = tmp("diag-extra");
        fs::create_dir_all(dir.join("logs")).unwrap();
        fs::write(dir.join("logs/client.log"), b"ok").unwrap();
        fs::write(dir.join("logs/secret-token.txt"), b"hunter2").unwrap();
        fs::write(dir.join("logs/client.log.9"), b"old").unwrap();
        let packed = collect(&dir, &UiSnapshot::default(), None);
        let names: Vec<&str> = packed.iter().map(|(p, _)| p.as_str()).collect();
        assert!(names.contains(&"logs/client.log"));
        assert!(
            !names.iter().any(|n| n.contains("secret")),
            "白名单外的文件进了包：{names:?}"
        );
        assert!(
            !names.iter().any(|n| n.ends_with(".9")),
            "轮转序号也必须在白名单里显式列出"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 脱敏：密码、连接串一个都不许出现在 state.json 里。
    #[test]
    fn 状态快照只有白名单字段() {
        let dir = tmp("diag-state");
        let ui = UiSnapshot {
            density: Some("compact".into()),
            appearance: Some("glass".into()),
            theme: Some("dark".into()),
            open_tabs: Some(7),
            webview: Some("Mozilla/5.0 Chrome/120".into()),
        };
        let text = state_json(&dir, &ui);
        assert!(text.contains("compact") && text.contains("glass") && text.contains("dark"));
        assert!(text.contains("\"openTabs\":7"));
        assert!(!text.contains("password") && !text.contains("jdbc:"));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 路径只留哈希 + 末级目录名：客户名、项目代号这类信息不能跟着包走。
    #[test]
    fn 路径脱敏只留哈希与末级名() {
        let (hash, tail) = sanitize_path(r"D:\客户项目\爱尔眼科\erp");
        assert_eq!(tail, "erp");
        assert_eq!(hash.len(), 16, "哈希长度固定，便于肉眼比对是不是同一个工程");
        assert!(!hash.contains('爱') && !hash.contains("客户"));
        // 同一路径必须稳定（否则两个包没法比对）
        assert_eq!(hash, sanitize_path(r"D:\客户项目\爱尔眼科\erp").0);
        // 尾部分隔符不能把末级名吃掉
        assert_eq!(sanitize_path("D:/work/proj/").1, "proj");
    }

    /// 未知取值一律置 null，而不是原样带出去。
    #[test]
    fn 不认识的档位值被丢弃() {
        let ui = UiSnapshot {
            density: Some("</script><script>alert(1)</script>".into()),
            theme: Some("neon".into()),
            ..Default::default()
        };
        let v = sanitize_ui(&ui);
        assert!(v["ui"]["density"].is_null(), "未知值必须丢弃");
        assert!(v["ui"]["theme"].is_null());
    }

    /// 勾选过滤：只打用户留下的那几项。
    #[test]
    fn 可以按勾选裁剪() {
        let dir = tmp("diag-include");
        fs::create_dir_all(dir.join("logs")).unwrap();
        fs::write(dir.join("logs/frontend.log"), b"fe").unwrap();
        fs::write(dir.join("logs/client.log"), b"cli").unwrap();
        let include = vec!["meta.json".to_string(), "logs/frontend.log".to_string()];
        let names: Vec<String> = collect(&dir, &UiSnapshot::default(), Some(&include))
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert_eq!(
            names,
            vec!["meta.json".to_string(), "logs/frontend.log".to_string()]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 越权的 include 项被静默忽略：前端传错不该让导出整体失败。
    #[test]
    fn 越权勾选不会带出别的文件() {
        let dir = tmp("diag-evil");
        fs::create_dir_all(dir.join("logs")).unwrap();
        fs::write(dir.join("logs/client.log"), b"cli").unwrap();
        let include = vec!["../../etc/passwd".to_string(), "meta.json".to_string()];
        let names: Vec<String> = collect(&dir, &UiSnapshot::default(), Some(&include))
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert_eq!(names, vec!["meta.json".to_string()]);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 写出来的 zip 必须能被读回来，且条目与输入一致。
    #[test]
    fn 写出的_zip_可读回() {
        let dir = tmp("diag-zip");
        fs::create_dir_all(dir.join("logs")).unwrap();
        fs::write(dir.join("logs/frontend.log"), b"hello").unwrap();
        let entries = collect(&dir, &UiSnapshot::default(), None);
        let path = write_zip(&dir.join("out"), &entries).unwrap();
        let file = fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), entries.len());
        let mut found = false;
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            if f.name() == "logs/frontend.log" {
                let mut text = String::new();
                std::io::Read::read_to_string(&mut f, &mut text).unwrap();
                assert_eq!(text, "hello");
                found = true;
            }
        }
        assert!(found, "白名单里的日志必须真的进了 zip");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// manifest 由实际条目生成：不许列出没打进去的文件。
    #[test]
    fn 清单只列实际条目() {
        let entries = vec![("meta.json".to_string(), b"{}".to_vec())];
        let text = manifest_text(&entries);
        assert!(text.contains("meta.json"));
        assert!(!text.contains("state.json"), "清单不能凭白名单猜");
        assert!(text.contains("条目数：1"));
    }

    /// 生成的条目必须都能被预览看到（用户有权知道包里还有这些）。
    #[test]
    fn 生成项都在预览里() {
        let dir = tmp("diag-generated");
        let planned: Vec<String> = plan(&dir).into_iter().map(|p| p.path).collect();
        for (path, _) in GENERATED {
            assert!(planned.contains(&(*path).to_string()), "预览缺 {path}");
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
