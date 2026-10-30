//! 数据库桥：与 SVN 桥共用 `java_bridge` 的常驻 JVM + 行协议，只是换主类与 classpath。
//!
//! classpath 有两段：自带的小 `ncdb.jar`（7KB）与 NC home 里的 `ojdbc6.jar`（2MB）。
//! 驱动不随包发：NC 装到哪都有，跟着它的版本走更安全（这台机器上就是 Oracle 11g 的驱动）。

use std::path::{Path, PathBuf};

pub use crate::java_bridge::{Bridge, BridgeEnv, BridgeError};

/// 自带的桥 jar（编译自 `src-tauri/db-bridge/NcDbBridge.java`）。
pub const DB_JAR: &str = "ncdb.jar";

/// 在候选目录里找 `ncdb.jar`。
pub fn find_jar(dirs: &[PathBuf]) -> Option<(PathBuf, PathBuf)> {
    for dir in dirs {
        let p = dir.join(DB_JAR);
        if p.is_file() {
            return Some((p, dir.clone()));
        }
    }
    None
}

/// 找 Oracle 驱动。优先 `driver/oracle_11g/ojdbc6.jar`（这台 NC 的实际位置），
/// 其次在 `driver/*` 下找任意 `ojdbc*.jar`——换过数据库版本的 NC 目录结构会变。
pub fn find_driver(nc_home: &Path) -> Option<PathBuf> {
    let preferred = nc_home.join("driver").join("oracle_11g").join("ojdbc6.jar");
    if preferred.is_file() {
        return Some(preferred);
    }
    let driver = nc_home.join("driver");
    let rd = std::fs::read_dir(&driver).ok()?;
    let mut hits: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .flat_map(|p| {
            if p.is_dir() {
                std::fs::read_dir(&p)
                    .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
                    .unwrap_or_default()
            } else {
                vec![p]
            }
        })
        .filter(|p| {
            p.file_name()
                .map(|n| {
                    let n = n.to_string_lossy().to_lowercase();
                    n.starts_with("ojdbc") && n.ends_with(".jar")
                })
                .unwrap_or(false)
        })
        .collect();
    hits.sort();
    hits.into_iter().next()
}

/// 解 prop.xml 口令要的 NC jar（`PropXMLReader` 及其依赖）。缺了不报错：手动连接照样能用，
/// 只是 prop.xml 来源的连接会在桥里报「缺 basic.jar」。
pub fn nc_decrypt_jars(nc_home: &Path) -> Vec<PathBuf> {
    [
        nc_home.join("external").join("lib").join("basic.jar"),
        nc_home.join("lib").join("fwcheck.jar"),
    ]
    .into_iter()
    .filter(|p| p.is_file())
    .collect()
}

/// 组装数据库桥的环境。
pub fn env(
    java: PathBuf,
    jar: PathBuf,
    driver: PathBuf,
    extra: Vec<PathBuf>,
    config_dir: PathBuf,
) -> BridgeEnv {
    let mut jars = vec![jar, driver];
    jars.extend(extra);
    BridgeEnv {
        java,
        jars,
        config_dir,
        main_class: "NcDbBridge".to_string(),
        label: "数据库".to_string(),
        // 结果集与元数据都在 JVM 里，512M 留够（单次最多 500 行 × 几十列）
        xmx_mb: 512,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 驱动优先取_oracle_11g() {
        let dir = std::env::temp_dir().join(format!("ncdb-drv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("driver/oracle_11g")).unwrap();
        std::fs::write(dir.join("driver/oracle_11g/ojdbc6.jar"), b"x").unwrap();
        let got = find_driver(&dir).expect("应能找到驱动");
        assert!(got.ends_with("ojdbc6.jar"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 驱动能退化到其它子目录() {
        let dir = std::env::temp_dir().join(format!("ncdb-drv2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("driver/oracle_19")).unwrap();
        std::fs::write(dir.join("driver/oracle_19/ojdbc8.jar"), b"x").unwrap();
        // 顺带放一个不是驱动的 jar，确认不会被选中
        std::fs::write(dir.join("driver/oracle_19/README.jar"), b"x").unwrap();
        let got = find_driver(&dir).expect("应能退化找到 ojdbc8");
        assert!(got.ends_with("ojdbc8.jar"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 找不到驱动时返回_none() {
        let dir = std::env::temp_dir().join(format!("ncdb-drv3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("driver")).unwrap();
        assert!(find_driver(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
