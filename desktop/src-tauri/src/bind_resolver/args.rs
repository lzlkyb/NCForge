//! `bind_resolver` 的线路协议：`Hit` 镜像 + argsFile 编解码。
//!
//! 与 `mod.rs`（进程生命周期）分开放的原因只有体量红线（`.rs` ≤600 行）——
//! 但集中也有集中好处：协议是会随 Java 侧一起变的半边，全在这一个文件里，
//! 另一边的契约在 `ecj-bridge/BindingResolver.java` 的头部注释。
//!
//! 🔴 协议细节（与 `java_bridge.rs` 的 escape 配套，改一头必须改另一头）：
//! 三个命令的参数都走 **argsFile**，不是行内参数——路径里可能有 Tab/换行；
//! 且 `resolve` 的参数是 JSON，`\` 转义与桥的 `\t` 转义是两层，混在一行必错。
//! argsFile 每行一条、**不带引号**（Java 侧 `readLine` 逐行读，引号会变成路径一部分）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// `resolve` 的一枚答案（Java 侧 `BindingResolver.Hit` 的 Rust 镜像）。
///
/// **只有身份没有位置**：位置由命令层查 `decl_index`（设计 §2 契约）——
/// Java 侧拿不到索引，反过来 Rust 侧拿不到 binding，各答一半。
#[derive(Debug, Clone)]
pub struct Hit {
    /// `method` / `field` / `type` / `local`。
    pub kind: String,
    /// 声明类（内部类 `$` 连接）；`local` 为 `None`。
    pub fqcn: Option<String>,
    /// 成员简单名 / 类型简单名 / 局部名。
    pub name: String,
    /// 该 CU 的编译问题数（恢复绑定会 > 0），仅诊断用。
    pub problems: u32,
}

/// 桥回的 `data` → `Hit`。`data` 为 `null`（offset 处没有可解析引用）时返回 `None`。
pub(super) fn parse_hit(v: &serde_json::Value) -> Option<Hit> {
    let kind = v.get("kind")?.as_str()?.to_string();
    let name = v.get("name")?.as_str()?.to_string();
    Some(Hit {
        kind,
        fqcn: v.get("fqcn").and_then(|x| x.as_str()).map(str::to_string),
        name,
        problems: v.get("problems").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
    })
}

// ───────────────────────── argsFile 编解码 ─────────────────────────

/// 临时文件名带 pid + 序号：查询被锁串行化，但 invalidate 可能从别的线程进来。
static SEQ: AtomicU64 = AtomicU64::new(0);

fn tmp_args(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "ncf-bind-{}-{}-{name}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

/// `init` 的 classpath 文件：每行一条，LF 结尾，**不带引号**。
pub(super) fn write_init_args(entries: &[PathBuf]) -> std::io::Result<PathBuf> {
    let p = tmp_args("cp.txt");
    let body = entries
        .iter()
        .map(|e| crate::class_fp::display(&e.to_string_lossy()))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&p, format!("{body}\n"))?;
    Ok(p)
}

/// `resolve` 的参数文件：`{"path":"…","offset":N}`。
/// serde 会把 Windows 反斜杠编成 `\\`，Java 侧 `jsonStr` 还原——两边契约见
/// `BindingResolver.jsonStr`；单测 `resolve_args_的json` 钉 Rust 这一半。
pub(super) fn write_resolve_args(file: &Path, offset: usize) -> Option<PathBuf> {
    let p = tmp_args("resolve.json");
    let body = serde_json::json!({
        "path": crate::class_fp::display(&file.to_string_lossy()),
        "offset": offset,
    })
    .to_string();
    std::fs::write(&p, body).ok()?;
    Some(p)
}

/// `invalidate` 的路径文件：每行一个已保存文件的路径。
pub(super) fn write_invalidate_args(paths: &[PathBuf]) -> Option<PathBuf> {
    if paths.is_empty() {
        return None;
    }
    let p = tmp_args("paths.txt");
    let body = paths
        .iter()
        .map(|e| crate::class_fp::display(&e.to_string_lossy()))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&p, format!("{body}\n")).ok()?;
    Some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// init 的 classpath 文件：每行一条、原样路径（不带引号）、LF 结尾。
    /// 带引号或 CRLF 都会让 Java 侧 readLine 读出错误路径——而现象是
    /// 「classpath 少一半」，极难回头联想到是文件格式。
    #[test]
    fn init_args_每行一条原样路径() {
        let entries = vec![
            PathBuf::from("C:/work/aier/gl/src/private"),
            PathBuf::from("D:/nc/modules/gl/lib/a b.jar"),
            PathBuf::from(r"E:\x\y.jar"),
        ];
        let p = write_init_args(&entries).expect("应写得出去");
        let body = std::fs::read_to_string(&p).unwrap();
        // class_fp::display 会把反斜杠正斜杠化：Java 的 File 两种都吃
        assert_eq!(
            body,
            "C:/work/aier/gl/src/private\nD:/nc/modules/gl/lib/a b.jar\nE:/x/y.jar\n"
        );
        assert!(
            !body.contains('\r'),
            "不能有 CRLF：Java readLine 会留下 \\r"
        );
        assert!(!body.contains('"'), "路径不带引号：引号会变成路径的一部分");
        let _ = std::fs::remove_file(&p);
    }

    /// resolve 的参数 JSON：Windows 反斜杠必须被 serde 转义，否则 Java 侧
    /// `jsonStr` 会把 `\w` 当成未知转义序列（它的 default 分支原样吐出 n，
    /// 路径就被啃掉一个字符）。
    #[test]
    fn resolve_args_的json() {
        let p = write_resolve_args(Path::new(r"C:\work\aier\gl\src\A.java"), 892).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["path"], r"C:/work/aier/gl/src/A.java");
        assert_eq!(v["offset"], 892);
        let _ = std::fs::remove_file(&p);
    }

    /// data 缺 kind/name 必须解析失败（`None`），不能拿半个 Hit 去跳转。
    #[test]
    fn hit_解析缺字段即失败() {
        let ok =
            serde_json::json!({"kind":"method","fqcn":"nc.vo.A","name":"getCode","problems":3});
        let h = parse_hit(&ok).expect("完整帧应解析");
        assert_eq!(
            (
                h.kind.as_str(),
                h.fqcn.as_deref(),
                h.name.as_str(),
                h.problems
            ),
            ("method", Some("nc.vo.A"), "getCode", 3)
        );
        let local = serde_json::json!({"kind":"local","name":"vo"});
        assert!(parse_hit(&local).is_some(), "local 没有 fqcn 也算合法");
        assert!(
            parse_hit(&serde_json::json!({"name":"x"})).is_none(),
            "缺 kind"
        );
        assert!(
            parse_hit(&serde_json::json!({"kind":"local"})).is_none(),
            "缺 name"
        );
    }
}
