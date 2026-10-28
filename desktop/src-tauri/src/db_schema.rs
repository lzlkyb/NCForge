//! 表结构缓存：从库里拉一次「表名 + 列名 + 类型」，落盘，供悬停与出包前核对用。
//!
//! 为什么要缓存而不是每次查：
//! - 悬停要「立刻」出结果，走一次 IPC + 元数据查询会明显卡光标；
//! - 出包前核对一次要读几十上百个文件、涉及几十张表，逐表查要几百次往返。
//!
//! 缓存的失效策略是「手动刷新」而不是「按时间过期」：表结构变更是低频事件，
//! 而库里两千多张表重新拉一次要几秒。界面上显示拉取时间，觉得不对就点刷新。
//!
//! 缓存按「连接串 + 用户」分文件：同一个库里不同 schema 的账号看到的表不一样。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::sql_refs::{SchemaIndex, TableShape};

/// 缓存里的一张表。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedTable {
    /// `TABLE` / `VIEW`。
    pub kind: String,
    /// 列名（小写）→ 带长度的类型名，如 `VARCHAR2(40)`。
    pub columns: BTreeMap<String, String>,
}

/// 一份完整的表结构缓存。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCache {
    /// 连接串（写进缓存，用来判断这份缓存是不是当前这个库的）。
    pub url: String,
    pub user: String,
    /// 拉取时刻（Unix 秒）。界面显示「几小时前拉的」。
    pub fetched_at: u64,
    /// 小写表名 → 表。
    pub tables: BTreeMap<String, CachedTable>,
}

impl SchemaCache {
    /// 从桥吐出的扁平行（表、列、类型）建缓存。
    pub fn build(url: &str, user: &str, fetched_at: u64, rows: &[(String, String, String)]) -> Self {
        let mut tables: BTreeMap<String, CachedTable> = BTreeMap::new();
        for (t, c, ty) in rows {
            let tl = t.to_lowercase();
            let e = tables.entry(tl).or_insert_with(|| CachedTable {
                // 视图与表在元数据里分得开，但 getColumns 不带表类型，统一记 TABLE；
                // 这个字段只用于展示，不影响核对。
                kind: "TABLE".to_string(),
                columns: BTreeMap::new(),
            });
            e.columns.insert(c.to_lowercase(), ty.clone());
        }
        Self {
            url: url.to_string(),
            user: user.to_string(),
            fetched_at,
            tables,
        }
    }

    /// 转成核对用的索引（克隆一份，缓存的表数只有几千张，成本可忽略）。
    pub fn index(&self) -> SchemaIndex {
        SchemaIndex {
            tables: self
                .tables
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        TableShape {
                            kind: v.kind.clone(),
                            columns: v.columns.clone(),
                        },
                    )
                })
                .collect(),
        }
    }

    pub fn column_count(&self) -> usize {
        self.tables.values().map(|t| t.columns.len()).sum()
    }
}

// ───────────────────────── 落盘 ─────────────────────────

/// 缓存文件路径。按「用户 @ 连接串」区分，同一台机器连两个库不会互相覆盖。
pub fn cache_path(config_dir: &Path, url: &str, user: &str) -> PathBuf {
    let key = format!("{user}@{url}");
    config_dir
        .join("schema")
        .join(format!("{}-{:08x}.json", slug(&key), fnv1a(&key)))
}

/// 只留字母数字。连接串里有 `:@/.` 与端口，直接当文件名在 Windows 上会非法。
fn slug(s: &str) -> String {
    // 取尾部：库名和用户名在最后，比前面的 `jdbcoraclethin` 更有辨识度
    let all: String = s
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>();
    let start = all.len().saturating_sub(24);
    let tail = &all[start..];
    if tail.is_empty() {
        "db".to_string()
    } else {
        tail.to_string()
    }
}

/// FNV-1a 32 位。只用来给文件名加个短指纹，避免两个不同的库净化成同一个名字。
fn fnv1a(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// 读缓存。文件不存在、损坏、或者不是这个库的，一律当没有（重新拉一次比报错友好）。
pub fn load(path: &Path, url: &str, user: &str) -> Option<SchemaCache> {
    let bytes = std::fs::read(path).ok()?;
    let cache: SchemaCache = serde_json::from_slice(&bytes).ok()?;
    if cache.url != url || cache.user != user {
        return None;
    }
    Some(cache)
}

/// 写缓存。先写临时文件再改名，避免写到一半断电留下半截 JSON。
pub fn save(path: &Path, cache: &SchemaCache) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建缓存目录失败：{e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(cache).map_err(|e| format!("序列化表结构失败：{e}"))?;
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写缓存失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换缓存失败：{e}"))?;
    Ok(())
}

/// 把元数据里的类型名与长度拼成 `VARCHAR2(40)` 这样的展示名。
///
/// 只给「长度有意义」的类型加括号：`DATE`、`CLOB`、`BLOB` 加个 `(7)` 会误导人。
/// `NUMBER` 特殊——它的 size 对 `NUMBER(10,2)` 这种才有用，但元数据把精度和小数位
/// 分在两个字段里，这里拿不到 scale，索性不加括号，免得写成 `NUMBER(10)` 骗人。
pub fn fmt_type(type_name: &str, size: i32) -> String {
    let t = type_name.trim();
    if t.is_empty() {
        return String::new();
    }
    let upper = t.to_ascii_uppercase();
    let no_size = [
        "DATE",
        "TIMESTAMP",
        "CLOB",
        "NCLOB",
        "BLOB",
        "LONG",
        "NUMBER",
        "FLOAT",
        "BINARY_FLOAT",
        "BINARY_DOUBLE",
        "ROWID",
    ];
    if size <= 0 || no_size.iter().any(|x| upper.starts_with(x)) {
        return t.to_string();
    }
    format!("{t}({size})")
}

/// 现在（Unix 秒）。
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ───────────────────────── 测试 ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<(String, String, String)> {
        vec![
            (
                "BD_MATERIAL".into(),
                "PK_MATERIAL".into(),
                "CHAR(20)".into(),
            ),
            (
                "BD_MATERIAL".into(),
                "MATERIAL_CODE".into(),
                "VARCHAR2(40)".into(),
            ),
            ("ORG_ORGS".into(), "PK_ORG".into(), "CHAR(20)".into()),
        ]
    }

    #[test]
    fn 建缓存时表名列名转小写() {
        let c = SchemaCache::build("url", "u", 1, &rows());
        assert_eq!(c.tables.len(), 2);
        assert!(c.tables.contains_key("bd_material"));
        assert_eq!(c.column_count(), 3);
        assert!(c.tables["bd_material"].columns.contains_key("material_code"));
    }

    #[test]
    fn 索引里能查列() {
        let c = SchemaCache::build("url", "u", 1, &rows());
        let i = c.index();
        assert_eq!(i.columns_of("bd_material").len(), 2);
        assert!(i.columns_of("不存在").is_empty());
    }

    #[test]
    fn 不同库不同文件() {
        let d = Path::new("C:/cfg");
        let a = cache_path(d, "jdbc:oracle:thin:@10.0.0.1:1521/aier260824", "aier633");
        let b = cache_path(d, "jdbc:oracle:thin:@10.0.0.1:1521/aier260825", "aier633");
        let c = cache_path(d, "jdbc:oracle:thin:@10.0.0.1:1521/aier260824", "other");
        assert_ne!(a, b);
        assert_ne!(a, c);
        // 文件名里不能有冒号斜杠
        let name = a.file_name().unwrap().to_string_lossy().to_string();
        assert!(!name.contains(':') && !name.contains('/') && !name.contains('\\'));
        assert!(name.ends_with(".json"));
    }

    #[test]
    fn 存了能读回来() {
        let d = std::env::temp_dir().join(format!("ncschema-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = cache_path(&d, "jdbc:oracle:thin:@h:1521/x", "u1");
        let c = SchemaCache::build("jdbc:oracle:thin:@h:1521/x", "u1", 123, &rows());
        save(&p, &c).unwrap();
        let back = load(&p, "jdbc:oracle:thin:@h:1521/x", "u1").expect("应能读回");
        assert_eq!(back, c);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 换了库就不认旧缓存() {
        let d = std::env::temp_dir().join(format!("ncschema2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = cache_path(&d, "url-a", "u1");
        let c = SchemaCache::build("url-a", "u1", 1, &rows());
        save(&p, &c).unwrap();
        assert!(load(&p, "url-b", "u1").is_none());
        assert!(load(&p, "url-a", "u2").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 坏文件当没有() {
        let d = std::env::temp_dir().join(format!("ncschema3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("broken.json");
        std::fs::write(&p, b"{ not json").unwrap();
        assert!(load(&p, "url", "u").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 类型带长度() {
        assert_eq!(fmt_type("VARCHAR2", 40), "VARCHAR2(40)");
        assert_eq!(fmt_type("CHAR", 20), "CHAR(20)");
        assert_eq!(fmt_type("NUMBER", 22), "NUMBER");
        assert_eq!(fmt_type("DATE", 7), "DATE");
        assert_eq!(fmt_type("CLOB", 4000), "CLOB");
        assert_eq!(fmt_type("", 10), "");
        assert_eq!(fmt_type("VARCHAR2", 0), "VARCHAR2");
    }
}
