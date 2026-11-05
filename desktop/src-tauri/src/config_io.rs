//! 配置导入导出：把本机配置打包成一个 JSON 文件，换机器 / 给新同事时导入。
//!
//! 安全口径（本模块存在的主要原因）：
//! - **导出走白名单**：只序列化 `ExportableConfig` 列出的字段，三个口令密文字段
//!   （`svn_password_dpapi` / `db_password_dpapi` / `db_conns[].password_dpapi`）
//!   在结构体里就不存在，想漏都漏不出去。
//! - **导入主动丢弃口令**：导入文件是不可信输入（可能被手改过），反序列化前先把
//!   所有口令键从 JSON 树上删掉再解析——不依赖「导出时没写」这一件事。
//! - **缺字段 = 不动本机值**：全部 Option 化，与 `patch_config` 同一哲学。
//!   老版本 / 手改文件少了字段时，本机对应设置保持原样，不会被清空。
//!
//! 路径字段（工作区 / NC home / 补丁目录等）导出的是**导出机器的绝对路径**，
//! 换机器后大概率不存在——导入预览界面必须允许逐条改写，UI 层负责。

use serde::{Deserialize, Serialize};

use crate::config::{AppConfig, DbConnConfig, LinkedOverrideConfig};

/// 导出文件格式版本。升级 `ExportableConfig` 结构时加一（v2 = 加 `linked_overrides`）；
/// 导入方版本比文件旧时**拒绝**（防止新字段被静默忽略后用户以为导全了）。
pub const EXPORT_SCHEMA: u32 = 2;

/// 导出文件的外层信封。`app` 字段防止把别的应用的导出物导进来。
///
/// 三个字段全 `#[serde(default)]`：信封字段缺失不该阻断导入——
/// `app` 缺了后续校验会指出「不是本应用的文件」，`schema` 缺了当 0 处理
/// （比当前旧即放行），`from_version` 纯信息字段，缺了不影响任何语义。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ConfigExport {
    pub app: String,
    pub schema: u32,
    /// 导出机器上的工作台版本（`env!("CARGO_PKG_VERSION")`）。
    pub from_version: String,
    pub config: ExportableConfig,
}

/// 可导出字段的白名单。**故意不含任何口令字段**。
///
/// `#[serde(default)]` + 全 Option：缺键反序列化成 `None`，
/// 应用时「不动本机值」。布尔也 Option 化——`lang_enabled` 缺键时若落成
/// `false`，会把新机器的代码智能悄悄关掉。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ExportableConfig {
    pub workspace_root: Option<String>,
    pub nc_home: Option<String>,
    pub server_heap_mb: Option<u32>,
    /// 客户端（JStarter）堆上限。旧导出物没有这个键 → `None` → 不动本机值。
    pub client_heap_mb: Option<u32>,
    pub svn_user: Option<String>,
    pub patch_out_dir: Option<String>,
    pub patch_out_root: Option<String>,
    pub nc_patch_dir: Option<String>,
    pub db_url: Option<String>,
    pub db_user: Option<String>,
    pub db_active: Option<String>,
    pub db_conns_init: Option<bool>,
    /// 全量替换语义：`Some` = 本机连接列表换成它，`None` = 不动。
    pub db_conns: Option<Vec<DbConnConfig>>,
    pub lang_enabled: Option<bool>,
    pub lang_auto_start: Option<bool>,
    pub lang_xmx_mb: Option<u32>,
    /// 工程关联覆盖表：全量替换语义（`Some` = 换成它，`None` = 不动）。
    ///
    /// 里面的 `target` 可能是工程绝对路径，换机器后大概率失效。**不在这里清**——
    /// 失效的覆盖在解析时会被「找不到工程」挡掉并在界面里说明（见 `eclipse_cp`），
    /// 用户还能看见自己当初配了什么，比静默清空好。
    pub linked_overrides: Option<Vec<LinkedOverrideConfig>>,
}

/// 口令字段的 JSON 键名黑名单。导入时从 JSON 树上整键删除。
///
/// 只删这两个键：`db_conns` 数组里的 `password_dpapi` 由 `strip_secrets`
/// 递归处理（见下）。写全路径没用——数组元素没有键名。
const SECRET_KEYS: &[&str] = &["svn_password_dpapi", "db_password_dpapi"];
const CONN_SECRET_KEY: &str = "password_dpapi";

/// 从当前配置生成导出物。
pub fn build_export(cfg: &AppConfig) -> ConfigExport {
    ConfigExport {
        app: "ncforge".to_string(),
        schema: EXPORT_SCHEMA,
        from_version: env!("CARGO_PKG_VERSION").to_string(),
        config: ExportableConfig {
            workspace_root: cfg.workspace_root.clone(),
            nc_home: cfg.nc_home.clone(),
            server_heap_mb: cfg.server_heap_mb,
            client_heap_mb: cfg.client_heap_mb,
            svn_user: cfg.svn_user.clone(),
            patch_out_dir: cfg.patch_out_dir.clone(),
            patch_out_root: cfg.patch_out_root.clone(),
            nc_patch_dir: cfg.nc_patch_dir.clone(),
            db_url: cfg.db_url.clone(),
            db_user: cfg.db_user.clone(),
            db_active: cfg.db_active.clone(),
            db_conns_init: Some(cfg.db_conns_init),
            // 口令密文不过导出物：DbConnConfig 序列化时逐条抹掉
            db_conns: Some(
                cfg.db_conns
                    .iter()
                    .map(|c| DbConnConfig {
                        password_dpapi: None,
                        ..c.clone()
                    })
                    .collect(),
            ),
            lang_enabled: Some(cfg.lang_enabled),
            lang_auto_start: Some(cfg.lang_auto_start),
            lang_xmx_mb: cfg.lang_xmx_mb,
            linked_overrides: Some(cfg.linked_overrides.clone()),
        },
    }
}

/// 解析导入文件文本。不可信输入：先删口令键，再校验信封，再反序列化。
///
/// 错误文案直接显示给用户，每条都要能指出「哪儿不对、下一步干嘛」。
pub fn parse_import(text: &str) -> Result<ConfigExport, String> {
    let mut tree: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("不是合法的 JSON 文件：{e}"))?;
    if !tree.is_object() {
        return Err("文件内容不是一个配置对象（顶层不是 JSON 对象）".to_string());
    }
    strip_secrets(&mut tree);

    let export: ConfigExport =
        serde_json::from_value(tree).map_err(|e| format!("配置内容无法识别：{e}"))?;
    if export.app != "ncforge" {
        return Err(format!(
            "这不是 NCForge 的配置文件（app 字段是 {:?}）",
            export.app
        ));
    }
    if export.schema > EXPORT_SCHEMA {
        return Err(format!(
            "文件由更新的工作台生成（格式版本 {}，本机支持到 {}），请先升级工作台再导入",
            export.schema, EXPORT_SCHEMA
        ));
    }
    Ok(export)
}

/// 递归删除 JSON 树里的口令键：对象按键删，数组逐元素递归。
fn strip_secrets(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            for key in SECRET_KEYS {
                map.remove(*key);
            }
            map.remove(CONN_SECRET_KEY);
            for (_, child) in map.iter_mut() {
                strip_secrets(child);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                strip_secrets(item);
            }
        }
        _ => {}
    }
}

/// 把导出物应用进配置（调用方负责经 `update_config` 串行落盘）。
///
/// 语义：**缺字段不动本机值**；`db_conns` 为 `Some` 时全量替换；
/// 导入后 `db_active` 若指向不存在的连接，清成 `None`（悬空引用会让
/// 数据库页每次打开都尝试连一个不存在的库）。
pub fn apply_import(cfg: &mut AppConfig, imported: &ExportableConfig) -> Result<(), String> {
    if let Some(v) = &imported.workspace_root {
        cfg.workspace_root = Some(v.clone());
    }
    if let Some(v) = &imported.nc_home {
        cfg.nc_home = Some(v.clone());
    }
    if imported.server_heap_mb.is_some() {
        cfg.server_heap_mb = imported.server_heap_mb;
    }
    if imported.client_heap_mb.is_some() {
        cfg.client_heap_mb = imported.client_heap_mb;
    }
    if let Some(v) = &imported.svn_user {
        cfg.svn_user = Some(v.clone());
    }
    if let Some(v) = &imported.patch_out_dir {
        cfg.patch_out_dir = Some(v.clone());
    }
    if let Some(v) = &imported.patch_out_root {
        cfg.patch_out_root = Some(v.clone());
    }
    if let Some(v) = &imported.nc_patch_dir {
        cfg.nc_patch_dir = Some(v.clone());
    }
    if let Some(v) = &imported.db_url {
        cfg.db_url = Some(v.clone());
    }
    if let Some(v) = &imported.db_user {
        cfg.db_user = Some(v.clone());
    }
    if let Some(v) = imported.db_conns_init {
        cfg.db_conns_init = v;
    }
    if let Some(v) = &imported.lang_enabled {
        cfg.lang_enabled = *v;
    }
    if let Some(v) = &imported.lang_auto_start {
        cfg.lang_auto_start = *v;
    }
    if imported.lang_xmx_mb.is_some() {
        cfg.lang_xmx_mb = imported.lang_xmx_mb;
    }
    if let Some(v) = &imported.linked_overrides {
        cfg.linked_overrides = v.clone();
    }

    if let Some(conns) = &imported.db_conns {
        let mut seen = std::collections::HashSet::new();
        let mut deduped: Vec<DbConnConfig> = Vec::with_capacity(conns.len());
        for c in conns {
            let mut c = c.clone();
            // 文件内 id 撞车（手改合并过两份导出物才会发生）：重新生成，
            // 否则 db_active / 表结构缓存会指错连接。
            if !seen.insert(c.id.clone()) {
                c.id = crate::db_conns::new_id();
                seen.insert(c.id.clone());
            }
            deduped.push(c);
        }
        cfg.db_conns = deduped;
    }

    // db_active 的应用统一放在前：导入文件带了就用它（哪怕连接列表也换了），
    // 没带才保持本机值。放在后面的分支里会漏掉「列表 + active 一起导入」。
    if let Some(active) = &imported.db_active {
        cfg.db_active = Some(active.clone());
    }
    // 清理只在本次真的动过连接列表时做——否则本机自己加的连接
    // 被一份没带 db_active 的旧文件清掉，那是倒退。
    if imported.db_conns.is_some() {
        let alive = cfg
            .db_conns
            .iter()
            .any(|c| Some(&c.id) == cfg.db_active.as_ref());
        if !alive {
            cfg.db_active = None;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_cfg() -> AppConfig {
        AppConfig {
            workspace_root: Some(r"D:\ws\newar".to_string()),
            nc_home: Some(r"D:\ncc\1909home".to_string()),
            svn_user: Some("ayan".to_string()),
            svn_password_dpapi: Some("AQAAANCMnd8-svn-密文".to_string()),
            db_password_dpapi: Some("AQAAANCMnd8-db-密文".to_string()),
            db_conns: vec![DbConnConfig {
                id: "c1".to_string(),
                name: "测试库".to_string(),
                env: "test".to_string(),
                source: "manual".to_string(),
                url: "jdbc:oracle:thin:@10.0.0.1:1521/aier".to_string(),
                user: "nc".to_string(),
                prop_ds: None,
                password_dpapi: Some("AQAAANCMnd8-conn-密文".to_string()),
                auto_commit: false,
                engine: "java".to_string(),
                note: String::new(),
            }],
            db_active: Some("c1".to_string()),
            lang_enabled: true,
            ..AppConfig::default()
        }
    }

    /// 导出物序列化后不得出现任何密文痕迹（白名单结构体 + 逐条抹除的双保险）。
    #[test]
    fn 导出物不含任何口令密文() {
        let cfg = local_cfg();
        let json = serde_json::to_string_pretty(&build_export(&cfg)).unwrap();
        for secret in [
            "AQAAANCMnd8-svn-密文",
            "AQAAANCMnd8-db-密文",
            "AQAAANCMnd8-conn-密文",
        ] {
            assert!(!json.contains(secret), "导出物泄露了口令密文: {secret}");
        }
        assert!(
            !json.contains("password_dpapi"),
            "导出物不该有 password_dpapi 键"
        );
        assert!(
            !json.contains("svn_password_dpapi"),
            "导出物不该有 svn 口令键"
        );
    }

    /// 客户端堆上限属于启动参数，换机器时也要跟着走（否则新机按 768M 起客户端）。
    #[test]
    fn 客户端堆上限随导出导入往返() {
        let cfg = AppConfig {
            client_heap_mb: Some(1024),
            ..Default::default()
        };
        let export = build_export(&cfg);
        assert_eq!(export.config.client_heap_mb, Some(1024));

        let mut target = AppConfig::default();
        apply_import(&mut target, &export.config).unwrap();
        assert_eq!(target.client_heap_mb, Some(1024));

        // 旧导出物没有这个键：不能把本机值清掉
        let mut kept = AppConfig {
            client_heap_mb: Some(2048),
            ..Default::default()
        };
        let old = parse_import(r#"{"app":"ncforge","schema":1,"config":{}}"#).unwrap();
        apply_import(&mut kept, &old.config).unwrap();
        assert_eq!(kept.client_heap_mb, Some(2048));
    }

    /// 导入文件里硬塞口令字段（手改 / 恶意文件）也必须被丢掉。
    #[test]
    fn 导入时丢弃文件里的口令字段() {
        let malicious = r#"{
            "app": "ncforge",
            "schema": 1,
            "config": {
                "svn_user": "someone",
                "svn_password_dpapi": "塞进来的密文",
                "db_password_dpapi": "塞进来的密文2",
                "db_conns": [{
                    "id": "cx", "name": "x", "source": "manual", "url": "u", "user": "u",
                    "password_dpapi": "塞进来的密文3"
                }]
            }
        }"#;
        let export = parse_import(malicious).expect("应能解析");
        let mut cfg = AppConfig::default();
        apply_import(&mut cfg, &export.config).unwrap();
        assert_eq!(cfg.svn_user.as_deref(), Some("someone"));
        assert!(cfg.svn_password_dpapi.is_none(), "svn 口令必须被丢弃");
        assert!(cfg.db_password_dpapi.is_none(), "db 口令必须被丢弃");
        assert!(
            cfg.db_conns[0].password_dpapi.is_none(),
            "连接口令必须被丢弃"
        );
    }

    /// 缺字段不动本机值（老版本 / 手改文件少了字段时不清空本机设置）。
    #[test]
    fn 缺字段保持本机原值() {
        let minimal = r#"{"app":"ncforge","schema":1,"config":{"svn_user":"新同事"}}"#;
        let export = parse_import(minimal).unwrap();
        let mut cfg = local_cfg();
        apply_import(&mut cfg, &export.config).unwrap();
        assert_eq!(cfg.svn_user.as_deref(), Some("新同事"));
        assert_eq!(cfg.workspace_root.as_deref(), Some(r"D:\ws\newar"));
        assert_eq!(cfg.nc_home.as_deref(), Some(r"D:\ncc\1909home"));
        assert!(
            cfg.lang_enabled,
            "lang_enabled 缺键不能把本机的 true 翻成 false"
        );
        assert_eq!(cfg.db_conns.len(), 1, "db_conns 缺键不能清空本机连接");
    }

    /// db_conns 全量替换 + db_active 悬空清理。
    #[test]
    fn 导入连接列表并清理悬空active() {
        let text = r#"{
            "app":"ncforge","schema":1,
            "config":{"db_conns":[
                {"id":"a","name":"A","source":"prop","prop_ds":"ds1"},
                {"id":"b","name":"B","source":"manual","url":"u","user":"u"}
            ],"db_active":"a"}
        }"#;
        let export = parse_import(text).unwrap();
        let mut cfg = local_cfg();
        apply_import(&mut cfg, &export.config).unwrap();
        assert_eq!(cfg.db_conns.len(), 2);
        assert_eq!(cfg.db_active.as_deref(), Some("a"));

        // active 指向的连接不在列表里 → 清成 None
        let text2 = r#"{"app":"ncforge","schema":1,"config":{"db_conns":[
            {"id":"z","name":"Z","source":"manual","url":"u","user":"u"}
        ],"db_active":"a"}}"#;
        let export2 = parse_import(text2).unwrap();
        apply_import(&mut cfg, &export2.config).unwrap();
        assert_eq!(cfg.db_conns.len(), 1);
        assert!(cfg.db_active.is_none(), "悬空的 db_active 必须清掉");
    }

    /// 文件内 id 撞车 → 重新生成，不能出现两个同 id 连接。
    #[test]
    fn 连接id撞车重新生成() {
        let text = r#"{"app":"ncforge","schema":1,"config":{"db_conns":[
            {"id":"dup","name":"一","source":"manual","url":"u","user":"u"},
            {"id":"dup","name":"二","source":"manual","url":"u","user":"u"}
        ]}}"#;
        let export = parse_import(text).unwrap();
        let mut cfg = AppConfig::default();
        apply_import(&mut cfg, &export.config).unwrap();
        assert_eq!(cfg.db_conns.len(), 2);
        assert_ne!(
            cfg.db_conns[0].id, cfg.db_conns[1].id,
            "重复 id 必须重新生成"
        );
    }

    /// 坏输入的三种形态：非 JSON、非本应用、版本更新。
    #[test]
    fn 坏输入给出可读错误() {
        assert!(parse_import("这不是 json").is_err());
        let wrong_app = r#"{"app":"别的工具","schema":1,"config":{}}"#;
        let e = parse_import(wrong_app).unwrap_err();
        assert!(e.contains("别的工具"), "错误文案要点出来源: {e}");
        let future = r#"{"app":"ncforge","schema":999,"config":{}}"#;
        let e = parse_import(future).unwrap_err();
        assert!(e.contains("升级"), "新版文件要提示升级: {e}");
    }
}
