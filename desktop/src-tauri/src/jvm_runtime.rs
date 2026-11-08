//! JVM 桥的运行时来源：一套 Java 可执行文件 + 一个 Oracle JDBC 驱动。
//!
//! # 为什么要单独一层
//!
//! 以前 `bridge_env` 第一句就是 `nc_home::resolve(..)?`，把「JVM 桥能用」绑死在
//! 「装了 NC」上。可桥本身只认两个路径（见 `db_bridge::env` 的签名），NC home 只是
//! 这两样东西最省事的来源。只用数据库、机器上没有 NC 的用户不该因此被挡在门外。
//!
//! # 查找顺序
//!
//! Java 与驱动**各自独立解析**，再配对成一套：
//!
//! | 顺序 | Java | 驱动 |
//! |---|---|---|
//! | 1 | NC home 自带（1.8，起中间件最稳） | NC home 的 `driver/` |
//! | 2 | `ncdb` 资源包里的 JRE | 同一个包的 `ojdbc/` |
//! | 3 | 系统 `JAVA_HOME` / `PATH` | — |
//!
//! 顺序是有意的：装了 NC 的机器保持原行为；没有 NC 时优先用随包下载的 JRE
//! （不要求用户自己装 Java，也不受系统 Java 版本影响）；最后才退回系统 Java——
//! 那条路版本不可控（21 上跑 ojdbc6 有兼容风险），只当兜底。
//!
//! # 不在这里做的事
//!
//! 不负责下载。包没装就是 `None`，调用方据此给出「去设置里下载组件」的提示，
//! 或降级到纯 Rust 引擎（见 `commands::db_cmds::effective_engine`）。

use std::path::{Path, PathBuf};

use crate::nc_home::{self, NcHome};
use crate::resource_pack;

/// `ncdb` 资源包里 JRE 的目录名。`pack-resources.mjs` 打的就是这个形状。
pub const PACK_JRE_DIR: &str = "jre";
/// 同一个包里 Oracle 驱动的目录名。
pub const PACK_OJDBC_DIR: &str = "ojdbc";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeSource {
    /// NC 自带的 1.8 与驱动。装了 NC 的机器优先走这条，与改造前完全一致。
    NcHome,
    /// `ncdb` 资源包（按需下载）。没有 NC 也能用 JVM 桥。
    Pack,
    /// 系统 `JAVA_HOME` / `PATH` 里的 Java，驱动仍来自资源包。
    System,
}

impl RuntimeSource {
    pub fn label(self) -> &'static str {
        match self {
            RuntimeSource::NcHome => "NC 安装目录",
            RuntimeSource::Pack => "内置组件",
            RuntimeSource::System => "系统 Java",
        }
    }
}

#[derive(Debug, Clone)]
pub struct JvmRuntime {
    pub java: PathBuf,
    pub driver: PathBuf,
    /// **Java 可执行文件**的来源（驱动可能与它不同源：NC 的 Java 配资源包的驱动是允许的）。
    pub source: RuntimeSource,
}

/// 找一套能起 JVM 桥的运行时。找不到返回 `None`——调用方决定是提示下载还是降级。
pub fn find(config_dir: &Path, nc: Option<&NcHome>) -> Option<JvmRuntime> {
    let pack = resource_pack::active_dir(config_dir, resource_pack::PACK_NCDB);
    let (java, source) = source_java(nc, pack.as_deref())?;
    let driver = source_driver(nc, pack.as_deref())?;
    Some(JvmRuntime {
        java,
        driver,
        source,
    })
}

fn source_java(nc: Option<&NcHome>, pack: Option<&Path>) -> Option<(PathBuf, RuntimeSource)> {
    // NC 的 java 由 `nc_home::probe` 保证存在（没有 java 的目录过不了「是不是 NC home」），
    // 但配置可能是手改过的，所以照旧判一次 is_file。
    if let Some(p) = nc.map(|h| PathBuf::from(&h.java)).filter(|p| p.is_file()) {
        return Some((p, RuntimeSource::NcHome));
    }
    if let Some(p) = pack.and_then(java_in_pack) {
        return Some((p, RuntimeSource::Pack));
    }
    java_on_system().map(|p| (p, RuntimeSource::System))
}

fn source_driver(nc: Option<&NcHome>, pack: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = nc.and_then(|h| crate::db_bridge::find_driver(Path::new(&h.root))) {
        return Some(p);
    }
    pack.and_then(driver_in_pack)
}

/// 资源包里的 JRE。macOS 的 JDK bundle 多一层 `Contents/Home`，两种布局都认。
pub fn java_in_pack(dir: &Path) -> Option<PathBuf> {
    let root = dir.join(PACK_JRE_DIR);
    [
        root.join("bin").join(nc_home::JAVA_BIN_NAME),
        root.join("Contents")
            .join("Home")
            .join("bin")
            .join(nc_home::JAVA_BIN_NAME),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

/// 资源包里的 Oracle 驱动。优先 `ojdbc6.jar`（11g 配套），否则任意 `ojdbc*.jar`。
pub fn driver_in_pack(dir: &Path) -> Option<PathBuf> {
    let ojdbc = dir.join(PACK_OJDBC_DIR);
    let preferred = ojdbc.join("ojdbc6.jar");
    if preferred.is_file() {
        return Some(preferred);
    }
    let mut hits: Vec<PathBuf> = std::fs::read_dir(&ojdbc)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_ojdbc_jar(p))
        .collect();
    hits.sort();
    hits.into_iter().next()
}

fn is_ojdbc_jar(p: &Path) -> bool {
    p.file_name()
        .map(|n| {
            let n = n.to_string_lossy().to_lowercase();
            n.starts_with("ojdbc") && n.ends_with(".jar")
        })
        .unwrap_or(false)
}

/// 系统里的 Java：先 `JAVA_HOME`，再按 `PATH` 顺序找第一个。
///
/// 不跑 `java -version` 探版本：那是一次 fork（Windows 上还要压住控制台窗口），
/// 而这一步在每次建桥时都会走。版本不对的表现是桥启动失败并带出明确报错，
/// 比在这里猜更诚实。
pub fn java_on_system() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("JAVA_HOME") {
        let p = PathBuf::from(home).join("bin").join(nc_home::JAVA_BIN_NAME);
        if p.is_file() {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(nc_home::JAVA_BIN_NAME))
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::tmp;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    fn pack_fixture(tag: &str, with_jre: bool) -> (PathBuf, PathBuf) {
        let root = tmp(tag);
        let dir = root.join("ncdb@v1");
        touch(&dir.join(PACK_OJDBC_DIR).join("ojdbc6.jar"));
        if with_jre {
            touch(
                &dir.join(PACK_JRE_DIR)
                    .join("bin")
                    .join(nc_home::JAVA_BIN_NAME),
            );
        }
        (root, dir)
    }

    #[test]
    fn 包里的_jre_与驱动都能认出来() {
        let (_root, dir) = pack_fixture("jvm-pack", true);
        assert!(java_in_pack(&dir).is_some(), "bin/java 应被认出来");
        assert!(driver_in_pack(&dir).is_some(), "ojdbc6.jar 应被认出来");
    }

    #[test]
    fn 只有驱动没有_jre_时仍算有驱动() {
        let (_root, dir) = pack_fixture("jvm-pack-nojre", false);
        assert!(java_in_pack(&dir).is_none());
        assert!(
            driver_in_pack(&dir).is_some(),
            "驱动是 JVM 桥的必要条件，JRE 可以来自系统 Java"
        );
    }

    #[test]
    fn 驱动退而取任意_ojdbc_版本() {
        let root = tmp("jvm-pack-ojdbc8");
        let dir = root.join("ncdb@v1");
        touch(&dir.join(PACK_OJDBC_DIR).join("ojdbc8.jar"));
        assert!(driver_in_pack(&dir)
            .expect("应退化找到 ojdbc8")
            .ends_with("ojdbc8.jar"));
    }

    #[test]
    fn 包探测只认驱动() {
        let (_root, dir) = pack_fixture("jvm-probe", true);
        assert!(resource_pack::pack_probe_ok(&dir, resource_pack::PACK_NCDB));

        // 有驱动、没 JRE：仍然算装好 —— JRE 可以来自系统 Java
        let (_root2, dir2) = pack_fixture("jvm-probe-nojre", false);
        assert!(
            resource_pack::pack_probe_ok(&dir2, resource_pack::PACK_NCDB),
            "驱动是必要条件，JRE 可以由系统 Java 提供"
        );

        // 只有 JRE、没驱动：起不了桥，不算装好
        let root3 = tmp("jvm-probe-noojdbc");
        let dir3 = root3.join("ncdb@v1");
        touch(
            &dir3
                .join(PACK_JRE_DIR)
                .join("bin")
                .join(nc_home::JAVA_BIN_NAME),
        );
        assert!(
            !resource_pack::pack_probe_ok(&dir3, resource_pack::PACK_NCDB),
            "缺驱动时不该被判成装好"
        );
    }

    #[test]
    fn 没有资源包时不会凭包给出运行时() {
        let root = tmp("jvm-empty");
        // 这台机器可能装了系统 Java，所以 `find` 可能返回 System —— 但绝不能声称
        // 运行时来自「内置组件」：空配置目录里根本没有 ncdb 包。
        if let Some(rt) = find(&root, None) {
            assert_ne!(rt.source, RuntimeSource::Pack);
        }
    }

    #[test]
    fn nc_home_的_java_优先于资源包() {
        let (root, _dir) = pack_fixture("jvm-nc-first", true);
        let nc_root = tmp("jvm-nc-root");
        let nc_java = nc_root
            .join("ufjdk")
            .join("bin")
            .join(nc_home::JAVA_BIN_NAME);
        let nc_driver = nc_root.join("driver").join("oracle_11g").join("ojdbc6.jar");
        touch(&nc_java);
        touch(&nc_driver);
        let home = NcHome {
            root: nc_root.display().to_string(),
            java: nc_java.display().to_string(),
            module_count: 0,
            has_nc_starter: false,
            http_port: None,
            service_port: None,
        };
        let got = find(&root, Some(&home)).expect("NC home 在就该有运行时");
        assert_eq!(got.source, RuntimeSource::NcHome);
        assert_eq!(got.java, nc_java);
        assert_eq!(got.driver, nc_driver);
    }
}
