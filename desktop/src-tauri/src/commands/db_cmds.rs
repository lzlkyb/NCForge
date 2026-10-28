//! 数据库命令层：连接、只读查询、表名列表。
//!
//! 三条约定：
//! 1. **密码不落明文**：`prop.xml` 里那串是 NC 自己的加密格式（8 字节 DES 块，密钥在核心
//!    技术 jar 里，这台 NC home 找不到对应类），解不出来；所以首次由用户输一次，之后用
//!    DPAPI 存在本机配置里（与 SVN 凭据同一套）。
//! 2. **只读由桥保证**（语句白名单 + `SET TRANSACTION READ ONLY` + rollback 三道光），
//!    命令层只做参数校验，不再自己拼 SQL。
//! 3. **连接串以 prop.xml 为准**，配置里可以覆盖（换库调试时不用改 NC 的配置文件）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::config::AppConfig;
use crate::db_bridge::{self, Bridge};
use crate::db_schema;
use crate::sql_refs;
use crate::state::AppState;
use crate::svn_cred;

/// 连库（含握手）留足余量；查询的超时由 JDBC 的 queryTimeout 管。
const T_CONNECT: Duration = Duration::from_secs(60);
const T_QUERY: Duration = Duration::from_secs(120);

// ───────────────────────── DTO ─────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PropDb {
    pub url: String,
    pub user: String,
    pub database_type: String,
    /// prop.xml 里 `isEncode=true`：口令是 NC 加密格式，我们解不开。
    pub password_encoded: bool,
    /// 从哪个文件读到的（界面显示「配置来源」）。
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbDefaults {
    pub url: Option<String>,
    pub user: Option<String>,
    pub database_type: Option<String>,
    pub source: String,
    /// 配置里存过密码（DPAPI 密文），界面可以只显示「已记住」。
    pub has_password: bool,
    /// 密码是否来自 prop.xml 且为 NC 加密格式（需要用户手输一次）。
    pub password_needs_input: bool,
    /// 有没有找到 ojdbc 驱动。
    pub driver_found: bool,
    pub driver_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub name: String,
    /// 带长度的类型名：`VARCHAR2(40)`。
    #[serde(rename = "type")]
    pub type_name: String,
    #[serde(default)]
    pub precision: i64,
    #[serde(default)]
    pub scale: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTable {
    pub name: String,
    /// `TABLE` / `VIEW`。
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectResult {
    pub url: String,
    pub user: String,
    pub product: String,
    pub version: String,
    pub read_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<DbColumn>,
    /// 单元格原样给前端：数字是 number、文本是 string、空值是 null。
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub truncated: bool,
    pub ms: u64,
    /// 命中的表名其实不存在时，前端可以给「相近的表名」提示。
    pub sql: String,
}

// ───────────────────────── prop.xml ─────────────────────────

/// 解析 NC 的 `ierp/bin/prop.xml`，取基础数据源。
///
/// 只做「按标签取值」级别的解析，不上 XML 库：文件结构固定（一个 root 下若干
/// `dataSource`），而多引一个 XML 依赖只为读四个字段不划算。
/// 多个 dataSource 时优先 `isBase=true` 那个（NC 自己也是用它连库）。
pub fn parse_prop(bytes: &[u8], source: &str) -> Result<PropDb, String> {
    // prop.xml 声明 gb2312；中文只出现在注释里，但解码错了会让后续切片偏移，统一先转 UTF-8
    let xml = String::from_utf8_lossy(bytes).to_string();
    let blocks = split_data_sources(&xml);
    if blocks.is_empty() {
        return Err("prop.xml 里没有 <dataSource>，可能读错了文件".to_string());
    }
    let mut picked: Option<&str> = None;
    for b in &blocks {
        if tag(b, "isBase")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
        {
            picked = Some(b);
            break;
        }
    }
    let block = picked.unwrap_or(blocks[0]);
    let url = tag(block, "databaseUrl")
        .ok_or_else(|| "prop.xml 的 dataSource 里没有 databaseUrl".to_string())?;
    let user = tag(block, "user").unwrap_or_default();
    let database_type = tag(block, "databaseType").unwrap_or_default();
    let encoded = tag(&xml, "isEncode")
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    Ok(PropDb {
        url,
        user,
        database_type,
        password_encoded: encoded,
        source: source.to_string(),
    })
}

/// 切出每个 `<dataSource>…</dataSource>` 的内容（可能有多个）。
fn split_data_sources(xml: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<dataSource>") {
        let after = &rest[start + "<dataSource>".len()..];
        let Some(end) = after.find("</dataSource>") else {
            break;
        };
        out.push(&after[..end]);
        rest = &after[end..];
    }
    out
}

fn tag(block: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&close)? + start;
    let v = block[start..end].trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// 找 NC home 下的 prop.xml。
fn prop_path(nc_home: &Path) -> Option<PathBuf> {
    let cands = [
        nc_home.join("ierp").join("bin").join("prop.xml"),
        nc_home.join("bin").join("prop.xml"),
    ];
    cands.into_iter().find(|p| p.is_file())
}

fn read_prop(cfg: &AppConfig) -> Option<PropDb> {
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref()).ok()?;
    let p = prop_path(Path::new(&home.root))?;
    let bytes = std::fs::read(&p).ok()?;
    parse_prop(&bytes, &p.display().to_string()).ok()
}

// ───────────────────────── 桥 ─────────────────────────

fn resource_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir.join("ncdb"));
    }
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ncdb"));
    dirs
}

fn bridge_for(app: &AppHandle, state: &AppState, cfg: &AppConfig) -> Result<Arc<Bridge>, String> {
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
    let java = PathBuf::from(&home.java);
    let (jar, _) = db_bridge::find_jar(&resource_dirs(app))
        .ok_or_else(|| "找不到内置的 ncdb.jar，安装包可能不完整".to_string())?;
    let driver = db_bridge::find_driver(Path::new(&home.root)).ok_or_else(|| {
        format!(
            "{} 下没有 Oracle 驱动（driver/oracle_11g/ojdbc6.jar）",
            home.root
        )
    })?;
    let cfg_dir = state.config_dir.join("db");
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("建目录失败 {cfg_dir:?}: {e}"))?;

    let mut guard = state
        .db
        .lock()
        .map_err(|_| "数据库桥状态异常".to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.env().java == java {
            return Ok(existing.clone());
        }
        existing.shutdown();
    }
    let bridge = Arc::new(Bridge::new(db_bridge::env(java, jar, driver, cfg_dir)));
    *guard = Some(bridge.clone());
    Ok(bridge)
}

fn code_label(code: &str, message: &str) -> String {
    format!("{code}|{message}")
}

/// 把桥的 SQL 错误翻译成前端好用的码：认证失败要弹输密码框，别的只显示。
fn map_sql_error(message: &str) -> String {
    let m = message.to_lowercase();
    if m.contains("ora-01017") || m.contains("invalid username/password") || m.contains("登录被拒")
    {
        return code_label("auth", message);
    }
    if m.contains("ora-12541") || m.contains("ora-12514") || m.contains("no listener") {
        return code_label("unreachable", message);
    }
    code_label("sql", message)
}

// ───────────────────────── 命令 ─────────────────────────

/// 连库前要知道的事：从哪读的连接串、有没有驱动、有没有存过密码。
#[tauri::command]
pub async fn db_defaults(state: tauri::State<'_, Arc<AppState>>) -> Result<DbDefaults, String> {
    let cfg = state.config.read().await.clone();
    let prop = read_prop(&cfg);
    let driver = crate::nc_home::resolve(cfg.nc_home.as_deref())
        .ok()
        .and_then(|h| db_bridge::find_driver(Path::new(&h.root)));
    let url = cfg
        .db_url
        .clone()
        .or_else(|| prop.as_ref().map(|p| p.url.clone()));
    let user = cfg
        .db_user
        .clone()
        .or_else(|| prop.as_ref().map(|p| p.user.clone()));
    let source = if cfg.db_url.is_some() {
        "配置".to_string()
    } else {
        prop.as_ref().map(|p| p.source.clone()).unwrap_or_default()
    };
    Ok(DbDefaults {
        url,
        user,
        database_type: prop
            .as_ref()
            .map(|p| p.database_type.clone())
            .filter(|s| !s.is_empty()),
        source,
        has_password: cfg.db_password_dpapi.is_some(),
        password_needs_input: cfg.db_password_dpapi.is_none(),
        driver_found: driver.is_some(),
        driver_path: driver.map(|p| p.display().to_string()),
    })
}

/// 连库。`password` 为空时用配置里存的（DPAPI 解出来的）。
#[tauri::command]
pub async fn db_connect(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    password: Option<String>,
) -> Result<DbConnectResult, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();

    let prop = read_prop(&cfg);
    let url = cfg
        .db_url
        .clone()
        .or_else(|| prop.as_ref().map(|p| p.url.clone()))
        .ok_or_else(|| {
            "没有数据库连接串：NC home 下找不到 ierp/bin/prop.xml，也没在配置里指定".to_string()
        })?;
    let user = cfg
        .db_user
        .clone()
        .or_else(|| prop.as_ref().map(|p| p.user.clone()))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "没有数据库用户名（prop.xml 的 dataSource 里没有 <user>）".to_string())?;

    let typed = password.unwrap_or_default();
    let pass = if !typed.is_empty() {
        typed.clone()
    } else {
        match cfg.db_password_dpapi.as_deref() {
            Some(enc) => {
                let raw = svn_cred::b64_decode(enc)
                    .ok_or_else(|| "存着的数据库口令不是合法的 base64".to_string())?;
                let plain = svn_cred::dpapi_unprotect(&raw)
                    .map_err(|e| format!("存着的数据库口令解不开（换机器/换用户会这样）：{e}"))?;
                String::from_utf8(plain).map_err(|e| format!("口令解码失败：{e}"))?
            }
            None => return Err(code_label("need-password", "还没输入数据库密码")),
        }
    };

    let bridge = bridge_for(&app, &st, &cfg)?;
    // url / user 后面还要回给前端（连接胶囊上显示「连的是哪个库」），闭包里只借副本
    let (url_arg, user_arg) = (url.clone(), user.clone());
    let out = tauri::async_runtime::spawn_blocking(move || {
        bridge.call("connect", &[&url_arg, &user_arg, &pass], T_CONNECT)
    })
    .await
    .map_err(|e| format!("连库失败：{e}"))?
    .map_err(|e| map_sql_error(&e.message))?;

    // 连接成功且是新输入的密码 → 记住（DPAPI，只在本机本用户可解）
    if !typed.is_empty() {
        let enc = svn_cred::dpapi_protect(typed.as_bytes())?;
        let encoded = svn_cred::b64_encode(&enc);
        let _ = st
            .update_config(|c| {
                c.db_password_dpapi = Some(encoded);
                Ok(())
            })
            .await;
    }

    Ok(DbConnectResult {
        url,
        user,
        product: out
            .get("product")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        version: out
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        read_only: out
            .get("readOnly")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    })
}

/// 跑一条只读查询。
#[tauri::command]
pub async fn db_query(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    sql: String,
    max_rows: Option<u32>,
    timeout_sec: Option<u32>,
) -> Result<QueryResult, String> {
    if sql.trim().is_empty() {
        return Err("SQL 是空的".to_string());
    }
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let bridge = bridge_for(&app, &st, &cfg)?;
    let max_rows = max_rows.unwrap_or(500).min(2000).to_string();
    let timeout = timeout_sec.unwrap_or(30).min(120).to_string();

    let sql_arg = sql.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        bridge.call("query", &[&sql_arg, &max_rows, &timeout], T_QUERY)
    })
    .await
    .map_err(|e| format!("查询失败：{e}"))?
    .map_err(|e| map_sql_error(&e.message))?;

    let columns = out
        .get("columns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|c| DbColumn {
                    name: c
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    type_name: c
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    precision: c.get("precision").and_then(|v| v.as_i64()).unwrap_or(0),
                    scale: c.get("scale").and_then(|v| v.as_i64()).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();

    let rows: Vec<Vec<serde_json::Value>> = out
        .get("rows")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|r| r.as_array().cloned().unwrap_or_default())
                .collect()
        })
        .unwrap_or_default();

    Ok(QueryResult {
        columns,
        row_count: rows.len(),
        rows,
        truncated: out
            .get("truncated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        ms: out.get("ms").and_then(|v| v.as_u64()).unwrap_or(0),
        sql,
    })
}

/// 表名列表（下拉提示 + 「表名写错」时的相近名称建议）。
#[tauri::command]
pub async fn db_tables(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<DbTable>, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let bridge = bridge_for(&app, &st, &cfg)?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        bridge.call("tables", &[], Duration::from_secs(120))
    })
    .await
    .map_err(|e| format!("取表名失败：{e}"))?
    .map_err(|e| map_sql_error(&e.message))?;

    Ok(out
        .get("tables")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| DbTable {
                    name: t
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    kind: t
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default())
}

// ───────────────────────── 表结构缓存与出包核对 ─────────────────────────

/// 当前要连哪个库：配置优先，其次 `prop.xml` 的基础数据源。
fn current_db(cfg: &AppConfig) -> Result<(String, String), String> {
    let prop = read_prop(cfg);
    let url = cfg
        .db_url
        .clone()
        .or_else(|| prop.as_ref().map(|p| p.url.clone()))
        .ok_or_else(|| "没有数据库连接串：NC home 下找不到 prop.xml，也没在配置里指定".to_string())?;
    let user = cfg
        .db_user
        .clone()
        .or_else(|| prop.as_ref().map(|p| p.user.clone()))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "没有数据库用户名（prop.xml 的 dataSource 里没有 <user>）".to_string())?;
    Ok((url, user))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaStatus {
    pub has: bool,
    pub url: String,
    pub user: String,
    /// 拉取时刻（Unix 秒），没有缓存时是 0。
    pub fetched_at: u64,
    pub age_secs: u64,
    pub tables: usize,
    pub columns: usize,
}

fn status_of(cache: Option<&db_schema::SchemaCache>, url: &str, user: &str) -> SchemaStatus {
    let now = db_schema::now_secs();
    match cache {
        Some(c) => SchemaStatus {
            has: true,
            url: url.to_string(),
            user: user.to_string(),
            fetched_at: c.fetched_at,
            age_secs: now.saturating_sub(c.fetched_at),
            tables: c.tables.len(),
            columns: c.column_count(),
        },
        None => SchemaStatus {
            has: false,
            url: url.to_string(),
            user: user.to_string(),
            fetched_at: 0,
            age_secs: 0,
            tables: 0,
            columns: 0,
        },
    }
}

/// 表结构缓存的状态（不连库，只读本地文件）。
#[tauri::command]
pub async fn db_schema_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SchemaStatus, String> {
    let cfg = state.config.read().await.clone();
    let (url, user) = current_db(&cfg)?;
    let path = db_schema::cache_path(&state.config_dir, &url, &user);
    let cache = db_schema::load(&path, &url, &user);
    Ok(status_of(cache.as_ref(), &url, &user))
}

/// 从库里把表结构整个拉一遍，落盘。
///
/// 一次拉完而不是分页：库里两千多张表约几万列，JSON 几 MB，桥的行协议没有长度限制。
/// 分页反而更慢——Java 侧每页都要把 `getColumns` 的结果从头 skip 一遍（O(n²)）。
#[tauri::command]
pub async fn db_schema_sync(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SchemaStatus, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let (url, user) = current_db(&cfg)?;
    let bridge = bridge_for(&app, &st, &cfg)?;

    let out = tauri::async_runtime::spawn_blocking(move || {
        bridge.call("schema", &["0", "2000000"], Duration::from_secs(180))
    })
    .await
    .map_err(|e| format!("拉表结构失败：{e}"))?
    .map_err(|e| map_sql_error(&e.message))?;

    let rows: Vec<(String, String, String)> = out
        .get("rows")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let t = r.get("table")?.as_str()?.to_string();
                    let c = r.get("column")?.as_str()?.to_string();
                    let ty = db_schema::fmt_type(
                        r.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                        r.get("size").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                    );
                    Some((t, c, ty))
                })
                .collect()
        })
        .unwrap_or_default();

    if rows.is_empty() {
        return Err(code_label(
            "sql",
            "库里没读到任何列定义——账号可能没有数据字典权限，或者连错了库",
        ));
    }

    let cache = db_schema::SchemaCache::build(&url, &user, db_schema::now_secs(), &rows);
    let path = db_schema::cache_path(&st.config_dir, &url, &user);
    db_schema::save(&path, &cache)?;
    Ok(status_of(Some(&cache), &url, &user))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTableColumns {
    pub table: String,
    pub columns: Vec<DbColumn>,
    /// 来自本地缓存（界面显示「缓存」而不是「现查」）。
    pub from_cache: bool,
}

/// 单表字段。有缓存走缓存（悬停要快），没缓存就现查一次。
#[tauri::command]
pub async fn db_columns(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    table: String,
) -> Result<DbTableColumns, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let (url, user) = current_db(&cfg)?;
    if let Some(c) = db_schema::load(
        &db_schema::cache_path(&st.config_dir, &url, &user),
        &url,
        &user,
    ) {
        if let Some(t) = c.tables.get(&table.to_lowercase()) {
            return Ok(DbTableColumns {
                table,
                columns: t
                    .columns
                    .iter()
                    .map(|(n, ty)| DbColumn {
                        name: n.clone(),
                        type_name: ty.clone(),
                        precision: 0,
                        scale: 0,
                    })
                    .collect(),
                from_cache: true,
            });
        }
    }

    let bridge = bridge_for(&app, &st, &cfg)?;
    let arg = table.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        bridge.call("columns", &[&arg], Duration::from_secs(60))
    })
    .await
    .map_err(|e| format!("取字段失败：{e}"))?
    .map_err(|e| map_sql_error(&e.message))?;

    let columns = out
        .get("columns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|c| DbColumn {
                    name: c
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    type_name: db_schema::fmt_type(
                        c.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                        c.get("size").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                    ),
                    precision: 0,
                    scale: 0,
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(DbTableColumns {
        table,
        columns,
        from_cache: false,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckIssue {
    /// `table`（表不存在）或 `column`（字段不存在）。
    pub kind: String,
    pub table: String,
    pub column: Option<String>,
    /// 相对工作区根的路径（给界面显示）。
    pub rel: String,
    pub abs: String,
    pub line: usize,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCheck {
    /// 实际读到的文件数。
    pub files: usize,
    /// 读不了的文件数（二进制/过大），不参与核对。
    pub skipped: usize,
    /// 这些文件里引用到的表数（去重）。
    pub tables: usize,
    pub columns: usize,
    pub missing_tables: usize,
    pub missing_columns: usize,
    pub issues: Vec<CheckIssue>,
    pub schema_tables: usize,
    pub schema_age_secs: u64,
}

/// 出包前核对：源码里引用的表和字段，在库里是不是真的存在。
///
/// 只报「确定对不上」的：表名不在库里就算不存在；字段只有在别名能解析到表、
/// 且该表（们）里都没有这个列时才报。宁可漏报不误报——一次误报就没人再看这个功能了。
#[tauri::command]
pub async fn db_check_sources(
    state: tauri::State<'_, Arc<AppState>>,
    files: Vec<String>,
) -> Result<SourceCheck, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let (url, user) = current_db(&cfg)?;
    let cache = db_schema::load(
        &db_schema::cache_path(&st.config_dir, &url, &user),
        &url,
        &user,
    )
    .ok_or_else(|| code_label("need-schema", "还没有表结构缓存，先连库拉一次"))?;
    let root = cfg
        .workspace_root
        .clone()
        .ok_or_else(|| "还没打开工作区".to_string())?;

    let index = cache.index();
    let schema_tables = cache.tables.len();
    let schema_age_secs = db_schema::now_secs().saturating_sub(cache.fetched_at);
    let roots = vec![root.clone()];

    tauri::async_runtime::spawn_blocking(move || {
        let mut issues: Vec<CheckIssue> = Vec::new();
        let mut seen_t: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut n_files = 0usize;
        let mut n_skip = 0usize;
        let mut n_cols = 0usize;

        for f in &files {
            let Ok(abs) = crate::security::path::resolve_safe_path(f, &roots, &[], true) else {
                n_skip += 1;
                continue;
            };
            let Ok(fc) = crate::workspace::read_text_file(&abs) else {
                n_skip += 1;
                continue;
            };
            n_files += 1;
            let abs_disp = crate::security::path::display_path(&abs);
            let rel = rel_of(&abs_disp, &root);
            let refs = sql_refs::parse(&fc.text);
            for t in &refs.tables {
                seen_t.insert(t.name.to_lowercase());
            }
            n_cols += refs.columns.len();
            for it in sql_refs::check_file(&rel, &refs, &index) {
                issues.push(CheckIssue {
                    kind: match it.kind {
                        sql_refs::IssueKind::MissingTable => "table".to_string(),
                        sql_refs::IssueKind::MissingColumn => "column".to_string(),
                    },
                    table: it.table,
                    column: it.column,
                    rel: it.file,
                    abs: abs_disp.clone(),
                    line: it.line,
                    suggestions: it.suggestions,
                });
            }
        }

        let missing_tables = issues.iter().filter(|i| i.kind == "table").count();
        let missing_columns = issues.iter().filter(|i| i.kind == "column").count();
        // 按文件+行号排，界面上是「跟着代码从上往下看」的顺序
        issues.sort_by(|a, b| a.rel.cmp(&b.rel).then_with(|| a.line.cmp(&b.line)));

        SourceCheck {
            files: n_files,
            skipped: n_skip,
            tables: seen_t.len(),
            columns: n_cols,
            missing_tables,
            missing_columns,
            issues,
            schema_tables,
            schema_age_secs,
        }
    })
    .await
    .map_err(|e| format!("核对失败：{e}"))
}

/// 相对工作区根的展示路径；不在根下就原样给绝对路径。
fn rel_of(abs: &str, root: &str) -> String {
    let a = abs.replace('\\', "/");
    let r = root.replace('\\', "/");
    let r = r.trim_end_matches('/');
    a.strip_prefix(r)
        .map(|s| s.trim_start_matches('/').to_string())
        .unwrap_or(a)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTables {
    pub tables: Vec<String>,
    pub fetched_at: u64,
    pub url: String,
    pub user: String,
}

/// 缓存里的全部表名（不连库）。
///
/// 悬停要靠它判断「光标下的这个词是不是表名」——每移动一次鼠标问一次后端不现实，
/// 前端拉到这份列表后自己判断，只有确认是表名才回来要字段。
/// 没缓存时返回空列表（不是错误）：界面据此显示「先去拉一次」。
#[tauri::command]
pub async fn db_cached_tables(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CachedTables, String> {
    let cfg = state.config.read().await.clone();
    let (url, user) = current_db(&cfg)?;
    let cache = db_schema::load(
        &db_schema::cache_path(&state.config_dir, &url, &user),
        &url,
        &user,
    );
    Ok(match cache {
        Some(c) => CachedTables {
            tables: c.tables.keys().cloned().collect(),
            fetched_at: c.fetched_at,
            url,
            user,
        },
        None => CachedTables {
            tables: Vec::new(),
            fetched_at: 0,
            url,
            user,
        },
    })
}

/// 断开连接（换库、或连接卡死时用）。
#[tauri::command]
pub async fn db_disconnect(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    // 只在取 Arc 时持锁：`disconnect` 要等桥回话（最长 10s），持锁等会把整个命令层
    // 卡住——包括这一屏的其它查询请求。
    let bridge = {
        let guard = state
            .db
            .lock()
            .map_err(|_| "数据库桥状态异常".to_string())?;
        guard.as_ref().cloned()
    };
    let Some(b) = bridge else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        // 先让桥自己收干净（rollback + close），再杀掉进程
        let _ = b.call("disconnect", &[], Duration::from_secs(10));
        b.restart();
    })
    .await
    .map_err(|e| format!("断开连接失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding='gb2312'?>
<root ClassType="nc.uap.plugin.studio.ui.preference.prop.PropInfo">
  <isEncode>true</isEncode>
  <dataSource>
    <dataSourceName>design</dataSourceName>
    <databaseUrl>jdbc:oracle:thin:@10.200.22.144:1521/aier260824</databaseUrl>
    <user>aier633</user>
    <password>mlboiblaogcdobfe</password>
    <databaseType>ORACLE11G</databaseType>
    <isBase>false</isBase>
  </dataSource>
  <dataSource>
    <dataSourceName>main</dataSourceName>
    <databaseUrl>jdbc:oracle:thin:@10.200.22.145:1521/aier</databaseUrl>
    <user>aier</user>
    <databaseType>ORACLE11G</databaseType>
    <isBase>true</isBase>
  </dataSource>
</root>"#;

    #[test]
    fn 取_isbase_那个数据源() {
        let p = parse_prop(SAMPLE.as_bytes(), "t").expect("应能解析");
        assert_eq!(p.url, "jdbc:oracle:thin:@10.200.22.145:1521/aier");
        assert_eq!(p.user, "aier");
        assert_eq!(p.database_type, "ORACLE11G");
        assert!(p.password_encoded, "isEncode=true 要标出来");
    }

    #[test]
    fn 没有_isbase_时退回第一个() {
        let xml = SAMPLE.replace("<isBase>true</isBase>", "<isBase>false</isBase>");
        let p = parse_prop(xml.as_bytes(), "t").unwrap();
        assert_eq!(p.user, "aier633");
    }

    #[test]
    fn 没有数据源要报错() {
        let e = parse_prop(b"<root></root>", "t").unwrap_err();
        assert!(e.contains("dataSource"), "{e}");
    }

    #[test]
    fn oracle_认证失败要转成_auth() {
        assert!(map_sql_error("ORA 1017：ORA-01017: 用户名/口令无效").starts_with("auth|"));
        assert_eq!(
            map_sql_error("ORA 942：表或视图不存在"),
            "sql|ORA 942：表或视图不存在"
        );
        // 网络不通要单独给码，前端才能提示「检查 VPN / 库是否起了」
        assert!(map_sql_error("ORA-12541: TNS:no listener").starts_with("unreachable|"));
    }
}
