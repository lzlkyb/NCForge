//! 数据库连接管理：列表、新建/编辑/删除、测试连接、从 prop.xml / .properties 导入。
//!
//! 连接配置存在 `AppConfig.db_conns`；口令（手动来源）是 DPAPI 密文，**永不回给前端**——
//! 视图里只有 `hasPassword`。prop.xml 来源不存口令，每次由桥里的 NC `PropXMLReader` 现解。

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use super::db_cmds::{
    bridge_for, call, code_label, connect_args, drop_bridge, find_conn, prop_password_ready,
    protect, PROBE,
};
use crate::config::{AppConfig, DbConnConfig};
use crate::db_conns;
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnView {
    pub id: String,
    pub name: String,
    pub env: String,
    /// `manual` / `prop`。
    pub source: String,
    pub url: String,
    pub user: String,
    pub prop_ds: Option<String>,
    pub auto_commit: bool,
    pub note: String,
    /// 手动来源是否存了口令（prop 来源恒为 true：口令由 NC 现解）。
    pub has_password: bool,
    /// `java` / `rust`，这个连接用哪个执行引擎。
    pub engine: String,
}

impl From<&DbConnConfig> for DbConnView {
    fn from(c: &DbConnConfig) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            env: db_conns::normalize_env(&c.env),
            source: c.source.clone(),
            url: c.url.clone(),
            user: c.user.clone(),
            prop_ds: c.prop_ds.clone(),
            auto_commit: c.auto_commit,
            note: c.note.clone(),
            has_password: c.source == "prop" || c.password_dpapi.is_some(),
            engine: crate::db_engine::EngineKind::parse(&c.engine)
                .as_str()
                .to_string(),
        }
    }
}

/// 新建 / 编辑时前端交过来的内容（口令另传）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnInput {
    pub id: Option<String>,
    pub name: String,
    pub env: String,
    pub source: String,
    pub url: String,
    pub user: String,
    pub prop_ds: Option<String>,
    #[serde(default)]
    pub auto_commit: bool,
    #[serde(default)]
    pub note: Option<String>,
    /// 不传就是 JVM 桥（老前端 / 老配置都走这条）。
    #[serde(default)]
    pub engine: Option<String>,
}

impl DbConnInput {
    fn to_config(&self, id: String, password_dpapi: Option<String>) -> DbConnConfig {
        let name = self.name.trim();
        DbConnConfig {
            id,
            name: if name.is_empty() {
                db_conns::default_name(&self.url)
            } else {
                name.to_string()
            },
            env: db_conns::normalize_env(&self.env),
            source: if self.source == "prop" {
                "prop"
            } else {
                "manual"
            }
            .to_string(),
            url: self.url.trim().to_string(),
            user: self.user.trim().to_string(),
            prop_ds: self.prop_ds.clone(),
            password_dpapi,
            auto_commit: self.auto_commit,
            // prop 来源也可以选 Rust 引擎：连之前会用 JVM 桥把口令解一次存进 DPAPI
            // （见 `db_cmds::prop_password_ready`）。老配置缺 `engine` 时仍是 JVM 桥。
            engine: crate::db_engine::EngineKind::parse(self.engine.as_deref().unwrap_or(""))
                .as_str()
                .to_string(),
            note: self.note.clone().unwrap_or_default(),
        }
    }
}

fn views(cfg: &AppConfig) -> Vec<DbConnView> {
    cfg.db_conns.iter().map(DbConnView::from).collect()
}

/// prop.xml 里的数据源（桥里现读，不含口令）。`None` = 没有 NC home / prop.xml。
async fn prop_sources(
    app: &AppHandle,
    st: &Arc<AppState>,
    cfg: &AppConfig,
) -> Result<Value, String> {
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
    let b = bridge_for(app, st, cfg, PROBE, crate::db_engine::EngineKind::Java)?;
    call(b, "propList", vec![home.root], Duration::from_secs(60)).await
}

/// 连接列表。**第一次**打开时做初始化：迁移旧版单连接配置，并把 prop.xml 里的数据源
/// 自动加进来（之后用户删掉的不会再自动加回）。
#[tauri::command]
pub async fn db_conn_list(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<DbConnView>, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    if cfg.db_conns_init {
        return Ok(views(&cfg));
    }
    // prop.xml 列不出来（没 NC home、缺 jar）不阻塞初始化：用户还能手动添加
    let found = prop_sources(&app, &st, &cfg).await.ok();
    let cfg = st
        .update_config(|c| {
            db_conns::migrate_legacy(c);
            if let Some(v) = &found {
                add_prop_sources(c, v, None);
            }
            c.db_conns_init = true;
            Ok(())
        })
        .await?;
    Ok(views(&cfg))
}

/// 把 propList 的结果加进连接列表；`only` 给定时只加这些数据源名。返回加了几条。
fn add_prop_sources(cfg: &mut AppConfig, v: &Value, only: Option<&[String]>) -> usize {
    let mut n = 0;
    for s in v
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = s.get("name").and_then(Value::as_str).unwrap_or("");
        let url = s.get("url").and_then(Value::as_str).unwrap_or("");
        let user = s.get("user").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() || url.is_empty() {
            continue;
        }
        if only.is_some_and(|o| !o.iter().any(|x| x == name)) {
            continue;
        }
        if cfg
            .db_conns
            .iter()
            .any(|c| db_conns::same_target(&c.url, &c.user, url, user))
        {
            continue;
        }
        cfg.db_conns.push(DbConnConfig {
            id: db_conns::new_id(),
            name: db_conns::default_name(url),
            env: "test".to_string(),
            source: "prop".to_string(),
            url: url.to_string(),
            user: user.to_string(),
            prop_ds: Some(name.to_string()),
            password_dpapi: None,
            auto_commit: false,
            engine: crate::db_engine::EngineKind::Java.as_str().to_string(),
            note: format!("NC prop.xml · {name}"),
        });
        n += 1;
    }
    n
}

/// 「从 NC prop.xml 导入」对话框：列出数据源，并标出哪些已经添加过。
#[tauri::command]
pub async fn db_prop_sources(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let mut v = prop_sources(&app, &st, &cfg).await?;
    if let Some(arr) = v.get_mut("sources").and_then(Value::as_array_mut) {
        for s in arr.iter_mut() {
            let url = s
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let user = s
                .get("user")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let added = cfg
                .db_conns
                .iter()
                .any(|c| db_conns::same_target(&c.url, &c.user, &url, &user));
            s["added"] = Value::Bool(added);
        }
    }
    Ok(v)
}

/// 勾选导入 prop.xml 的数据源，环境统一设为 `env`。返回新的连接列表。
#[tauri::command]
pub async fn db_prop_import(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    names: Vec<String>,
    env: String,
) -> Result<Vec<DbConnView>, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let v = prop_sources(&app, &st, &cfg).await?;
    let env = db_conns::normalize_env(&env);
    let cfg = st
        .update_config(|c| {
            let before = c.db_conns.len();
            add_prop_sources(c, &v, Some(&names));
            for x in c.db_conns.iter_mut().skip(before) {
                x.env = env.clone();
            }
            Ok(())
        })
        .await?;
    Ok(views(&cfg))
}

/// 新建或保存连接。`password` 有值时：`remember` 为真存 DPAPI 密文，为假清掉存过的。
#[tauri::command]
pub async fn db_conn_save(
    state: tauri::State<'_, Arc<AppState>>,
    conn: DbConnInput,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<DbConnView, String> {
    if conn.source != "prop" && conn.url.trim().is_empty() {
        return Err("连接串不能为空".to_string());
    }
    let enc = match password.as_deref().filter(|p| !p.is_empty()) {
        Some(p) if remember.unwrap_or(true) => Some(Some(protect(p)?)),
        Some(_) => Some(None),
        None => None, // 没输口令：保持原样
    };
    let id = conn.id.clone().unwrap_or_else(db_conns::new_id);
    let cfg = state
        .update_config(|c| {
            let old = c.db_conns.iter().position(|x| x.id == id);
            let keep = old.and_then(|i| c.db_conns[i].password_dpapi.clone());
            let next = conn.to_config(id.clone(), enc.clone().unwrap_or(keep));
            match old {
                Some(i) => c.db_conns[i] = next,
                None => c.db_conns.push(next),
            }
            Ok(())
        })
        .await?;
    let saved = find_conn(&cfg, &id)?;
    Ok(DbConnView::from(&saved))
}

/// 删除连接（同时关掉它的桥；未提交的改动会被回滚——界面已先确认）。
#[tauri::command]
pub async fn db_conn_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<DbConnView>, String> {
    drop_bridge(&state, &id);
    let cfg = state
        .update_config(|c| {
            c.db_conns.retain(|x| x.id != id);
            if c.db_active.as_deref() == Some(id.as_str()) {
                c.db_active = None;
            }
            Ok(())
        })
        .await?;
    Ok(views(&cfg))
}

/// 调整顺序：按给定的 id 顺序重排（没列到的保持原相对顺序放最后）。
#[tauri::command]
pub async fn db_conn_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    ids: Vec<String>,
) -> Result<Vec<DbConnView>, String> {
    let cfg = state
        .update_config(|c| {
            let pos = |id: &str| ids.iter().position(|x| x == id).unwrap_or(usize::MAX);
            c.db_conns.sort_by_key(|x| pos(&x.id));
            Ok(())
        })
        .await?;
    Ok(views(&cfg))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub product: String,
    pub version: String,
    pub ms: u64,
    /// 账号下可见的表数（让人一眼看出是不是连错了库）。
    pub tables: Option<u64>,
}

/// 测试连接：用临时桥连一下就断，不影响任何已开的会话。
/// `password` 为空且是已保存的连接时，用存过的口令。
#[tauri::command]
pub async fn db_conn_test(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    conn: DbConnInput,
    password: Option<String>,
) -> Result<TestResult, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let stored = conn
        .id
        .as_deref()
        .and_then(|id| find_conn(&cfg, id).ok())
        .and_then(|c| c.password_dpapi);
    let mut draft = conn.to_config("__test".into(), stored);
    let engine = crate::db_engine::EngineKind::parse(&draft.engine);
    // 测试也要按用户选的引擎来：选 Rust 却用 JVM 测，测通了真连也可能失败
    if engine != crate::db_engine::EngineKind::Java && draft.source == "prop" {
        prop_password_ready(&app, &st, &cfg, &mut draft, password.as_deref(), PROBE).await?;
    }
    let (cmd, args) = connect_args(&cfg, &draft, password.as_deref(), true, engine)?;
    let b = bridge_for(&app, &st, &cfg, PROBE, engine)?;
    let t0 = Instant::now();
    let out = call(b.clone(), cmd, args, Duration::from_secs(60)).await?;
    let ms = t0.elapsed().as_millis() as u64;
    let count = call(
        b.clone(),
        "exec",
        vec![
            "select count(*) from user_tables".into(),
            "1".into(),
            "15".into(),
        ],
        Duration::from_secs(30),
    )
    .await
    .ok()
    .and_then(|v| {
        v["rows"][0][0]
            .as_str()
            .and_then(|s| s.parse().ok())
            .or(v["rows"][0][0].as_u64())
    });
    let _ = call(b, "disconnect", vec![], Duration::from_secs(10)).await;
    // 测试用的句柄用完就撤：换了引擎或换了账号还留着它，下次测试会复用错的东西
    drop_bridge(&st, PROBE);
    let s = |k: &str| out.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Ok(TestResult {
        product: s("product"),
        version: s("version"),
        ms,
        tables: count,
    })
}

/// 导入 `.properties`（url / user / pwd，与 nc-db 工具的 `--conf` 文件同格式）为一条手动连接。
///
/// 收文件**内容**而不是路径：界面用浏览器的文件选择框读文件（没有引入原生对话框插件），
/// 拿不到真实路径。口令在这里解析后立刻 DPAPI 加密保存，不回给前端。
#[tauri::command]
pub async fn db_conn_import_props(
    state: tauri::State<'_, Arc<AppState>>,
    text: String,
    file: String,
    name: Option<String>,
    env: String,
) -> Result<DbConnView, String> {
    let (url, user, pwd) = db_conns::parse_properties(&text)?;
    let enc = if pwd.is_empty() {
        None
    } else {
        Some(protect(&pwd)?)
    };
    let id = db_conns::new_id();
    let input = DbConnInput {
        id: None,
        name: name.unwrap_or_default(),
        env,
        source: "manual".into(),
        url,
        user,
        prop_ds: None,
        auto_commit: false,
        note: Some(format!("导入 {file}")),
        engine: None,
    };
    let cfg = state
        .update_config(|c| {
            if c.db_conns
                .iter()
                .any(|x| db_conns::same_target(&x.url, &x.user, &input.url, &input.user))
            {
                return Err(code_label("dup", "这个库和账号已经在连接列表里了"));
            }
            c.db_conns.push(input.to_config(id.clone(), enc.clone()));
            Ok(())
        })
        .await?;
    Ok(DbConnView::from(&find_conn(&cfg, &id)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prop_数据源去重且只加勾选的() {
        let v = serde_json::json!({ "sources": [
            { "name": "design", "url": "jdbc:oracle:thin:@h:1521/a", "user": "u" },
            { "name": "his", "url": "jdbc:oracle:thin:@h:1521/b", "user": "v" }
        ]});
        let mut cfg = AppConfig::default();
        assert_eq!(
            add_prop_sources(&mut cfg, &v, Some(&["his".to_string()])),
            1
        );
        assert_eq!(cfg.db_conns[0].prop_ds.as_deref(), Some("his"));
        assert_eq!(
            add_prop_sources(&mut cfg, &v, None),
            1,
            "his 已有，只加 design"
        );
        assert_eq!(add_prop_sources(&mut cfg, &v, None), 0);
    }

    #[test]
    fn 视图不带口令密文() {
        let c = DbConnConfig {
            id: "a".into(),
            name: "n".into(),
            env: "PROD".into(),
            source: "manual".into(),
            url: "u".into(),
            user: "x".into(),
            prop_ds: None,
            password_dpapi: Some("AQAA密文".into()),
            auto_commit: false,
            engine: String::new(),
            note: String::new(),
        };
        let v = serde_json::to_string(&DbConnView::from(&c)).unwrap();
        assert!(!v.contains("AQAA"), "{v}");
        assert!(v.contains("\"hasPassword\":true"));
        assert!(v.contains("\"env\":\"prod\""));
    }

    #[test]
    fn 名字留空用库名() {
        let i = DbConnInput {
            id: None,
            name: "  ".into(),
            env: "dev".into(),
            source: "x".into(),
            url: "jdbc:oracle:thin:@h:1521/ncdev".into(),
            user: "u".into(),
            prop_ds: None,
            auto_commit: true,
            note: None,
            engine: None,
        };
        let c = i.to_config("id".into(), None);
        assert_eq!(c.name, "ncdev");
        assert_eq!(c.source, "manual", "未知来源按手动处理");
    }
}
