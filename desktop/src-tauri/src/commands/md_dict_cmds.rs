//! 数据字典命令层：连库取 `md_*` 元数据，交给 [`crate::md_dict`] 装配。
//!
//! 只读。走连接的 **primary 会话**（和 `db_schema_sync` 一致）：这几条都是
//! `select`，不产生未提交写入，不占会话槽，也不影响界面的事务条。
//!
//! 三条纪律：
//! 1. **不替用户决定范围**：没有选取条件就报错，不退化成"全库 5876 张表"。
//! 2. **截断必须报**：`hasMore` 为真说明少拿了行，那种字典是"看着完整、其实缺列"，
//!    比直接报错更坏，所以这里当错误处理。
//! 3. **请求了但库里没有的表要列出来**：补丁草稿里扫出的表名可能拼错或还没发布，
//!    静默丢掉会让人以为"这张表没字段"。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db_engine::EngineHandle;
use crate::md_dict::{self, DocFormat, DocMeta, Grid, TableDict};
use crate::md_dict_sql::{self, TableFilter};
use crate::state::AppState;

use super::db_cmds::{call, code_label, current_db, existing_bridge, find_conn};

/// 一次字典查询能等多久。328 张 `bd_` 表实测 3.4 秒，这里给足余量——
/// 慢的是库不是我们，超时掐掉只会让人重试一次然后更慢。
const T_DICT: Duration = Duration::from_secs(300);
/// 单条 SQL 取多少行上限。列行是按"列 × 属性"算的，比列数多 1.4 倍左右。
const DICT_ROWS: u32 = 200_000;

/// 解析出要查哪个库的句柄。不偷偷连库：没连上就告诉用户去连。
async fn resolve(
    state: &Arc<AppState>,
    id: Option<&str>,
) -> Result<(Arc<EngineHandle>, String, String), String> {
    let cfg = state.config.read().await.clone();
    let key = match id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(i) => find_conn(&cfg, i)?.id,
        None => current_db(&cfg)?.0.ok_or_else(|| {
            code_label(
                "not-connected",
                "还没有数据库连接：到数据库页添加一个，或从 NC 的 prop.xml 导入",
            )
        })?,
    };
    let conn = find_conn(&cfg, &key)?;
    let handle = existing_bridge(state, &key).map_err(|_| {
        code_label(
            "not-connected",
            "先在数据库页连上这个库，再查数据字典（字典读的是库里的 md_* 元数据表）",
        )
    })?;
    Ok((handle, conn.url.clone(), conn.user.clone()))
}

/// 跑一条只读查询，并要求结果里必须出现指定的列名。
///
/// 为什么非要查这一下：桥给的列是 `{name,type,…}` 对象，一旦哪天形状变了，
/// 按列名取值的代码会**每列都读到空串**——字典变成一堆空表，还不报错。
/// `hasMore` 同理：截断的字典"看着完整、其实缺列"。
async fn query(b: Arc<EngineHandle>, sql: String, expect: &[&str]) -> Result<Grid, String> {
    let out = call(
        b,
        "exec",
        vec![sql, DICT_ROWS.to_string(), "120".to_string()],
        T_DICT,
    )
    .await?;
    if out
        .get("hasMore")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Err(code_label(
            "truncated",
            &format!(
                "这次查询超过 {DICT_ROWS} 行被截断了。少选一些表再试（截断的字典会缺列，不能交付）"
            ),
        ));
    }
    let grid = Grid::parse(&out)?;
    if let Some(k) = expect.iter().find(|k| !grid.has(k)) {
        return Err(code_label(
            "shape",
            &format!("查询结果里没有 `{k}` 列，读不出来。SQL 改过别名就会出现这种，不能猜着往下走"),
        ));
    }
    Ok(grid)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableBrief {
    pub name: String,
    pub display_name: String,
    pub is_extend: bool,
    pub module: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TablesOut {
    pub tables: Vec<TableBrief>,
    /// 命中的表比 `limit` 多，列表被截断了（列表可以截断，字典不行）。
    pub truncated: bool,
    pub source: String,
}

/// 选表用的表清单（勾选/前缀/关键词三种入口都用它）。
#[tauri::command]
pub async fn nc_md_tables(
    state: State<'_, Arc<AppState>>,
    id: Option<String>,
    filter: TableFilter,
    limit: Option<u32>,
) -> Result<TablesOut, String> {
    let (b, url, user) = resolve(&state, id.as_deref()).await?;
    let n = limit
        .unwrap_or(200)
        .clamp(1, md_dict_sql::MAX_TABLES as u32) as usize;
    // 多要一行用来判断"还有更多"，比再查一次 count 便宜
    let sql = md_dict_sql::tables_sql(&filter, n + 1)?;
    let rows = md_dict::read_tables(&query(b, sql, &["id", "name"]).await?);
    let truncated = rows.len() > n;
    Ok(TablesOut {
        tables: rows
            .into_iter()
            .take(n)
            .map(|t| TableBrief {
                name: t.name,
                display_name: t.display_name,
                is_extend: t.is_extend,
                module: t.res_module,
            })
            .collect(),
        truncated,
        source: format!("{}@{}", user, url),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdDictOut {
    pub tables: Vec<TableDict>,
    pub table_count: usize,
    pub column_count: usize,
    /// 没有中文名的列数。界面据此提示"这份字典有多完整"。
    pub columns_without_name: usize,
    /// 请求了但库里没有的表（名字写错、或元数据还没发布）。
    pub missing: Vec<String>,
    pub selection: String,
    pub source: String,
    pub elapsed_ms: u64,
}

/// 按选取条件生成数据字典。
#[tauri::command]
pub async fn nc_md_dict(
    state: State<'_, Arc<AppState>>,
    id: Option<String>,
    filter: TableFilter,
) -> Result<MdDictOut, String> {
    let started = Instant::now();
    let (b, url, user) = resolve(&state, id.as_deref()).await?;
    let f = filter.normalized();
    if f.is_empty() {
        return Err(code_label(
            "no-selection",
            "还没选表：勾几张表、给一个前缀（如 bd_），或输入表名/中文名的一部分",
        ));
    }

    // 多要一行：前缀模式（`bd_` 这种）很容易一次匹配几百张表，按上限直接查会被
    // rownum 悄悄截断。截断的字典是「看着完整、其实缺表」，比报错更坏，所以这里当错误。
    let sql = md_dict_sql::tables_sql(&f, md_dict_sql::MAX_TABLES + 1)?;
    let tables = md_dict::read_tables(&query(b.clone(), sql, &["id", "name"]).await?);
    if tables.len() > md_dict_sql::MAX_TABLES {
        return Err(code_label(
            "too-many",
            &format!(
                "范围太宽：匹配到超过 {} 张表。把前缀写细一点（`bd_material` 而不是 `bd_`）、\
                 加关键词，或改成勾选具体的表",
                md_dict_sql::MAX_TABLES
            ),
        ));
    }
    if tables.is_empty() {
        return Err(code_label(
            "empty",
            &format!("库里没有匹配的表（{}）", f.describe()),
        ));
    }
    let ids: Vec<String> = tables.iter().map(|t| t.id.clone()).collect();

    let mut cols = Vec::new();
    for s in md_dict_sql::columns_sqls(&ids) {
        cols.extend(md_dict::read_columns(
            &query(b.clone(), s, &["tid", "cname"]).await?,
        ));
    }
    let mut ents = Vec::new();
    for s in md_dict_sql::entities_sqls(&ids) {
        ents.extend(md_dict::read_entities(
            &query(b.clone(), s, &["tid", "cname", "ccols"]).await?,
        ));
    }
    if cols.is_empty() {
        return Err(code_label(
            "no-columns",
            &format!(
                "这 {} 张表一条列定义都没读到：可能元数据只发布了表头没发列，或者连的不是这套 NC 的库",
                tables.len()
            ),
        ));
    }

    let dict = md_dict::build(&tables, &cols, &ents);
    let (table_count, column_count, without_name) = md_dict::stats(&dict);
    Ok(MdDictOut {
        missing: md_dict::missing_tables(&f.names, &dict),
        tables: dict,
        table_count,
        column_count,
        columns_without_name: without_name,
        selection: f.describe(),
        source: format!("{user}@{url}"),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

// ───────────────────────── 产出：CSV / Markdown ─────────────────────────

/// 要导出的那份字典。
///
/// **由界面把屏幕上这一份传回来**，而不是让后端按 filter 重查一次：重查要多等 2~3 秒，
/// 而且中间元数据一变，导出的文件就和用户刚才看着的那份不一样了。"导出我看到的东西"
/// 才是用户的预期。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictDoc {
    pub tables: Vec<TableDict>,
    pub selection: String,
    pub source: String,
    /// 界面给的本地时间 `YYYY-MM-DD HH:mm`：Rust 侧没有时区库，不猜。
    pub generated: String,
}

impl DictDoc {
    fn meta(&self) -> DocMeta {
        DocMeta {
            source: self.source.clone(),
            generated: self.generated.clone(),
            selection: self.selection.clone(),
        }
    }

    fn text(&self, f: DocFormat) -> Result<String, String> {
        if self.tables.is_empty() {
            return Err(code_label(
                "empty",
                "这份字典里没有表，导出只会得到一个空文件",
            ));
        }
        // 渲染只有这一处：界面上的「复制」与「导出文件」走同一条路，
        // 两份格式才不会各自漂移成两种排版。
        Ok(md_dict::render(&self.tables, &self.meta(), f))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTextOut {
    pub text: String,
    /// 字节数（UTF-8），界面用来说明"复制了多大一份"。
    pub bytes: usize,
}

/// 渲染成文本，不落盘。给「复制到剪贴板」用。
#[tauri::command]
pub fn nc_md_dict_text(doc: DictDoc, format: String) -> Result<DocTextOut, String> {
    let text = doc.text(DocFormat::parse(&format)?)?;
    Ok(DocTextOut {
        bytes: text.len(),
        text,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOut {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    /// 所在目录，界面上直接显示，省得用户找。
    pub dir: String,
}

/// 渲染并写文件，落在 `{config_dir}/exports`（与 SQL 导出同一个目录）。
///
/// **不弹系统保存框**：dialog 插件已经从工程里删掉，且"固定导出目录 + 打开所在文件夹"
/// 与数据库导出的行为一致，不用每次选路径。
#[tauri::command]
pub fn nc_md_dict_export(
    state: State<'_, Arc<AppState>>,
    doc: DictDoc,
    format: String,
) -> Result<ExportOut, String> {
    let f = DocFormat::parse(&format)?;
    let text = doc.text(f)?;
    let dir = super::db_export_cmds::export_dir(&state);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建导出目录失败：{e}"))?;
    let path = unique_path(
        &dir,
        &md_dict::doc_stem(&doc.selection, &doc.generated),
        f.ext(),
    );
    std::fs::write(&path, text.as_bytes()).map_err(|e| format!("写文件失败：{e}"))?;
    Ok(ExportOut {
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        bytes: text.len() as u64,
        dir: dir.to_string_lossy().into_owned(),
    })
}

/// 同名文件不覆盖：同一分钟连点两次导出，第二份加 `-2`。
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let p = dir.join(format!("{stem}-{n}.{ext}"));
        if !p.exists() {
            return p;
        }
    }
    // 一千份同名（几乎不可能）：宁可覆盖第一份也不无限找下去
    first
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同名导出不覆盖前一份() {
        // 同一分钟连点两次很常见（第一次没看到文件落在哪就又点了一下），
        // 覆盖掉第一次那份等于静默丢数据。
        let dir = std::env::temp_dir().join(format!("ncforge-md-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let stem = "NC数据字典-测试";
        let a = unique_path(&dir, stem, "csv");
        assert!(a.ends_with(format!("{stem}.csv")), "{a:?}");
        std::fs::write(&a, b"x").unwrap();
        let b = unique_path(&dir, stem, "csv");
        assert!(b.ends_with(format!("{stem}-2.csv")), "{b:?}");
        std::fs::write(&b, b"x").unwrap();
        assert!(unique_path(&dir, stem, "csv").ends_with(format!("{stem}-3.csv")));
        // 扩展名不同不算同名：CSV 与 Markdown 可以共存
        assert!(unique_path(&dir, stem, "md").ends_with(format!("{stem}.md")));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
