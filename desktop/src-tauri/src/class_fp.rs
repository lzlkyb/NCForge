//! class 结构指纹：桥 `struct` 命令的 Rust 侧。
//!
//! 指纹本身由 ecj 桥计算（`NcEcjBridge.structuralFingerprint`），投影面与 Eclipse
//! 增量构建器的 `ClassFileReader.hasStructuralChanges` 逐项对齐（R4_11 源码核对，
//! 契约测试用 `diff` 命令把原版判定当 oracle 交叉验证）。这里只做三件事：
//! 解析桥响应、按源文件聚合（Outer + Inner 一起算）、定义保守回退语义。
//!
//! **保守方向**：任何一个 class 缺指纹（读失败 / 桥不可用 / 首次没有基线）→ `None`，
//! 调用方必须按「结构可能变了」处理（传播引用方 / 宁可多编），绝不按「没变」跳过。

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// 桥 `struct` 响应里的一条（`name` 字段 Rust 侧用不到，serde 默认忽略未知字段）。
#[derive(Debug, Clone, Deserialize)]
pub struct StructEntry {
    pub path: String,
    pub fp: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StructData {
    pub structs: Vec<StructEntry>,
    pub errors: Vec<String>,
}

/// 正斜杠化 + 去掉 Windows verbatim 前缀（`\\?\` / `//?/`）。
/// Java 的 `File` 不认 verbatim 前缀：测试的 canonicalize 会带出它，生产路径
/// （`display_path`）已去掉——这里统一再归一一次，桥收到的一定是能打开的路径。
fn normalize(s: &str) -> String {
    let mut t = s.replace('\\', "/");
    if let Some(rest) = t.strip_prefix("//?/") {
        t = match rest.strip_prefix("UNC/") {
            Some(u) => format!("//{u}"),
            None => rest.to_string(),
        };
    }
    t
}

/// 指纹表的键：正斜杠 + 小写（Windows 路径大小写不敏感，桥回的是请求原文）。
pub fn key(p: &Path) -> String {
    normalize(&p.to_string_lossy()).to_ascii_lowercase()
}

pub fn key_str(s: &str) -> String {
    normalize(s).to_ascii_lowercase()
}

/// 发给桥的路径写法（不归一小写：桥按请求原文回路径，大小写留给键归一）。
pub fn display(s: &str) -> String {
    normalize(s)
}

/// 解析桥响应的 `data` 为指纹表。解析失败 → `None`（调用方按结构可能变了处理）。
pub fn parse(data: &serde_json::Value) -> Option<HashMap<String, String>> {
    let d: StructData = serde_json::from_value(data.clone()).ok()?;
    if !d.errors.is_empty() {
        log::warn!(
            "struct：{} 个 class 读取失败，按「结构可能变了」保守处理",
            d.errors.len()
        );
    }
    Some(
        d.structs
            .into_iter()
            .map(|s| (key_str(&s.path), s.fp))
            .collect(),
    )
}

/// 源文件级指纹：它产出的全部 class 指纹排序后再哈希（与 class 列出顺序无关）。
/// 空列表或任何一个缺指纹 → `None`。
pub fn combine(class_fps: &[Option<String>]) -> Option<String> {
    if class_fps.is_empty() {
        return None;
    }
    let mut parts = Vec::with_capacity(class_fps.len());
    for fp in class_fps {
        parts.push(fp.as_deref()?);
    }
    parts.sort_unstable();
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update([0]);
    }
    Some(format!("{:x}", h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combine_is_order_independent_and_missing_wins() {
        let a = Some("aa".to_string());
        let b = Some("bb".to_string());
        assert_eq!(combine(&[a.clone(), b.clone()]), combine(&[b, a]));
        assert_eq!(combine(&[Some("aa".into()), None]), None);
        assert_eq!(combine(&[]), None);
        assert_ne!(
            combine(&[Some("aa".into())]),
            combine(&[Some("aa".into()), Some("aa".into())])
        );
    }

    #[test]
    fn parse_normalizes_keys_and_tolerates_errors() {
        let v = serde_json::json!({
            "structs": [{"path": "C:/W/Out/p/A.class", "fp": "f1", "name": "p/A"}],
            "errors": ["C:/W/Out/p/B.class\tboom"],
            "pid": "123"
        });
        let m = parse(&v).unwrap();
        assert_eq!(m.get("c:/w/out/p/a.class").map(String::as_str), Some("f1"));
        assert!(parse(&serde_json::json!({"oops": 1})).is_none());
    }

    #[test]
    fn key_handles_backslash_and_case() {
        assert_eq!(key(Path::new(r"C:\W\Out\p\A.class")), "c:/w/out/p/a.class");
        assert_eq!(key_str(r"C:\W\A.class"), "c:/w/a.class");
    }

    #[test]
    fn verbatim_prefix_is_stripped_for_java() {
        // 反例来源：test_support::tmp 的 canonicalize 带 \\?\ 前缀，
        // Java File 打不开 //?/ 开头的路径，整批指纹静默变 None
        assert_eq!(
            key(Path::new(r"\\?\D:\W\Out\p\A.class")),
            "d:/w/out/p/a.class"
        );
        assert_eq!(key_str("//?/D:/W/A.class"), "d:/w/a.class");
        assert_eq!(display(r"\\?\D:\W\A.class"), "D:/W/A.class");
        assert_eq!(
            display("//?/UNC/server/share/A.class"),
            "//server/share/A.class"
        );
        // 普通路径不受影响
        assert_eq!(display("D:/W/A.class"), "D:/W/A.class");
    }
}
