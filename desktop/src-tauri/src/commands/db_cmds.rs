//! 数据库命令层：多连接、执行任意语句、事务、元数据；以及表结构缓存与出包核对。
//!
//! 约定：
//! 1. **一个连接一个桥进程**（`state.db` 按连接 id 存）：一个库上的慢查询不会把另一个库的
//!    操作堵在后面，桥里也不用处理并发。JVM 常驻约几十 MB，同时开两三个库可以接受。
//! 2. **读写不在软件里限制**：能不能写由数据库账号权限决定。桥只报告事务状态
//!    （手动提交模式下几条写语句、影响多少行），界面据此提醒。
//! 3. **口令**：prop.xml 来源由桥里的 NC `PropXMLReader` 现解，不经过 Rust、不落盘；
//!    手动来源由用户输一次，DPAPI 加密存本机（与 SVN 凭据同一套）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::config::{AppConfig, DbConnConfig};
use crate::db_bridge::{self, Bridge};
use crate::db_schema;
use crate::sql_refs;
use crate::state::AppState;
use crate::svn_cred;

/// 连库（含握手）留足余量。
const T_CONNECT: Duration = Duration::from_secs(60);
/// 元数据（表清单、DDL、执行计划）。
const T_META: Duration = Duration::from_secs(120);

// ───────────────────────── prop.xml（只读解析，不含口令） ─────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PropDb {
    pub url: String,
    pub user: String,
    pub database_type: String,
    /// prop.xml 里 `isEncode=true`：口令是 NC 加密格式（要靠桥里的 PropXMLReader 解）。
    pub password_encoded: bool,
    /// 从哪个文件读到的。
    pub source: String,
}

/// 解析 NC 的 `ierp/bin/prop.xml`，取基础数据源（`isBase=true`，没有就取第一个）。
///
/// 只在「还没有任何连接配置」时给表结构缓存 / 出包核对兜底用；数据库页的连接列表
/// 走桥里的 `propList`（能列出全部数据源）。
pub fn parse_prop(bytes: &[u8], source: &str) -> Result<PropDb, String> {
    let xml = String::from_utf8_lossy(bytes).to_string();
    let blocks = split_data_sources(&xml);
    if blocks.is_empty() {
        return Err("prop.xml 里没有 <dataSource>，可能读错了文件".to_string());
    }
    let block = blocks
        .iter()
        .find(|b| {
            tag(b, "isBase")
                .map(|v| v.eq_ignore_ascii_case("true"))
                .unwrap_or(false)
        })
        .copied()
        .unwrap_or(blocks[0]);
    let url = tag(block, "databaseUrl")
        .ok_or_else(|| "prop.xml 的 dataSource 里没有 databaseUrl".to_string())?;
    Ok(PropDb {
        url,
        user: tag(block, "user").unwrap_or_default(),
        database_type: tag(block, "databaseType").unwrap_or_default(),
        password_encoded: tag(&xml, "isEncode")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
        source: source.to_string(),
    })
}

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

fn read_prop(cfg: &AppConfig) -> Option<PropDb> {
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref()).ok()?;
    let cands = [
        Path::new(&home.root)
            .join("ierp")
            .join("bin")
            .join("prop.xml"),
        Path::new(&home.root).join("bin").join("prop.xml"),
    ];
    let p = cands.into_iter().find(|p| p.is_file())?;
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

/// 桥的环境：自带 ncdb.jar + NC home 的 Oracle 驱动 + 解 prop.xml 口令要的两个 NC jar。
fn bridge_env(
    app: &AppHandle,
    state: &AppState,
    cfg: &AppConfig,
) -> Result<db_bridge::BridgeEnv, String> {
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
    let (jar, _) = db_bridge::find_jar(&resource_dirs(app))
        .ok_or_else(|| "找不到内置的 ncdb.jar，安装包可能不完整".to_string())?;
    let root = Path::new(&home.root);
    let driver = db_bridge::find_driver(root).ok_or_else(|| {
        format!(
            "{} 下没有 Oracle 驱动（driver/oracle_11g/ojdbc6.jar）",
            home.root
        )
    })?;
    let cfg_dir = state.config_dir.join("db");
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("建目录失败 {cfg_dir:?}: {e}"))?;
    Ok(db_bridge::env(
        PathBuf::from(&home.java),
        jar,
        driver,
        db_bridge::nc_decrypt_jars(root),
        cfg_dir,
    ))
}

/// 取（没有就建）某个连接的桥。`key` 是连接 id；`__probe` / `__test` 给列数据源、测试连接用。
pub(crate) fn bridge_for(
    app: &AppHandle,
    state: &AppState,
    cfg: &AppConfig,
    key: &str,
) -> Result<Arc<Bridge>, String> {
    let env = bridge_env(app, state, cfg)?;
    let mut map = state
        .db
        .lock()
        .map_err(|_| "数据库桥状态异常".to_string())?;
    if let Some(existing) = map.get(key) {
        if existing.env().java == env.java && existing.env().jars == env.jars {
            return Ok(existing.clone());
        }
        existing.shutdown();
    }
    let bridge = Arc::new(Bridge::new(env));
    map.insert(key.to_string(), bridge.clone());
    Ok(bridge)
}

/// 已经存在的桥（不新建）：没连过的连接上做元数据操作要报「先连接」，而不是偷偷起进程。
pub(crate) fn existing_bridge(state: &AppState, key: &str) -> Result<Arc<Bridge>, String> {
    let map = state
        .db
        .lock()
        .map_err(|_| "数据库桥状态异常".to_string())?;
    map.get(key)
        .cloned()
        .ok_or_else(|| code_label("not-connected", "这个连接还没连上"))
}

/// 关掉并移除某个桥（断开、删除连接时用）。
pub(crate) fn drop_bridge(state: &AppState, key: &str) {
    let b = state.db.lock().ok().and_then(|mut m| m.remove(key));
    if let Some(b) = b {
        b.shutdown();
    }
}

/// 在阻塞线程里调一次桥，错误转成 `code|message`。
pub(crate) async fn call(
    bridge: Arc<Bridge>,
    cmd: &'static str,
    args: Vec<String>,
    timeout: Duration,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        bridge.call(cmd, &refs, timeout)
    })
    .await
    .map_err(|e| format!("调用数据库桥失败：{e}"))?
    .map_err(|e| {
        if e.code == "timeout" || e.code == "spawn" {
            code_label("bridge", &e.message)
        } else {
            map_sql_error(&e.message)
        }
    })
}

pub(crate) fn code_label(code: &str, message: &str) -> String {
    format!("{code}|{message}")
}

/// 桥的 SQL 错误翻译成前端好用的码：认证失败要弹输口令框，网络不通单独提示。
pub(crate) fn map_sql_error(message: &str) -> String {
    let m = message.to_lowercase();
    if m.contains("ora-01017") || m.contains("invalid username/password") || m.contains("登录被拒")
    {
        return code_label("auth", message);
    }
    if m.contains("ora-12541")
        || m.contains("ora-12514")
        || m.contains("ora-12505")
        || m.contains("no listener")
        || m.contains("io 错误")
        || m.contains("io error")
    {
        return code_label("unreachable", message);
    }
    code_label("sql", message)
}

pub(crate) fn find_conn(cfg: &AppConfig, id: &str) -> Result<DbConnConfig, String> {
    cfg.db_conns
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| "这个连接已经不存在（可能刚被删除）".to_string())
}

/// 手动来源的口令：本次输入优先，否则解 DPAPI；都没有就要求输入。
pub(crate) fn resolve_password(conn: &DbConnConfig, typed: Option<&str>) -> Result<String, String> {
    if let Some(t) = typed.filter(|t| !t.is_empty()) {
        return Ok(t.to_string());
    }
    let Some(enc) = conn.password_dpapi.as_deref() else {
        return Err(code_label("need-password", "还没输入这个连接的口令"));
    };
    let raw = svn_cred::b64_decode(enc)
        .ok_or_else(|| code_label("need-password", "存着的口令已损坏，请重输"))?;
    let plain = svn_cred::dpapi_unprotect(&raw).map_err(|e| {
        code_label(
            "need-password",
            &format!("存着的口令解不开（换机器/换用户会这样）：{e}"),
        )
    })?;
    String::from_utf8(plain).map_err(|e| format!("口令解码失败：{e}"))
}

pub(crate) fn protect(password: &str) -> Result<String, String> {
    Ok(svn_cred::b64_encode(&svn_cred::dpapi_protect(
        password.as_bytes(),
    )?))
}

/// 连接参数（不含手动口令）：prop 来源走 `connectProp`，手动来源走 `connect`。
pub(crate) fn connect_args(
    cfg: &AppConfig,
    conn: &DbConnConfig,
    password: Option<&str>,
    auto_commit: bool,
) -> Result<(&'static str, Vec<String>), String> {
    let auto = auto_commit.to_string();
    if conn.source == "prop" {
        let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
        let ds = conn
            .prop_ds
            .clone()
            .ok_or_else(|| "这个连接缺数据源名".to_string())?;
        return Ok(("connectProp", vec![home.root, ds, auto]));
    }
    let pass = resolve_password(conn, password)?;
    Ok((
        "connect",
        vec![conn.url.clone(), conn.user.clone(), pass, auto],
    ))
}

// ───────────────────────── 连接 / 执行 / 事务 ─────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectResult {
    pub id: String,
    pub url: String,
    pub user: String,
    pub product: String,
    pub version: String,
    pub auto_commit: bool,
}

/// 连库。手动来源 `password` 为空时用存过的；`remember` 为真时把这次输入的口令存起来。
#[tauri::command]
pub async fn db_connect(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<DbConnectResult, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let conn = find_conn(&cfg, &id)?;
    let (cmd, args) = connect_args(&cfg, &conn, password.as_deref(), conn.auto_commit)?;
    let bridge = bridge_for(&app, &st, &cfg, &id)?;
    let out = call(bridge, cmd, args, T_CONNECT).await?;

    let typed = password.filter(|p| !p.is_empty());
    let keep = remember.unwrap_or(true);
    let enc = match (&typed, keep) {
        (Some(p), true) => Some(protect(p)?),
        _ => None,
    };
    let _ = st
        .update_config(|c| {
            c.db_active = Some(id.clone());
            if let Some(e) = enc {
                if let Some(x) = c.db_conns.iter_mut().find(|x| x.id == id) {
                    x.password_dpapi = Some(e);
                }
            }
            Ok(())
        })
        .await;

    let s = |k: &str| out.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Ok(DbConnectResult {
        id,
        url: s("url"),
        user: s("user"),
        product: s("product"),
        version: s("version"),
        auto_commit: out
            .get("autoCommit")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// 断开（未提交的改动由桥回滚——界面已经先问过用户）。
#[tauri::command]
pub async fn db_disconnect(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let Ok(b) = existing_bridge(&state, &id) else {
        return Ok(());
    };
    let _ = call(b, "disconnect", vec![], Duration::from_secs(10)).await;
    drop_bridge(&state, &id);
    Ok(())
}

/// 执行一条语句（查询 / DML / DDL / PL/SQL 块都行）。返回桥的原样 JSON：
/// `{kind:"rows",columns,rows,rowCount,hasMore,ms,output,tx}` 或 `{kind:"update",updateCount,…}`。
#[tauri::command]
pub async fn db_exec(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    sql: String,
    max_rows: Option<u32>,
    timeout_sec: Option<u32>,
) -> Result<Value, String> {
    if sql.trim().is_empty() {
        return Err(code_label("sql", "SQL 是空的"));
    }
    let b = existing_bridge(&state, &id)?;
    let rows = max_rows.unwrap_or(500).clamp(1, 10_000);
    let timeout = timeout_sec.unwrap_or(30).clamp(1, 3600);
    call(
        b,
        "exec",
        vec![sql, rows.to_string(), timeout.to_string()],
        Duration::from_secs(u64::from(timeout) + 30),
    )
    .await
}

/// 「加载更多」：从上一次查询的游标接着取。
#[tauri::command]
pub async fn db_more(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    max_rows: Option<u32>,
) -> Result<Value, String> {
    let b = existing_bridge(&state, &id)?;
    let rows = max_rows.unwrap_or(500).clamp(1, 10_000);
    call(b, "more", vec![rows.to_string()], T_META).await
}

/// 事务操作：`commit` / `rollback` / `autocommit-on` / `autocommit-off` / `status`。
#[tauri::command]
pub async fn db_tx(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    action: String,
) -> Result<Value, String> {
    let b = existing_bridge(&state, &id)?;
    let (cmd, args): (&'static str, Vec<String>) = match action.as_str() {
        "commit" => ("commit", vec![]),
        "rollback" => ("rollback", vec![]),
        "autocommit-on" => ("autocommit", vec!["true".into()]),
        "autocommit-off" => ("autocommit", vec!["false".into()]),
        "status" => ("ping", vec![]),
        other => return Err(format!("未知事务操作：{other}")),
    };
    call(b, cmd, args, Duration::from_secs(60)).await
}

/// 元数据：`tables` / `ncNames` / `columns` / `indexes` / `ddl` / `explain`。
/// `arg` 是表名（explain 时是 SQL）。返回桥的原样 JSON。
#[tauri::command]
pub async fn db_meta(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    kind: String,
    arg: Option<String>,
) -> Result<Value, String> {
    let b = existing_bridge(&state, &id)?;
    let cmd: &'static str = match kind.as_str() {
        "tables" => "tables",
        "ncNames" => "ncNames",
        "columns" => "columns",
        "indexes" => "indexes",
        "ddl" => "ddl",
        "explain" => "explain",
        other => return Err(format!("未知元数据类型：{other}")),
    };
    let args = arg.map(|a| vec![a]).unwrap_or_default();
    if cmd != "tables" && cmd != "ncNames" && args.is_empty() {
        return Err(format!("{cmd} 需要参数"));
    }
    call(b, cmd, args, T_META).await
}

// ───────────────────────── 表结构缓存与出包核对 ─────────────────────────

/// 表结构缓存、悬停、出包核对用哪个库：最近一次在数据库页用过的连接，
/// 其次第一条连接，再其次 prop.xml 的基础数据源（老用户还没打开过新数据库页时）。
fn current_db(cfg: &AppConfig) -> Result<(Option<String>, String, String), String> {
    let pick = cfg
        .db_active
        .as_deref()
        .and_then(|id| cfg.db_conns.iter().find(|c| c.id == id))
        .or_else(|| cfg.db_conns.first());
    if let Some(c) = pick {
        return Ok((Some(c.id.clone()), c.url.clone(), c.user.clone()));
    }
    let prop = read_prop(cfg);
    let url = cfg
        .db_url
        .clone()
        .or_else(|| prop.as_ref().map(|p| p.url.clone()))
        .ok_or_else(|| "还没有数据库连接：到数据库页添加一个".to_string())?;
    let user = cfg
        .db_user
        .clone()
        .or_else(|| prop.as_ref().map(|p| p.user.clone()))
        .unwrap_or_default();
    Ok((None, url, user))
}

/// 缓存键里的用户名统一小写：prop.xml 写 `aier633`，库里回来的是 `AIER633`。
fn cache_file(dir: &Path, url: &str, user: &str) -> PathBuf {
    db_schema::cache_path(dir, url, &user.to_lowercase())
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
    /// 对应的连接 id（没有连接配置时为空）。
    pub conn_id: Option<String>,
}

fn status_of(
    cache: Option<&db_schema::SchemaCache>,
    conn_id: Option<String>,
    url: &str,
    user: &str,
) -> SchemaStatus {
    let now = db_schema::now_secs();
    let (has, fetched_at, tables, columns) = match cache {
        Some(c) => (true, c.fetched_at, c.tables.len(), c.column_count()),
        None => (false, 0, 0, 0),
    };
    SchemaStatus {
        has,
        url: url.to_string(),
        user: user.to_string(),
        fetched_at,
        age_secs: if has {
            now.saturating_sub(fetched_at)
        } else {
            0
        },
        tables,
        columns,
        conn_id,
    }
}

fn load_cache(dir: &Path, url: &str, user: &str) -> Option<db_schema::SchemaCache> {
    let lower = user.to_lowercase();
    db_schema::load(&cache_file(dir, url, user), url, &lower)
        .or_else(|| db_schema::load(&db_schema::cache_path(dir, url, user), url, user))
}

/// 表结构缓存的状态（不连库，只读本地文件）。
#[tauri::command]
pub async fn db_schema_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SchemaStatus, String> {
    let cfg = state.config.read().await.clone();
    let (id, url, user) = current_db(&cfg)?;
    let cache = load_cache(&state.config_dir, &url, &user);
    Ok(status_of(cache.as_ref(), id, &url, &user))
}

/// 从库里把表结构整个拉一遍落盘。要求当前连接已经连上（不偷偷连库）。
///
/// 一次拉完而不是分页：Java 侧每页都要把 `getColumns` 的结果从头 skip 一遍（O(n²)）。
#[tauri::command]
pub async fn db_schema_sync(
    state: tauri::State<'_, Arc<AppState>>,
    id: Option<String>,
) -> Result<SchemaStatus, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let (active, url, user) = match id.as_deref() {
        Some(i) => {
            let c = find_conn(&cfg, i)?;
            (Some(c.id), c.url, c.user)
        }
        None => current_db(&cfg)?,
    };
    let key = active
        .clone()
        .ok_or_else(|| code_label("not-connected", "先在数据库页添加并连上一个连接"))?;
    let bridge = existing_bridge(&st, &key)
        .map_err(|_| code_label("not-connected", "先在数据库页连上这个库，再拉表结构"))?;
    let out = call(
        bridge,
        "schema",
        vec!["0".into(), "2000000".into()],
        Duration::from_secs(300),
    )
    .await?;

    let rows: Vec<(String, String, String)> = out
        .get("rows")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let t = r.get("table")?.as_str()?.to_string();
                    let c = r.get("column")?.as_str()?.to_string();
                    let ty = db_schema::fmt_type(
                        r.get("type").and_then(Value::as_str).unwrap_or(""),
                        r.get("size").and_then(Value::as_i64).unwrap_or(0) as i32,
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
    let lower = user.to_lowercase();
    let cache = db_schema::SchemaCache::build(&url, &lower, db_schema::now_secs(), &rows);
    db_schema::save(&cache_file(&st.config_dir, &url, &user), &cache)?;
    Ok(status_of(Some(&cache), active, &url, &user))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTableColumns {
    pub table: String,
    pub columns: Vec<DbColumn>,
    /// 来自本地缓存（界面显示「缓存」而不是「现查」）。
    pub from_cache: bool,
}

/// 单表字段（Java 悬停卡片用）。有缓存走缓存；没缓存且当前连接已连上就现查一次。
#[tauri::command]
pub async fn db_columns(
    state: tauri::State<'_, Arc<AppState>>,
    table: String,
) -> Result<DbTableColumns, String> {
    let cfg = state.config.read().await.clone();
    let (id, url, user) = current_db(&cfg)?;
    if let Some(c) = load_cache(&state.config_dir, &url, &user) {
        if let Some(t) = c.tables.get(&table.to_lowercase()) {
            return Ok(DbTableColumns {
                table,
                columns: t
                    .columns
                    .iter()
                    .map(|(n, ty)| DbColumn {
                        name: n.clone(),
                        type_name: ty.clone(),
                    })
                    .collect(),
                from_cache: true,
            });
        }
    }
    let key = id.ok_or_else(|| code_label("not-connected", "还没有数据库连接"))?;
    let b = existing_bridge(&state, &key)?;
    let out = call(b, "columns", vec![table.clone()], Duration::from_secs(60)).await?;
    let columns = out
        .get("columns")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|c| DbColumn {
                    name: c
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    type_name: c
                        .get("full")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
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
pub struct CachedTables {
    pub tables: Vec<String>,
    pub fetched_at: u64,
    pub url: String,
    pub user: String,
}

/// 缓存里的全部表名（不连库）。没缓存时返回空列表（不是错误）。
#[tauri::command]
pub async fn db_cached_tables(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CachedTables, String> {
    let cfg = state.config.read().await.clone();
    let (_, url, user) = current_db(&cfg)?;
    let cache = load_cache(&state.config_dir, &url, &user);
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

/// 指定连接的表结构缓存（SQL 补全用：表名 → 字段名与类型）。没缓存返回 null。
#[tauri::command]
pub async fn db_schema_cache(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Option<Value>, String> {
    let cfg = state.config.read().await.clone();
    let c = find_conn(&cfg, &id)?;
    let Some(cache) = load_cache(&state.config_dir, &c.url, &c.user) else {
        return Ok(None);
    };
    let mut tables = serde_json::Map::new();
    for (name, t) in &cache.tables {
        let cols: Vec<Value> = t
            .columns
            .iter()
            .map(|(n, ty)| serde_json::json!([n, ty]))
            .collect();
        tables.insert(name.clone(), Value::Array(cols));
    }
    Ok(Some(
        serde_json::json!({ "fetchedAt": cache.fetched_at, "tables": tables }),
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckIssue {
    /// `table`（表不存在）或 `column`（字段不存在）。
    pub kind: String,
    pub table: String,
    pub column: Option<String>,
    pub rel: String,
    pub abs: String,
    pub line: usize,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCheck {
    pub files: usize,
    pub skipped: usize,
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
/// 且该表（们）里都没有这个列时才报。宁可漏报不误报。
#[tauri::command]
pub async fn db_check_sources(
    state: tauri::State<'_, Arc<AppState>>,
    files: Vec<String>,
) -> Result<SourceCheck, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let (_, url, user) = current_db(&cfg)?;
    let cache = load_cache(&st.config_dir, &url, &user)
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
        assert!(p.password_encoded);
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
    fn oracle_错误分类() {
        assert!(map_sql_error("ORA 1017：ORA-01017: 用户名/口令无效").starts_with("auth|"));
        assert_eq!(
            map_sql_error("ORA 942：表或视图不存在"),
            "sql|ORA 942：表或视图不存在"
        );
        assert!(map_sql_error("ORA-12541: TNS:no listener").starts_with("unreachable|"));
        assert!(map_sql_error("ORA 17002：IO 错误: Connection refused").starts_with("unreachable|"));
    }

    fn conn(id: &str, url: &str) -> DbConnConfig {
        DbConnConfig {
            id: id.into(),
            name: id.into(),
            env: "test".into(),
            source: "manual".into(),
            url: url.into(),
            user: "U".into(),
            prop_ds: None,
            password_dpapi: None,
            auto_commit: false,
            note: String::new(),
        }
    }

    #[test]
    fn 当前库优先取最近用过的连接() {
        let mut cfg = AppConfig {
            db_conns: vec![conn("a", "ua"), conn("b", "ub")],
            ..Default::default()
        };
        assert_eq!(current_db(&cfg).unwrap().1, "ua", "没用过时取第一条");
        cfg.db_active = Some("b".into());
        assert_eq!(current_db(&cfg).unwrap().0.as_deref(), Some("b"));
        cfg.db_active = Some("已删除".into());
        assert_eq!(
            current_db(&cfg).unwrap().1,
            "ua",
            "最近用过的被删了退回第一条"
        );
    }

    #[test]
    fn 手动连接没口令要求输入() {
        let e = resolve_password(&conn("a", "u"), None).unwrap_err();
        assert!(e.starts_with("need-password|"), "{e}");
        assert_eq!(resolve_password(&conn("a", "u"), Some("p")).unwrap(), "p");
    }
}
