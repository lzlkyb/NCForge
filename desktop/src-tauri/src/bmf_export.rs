//! M5：把生成结果安全落盘（DDL / VO / UPM / 注册清单）。
//!
//! 纪律与 BMF 写回一致：**只增不改**——目标已存在默认跳过；显式覆盖前先备份。
//! 路径只接受相对路径，`..` 与绝对路径一律拒绝，避免把工程写穿到任意目录。

use std::path::{Path, PathBuf};

use encoding_rs::GBK;
use serde::Serialize;

use crate::atomic_file;
use crate::bmf_gen::Generation;
use crate::workspace::TextEncoding;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    pub rel_path: String,
    pub kind: String,
    /// written | skipped | replaced
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub items: Vec<ExportItem>,
    pub written: usize,
    pub skipped: usize,
    pub target_dir: String,
}

/// 一条待落盘文件：相对路径、正文、编码、是否 CRLF。
#[derive(Debug, Clone)]
pub struct PlannedFile {
    pub rel_path: String,
    pub kind: String,
    pub text: String,
    pub encoding: TextEncoding,
    pub crlf: bool,
}

/// 由生成结果推导落盘清单。`registry.md` 是给人看的手工注册清单，
/// 不假装能自动改 UAP 的六处注册文件。
pub fn plan(gen: &Generation, component: &str, namespace: &str) -> Vec<PlannedFile> {
    let mut out = vec![PlannedFile {
        rel_path: format!("sql/{component}_ddl.sql"),
        kind: "ddl".into(),
        text: gen.ddl.clone(),
        encoding: TextEncoding::Utf8,
        crlf: false,
    }];
    for f in &gen.files {
        let enc = if f.encoding.eq_ignore_ascii_case("GBK") {
            TextEncoding::Gbk
        } else {
            TextEncoding::Utf8
        };
        out.push(PlannedFile {
            rel_path: format!("java/{}", f.path_hint.trim_start_matches('/')),
            kind: f.kind.clone(),
            text: f.text.clone(),
            encoding: enc,
            crlf: f.eol.eq_ignore_ascii_case("CRLF"),
        });
    }
    if !gen.upm.trim().is_empty() {
        let ns = if namespace.is_empty() { component } else { namespace };
        out.push(PlannedFile {
            rel_path: format!("upm/{ns}.upm"),
            kind: "upm".into(),
            text: gen.upm.clone(),
            encoding: TextEncoding::Utf8,
            crlf: true,
        });
    }
    out.push(PlannedFile {
        rel_path: "registry.md".into(),
        kind: "registry".into(),
        text: registry_md(gen),
        encoding: TextEncoding::Utf8,
        crlf: false,
    });
    out
}

fn registry_md(gen: &Generation) -> String {
    let mut s = String::from("# 注册清单（手工）\n\n以下六处由 UAP 官方工具维护，本工具只列现状与建议，不自动改。\n\n");
    if gen.registry.is_empty() {
        s.push_str("（没有需要注册的条目）\n");
        return s;
    }
    s.push_str("| 位置 | 现状 | 建议 | 说明 |\n| --- | --- | --- | --- |\n");
    for r in &gen.registry {
        let cell = |x: &str| x.replace('|', "\\|").replace('\n', " ");
        s.push_str(&format!(
            "| {} | {} | {} | {} |\n",
            cell(&r.area),
            cell(&r.existing),
            cell(&r.suggested),
            cell(&r.note)
        ));
    }
    if !gen.warnings.is_empty() {
        s.push_str("\n## 注意\n\n");
        for w in &gen.warnings {
            s.push_str(&format!("- {w}\n"));
        }
    }
    s
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(format!("只接受相对路径：{rel}"));
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
        return Err(format!("路径不能包含 .. 或盘符：{rel}"));
    }
    Ok(root.join(p))
}

fn encode(text: &str, enc: TextEncoding, crlf: bool) -> Result<Vec<u8>, String> {
    let norm = if crlf {
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text.to_string()
    };
    match enc {
        TextEncoding::Utf8 => Ok(norm.into_bytes()),
        TextEncoding::Gbk => {
            let (cow, _, bad) = GBK.encode(&norm);
            if bad {
                Err("内容含 GBK 无法表示的字符，未写入".to_string())
            } else {
                Ok(cow.into_owned())
            }
        }
    }
}

/// 落盘。默认不覆盖已有文件；`overwrite` 时先备份到 `backup_dir`。
pub fn write_all(
    target_dir: &Path,
    files: &[PlannedFile],
    overwrite: bool,
    backup_dir: &Path,
) -> Result<ExportResult, String> {
    std::fs::create_dir_all(target_dir).map_err(|e| format!("创建目标目录失败：{e}"))?;
    let mut items = Vec::new();
    let mut written = 0;
    let mut skipped = 0;
    for f in files {
        let path = safe_join(target_dir, &f.rel_path)?;
        if path.exists() {
            if !overwrite {
                skipped += 1;
                items.push(ExportItem {
                    rel_path: f.rel_path.clone(),
                    kind: f.kind.clone(),
                    status: "skipped".into(),
                    detail: "目标已存在，未覆盖（勾选覆盖才会备份后重写）".into(),
                });
                continue;
            }
            crate::bmf_write::backup(&path, backup_dir)?;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let bytes = encode(&f.text, f.encoding, f.crlf)?;
        atomic_file::write_atomic(&path, &bytes)?;
        written += 1;
        items.push(ExportItem {
            rel_path: f.rel_path.clone(),
            kind: f.kind.clone(),
            status: if overwrite { "replaced".into() } else { "written".into() },
            detail: f.rel_path.clone(),
        });
    }
    Ok(ExportResult {
        items,
        written,
        skipped,
        target_dir: target_dir.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bmf_gen::{GeneratedFile, RegistryItem};

    fn gen() -> Generation {
        Generation {
            ddl: "create table t (id char(20));\n".into(),
            files: vec![GeneratedFile {
                kind: "vo".into(),
                name: "XVO.java".into(),
                path_hint: "src/public/nc/vo/m/XVO.java".into(),
                encoding: "GBK".into(),
                eol: "CRLF".into(),
                text: "class XVO {}\n".into(),
            }],
            registry: vec![RegistryItem {
                area: "UPM".into(),
                hint: "h".into(),
                existing: "无".into(),
                suggested: "add".into(),
                note: "n".into(),
            }],
            upm: "<module/>\n".into(),
            warnings: vec!["w".into()],
        }
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-gen-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn plan_covers_all_artifacts() {
        let p = plan(&gen(), "demo", "m");
        let rel: Vec<&str> = p.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rel, vec![
            "sql/demo_ddl.sql",
            "java/src/public/nc/vo/m/XVO.java",
            "upm/m.upm",
            "registry.md",
        ]);
        assert!(matches!(p[1].encoding, TextEncoding::Gbk));
        assert!(p[1].crlf);
        assert!(p[3].text.contains("| UPM |"));
    }

    #[test]
    fn writes_then_skips_and_backs_up_on_overwrite() {
        let d = tmp("write");
        let files = plan(&gen(), "demo", "m");
        let r = write_all(&d.join("out"), &files, false, &d.join("bak")).unwrap();
        assert_eq!(r.written, 4);
        assert_eq!(r.skipped, 0);
        let vo = std::fs::read(d.join("out/java/src/public/nc/vo/m/XVO.java")).unwrap();
        assert_eq!(vo, b"class XVO {}\r\n");

        let r2 = write_all(&d.join("out"), &files, false, &d.join("bak")).unwrap();
        assert_eq!(r2.written, 0);
        assert_eq!(r2.skipped, 4);
        let r3 = write_all(&d.join("out"), &files, true, &d.join("bak")).unwrap();
        assert_eq!(r3.written, 4);
        // 每次覆盖都留备份
        let baks: Vec<_> = std::fs::read_dir(d.join("bak")).unwrap().collect();
        assert_eq!(baks.len(), 4);
    }

    #[test]
    fn refuses_traversal_and_absolute_paths() {
        let d = tmp("safe");
        for rel in ["../evil.txt", "D:/evil.txt", "/etc/passwd"] {
            let f = PlannedFile {
                rel_path: rel.into(),
                kind: "x".into(),
                text: "x".into(),
                encoding: TextEncoding::Utf8,
                crlf: false,
            };
            let err = write_all(&d, &[f], false, &d.join("bak")).unwrap_err();
            assert!(err.contains("相对路径") || err.contains("不能包含"), "{rel} → {err}");
        }
    }
}
