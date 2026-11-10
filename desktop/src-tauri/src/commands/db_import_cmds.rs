//! CSV / TSV 导入到表（B3）。
//!
//! **为什么插数据在后端做**：一是往返次数（前端一条一条 `db_exec` 要 N 次 IPC），
//! 二是**事务边界**——导入必须能整批回滚/提交，而这件事绝不能牵动 primary 会话里
//! 用户自己的未提交改动。所以每次导入都开一条独立会话（`autoCommit=false`），
//! 导完提交、断开，用户那边的黄条不受影响。
//!
//! **为什么不绑定参数**：两条引擎的 `exec` 都只收一条现成的 SQL 文本（`BindParameters`
//! 只有 JVM 桥内部有，而且没有对外开放的命令）。所以值要拼成 SQL 字面量——复用
//! [`crate::sql_export::literal`]，与「导出 INSERT」同一个实现，日期/数字/RAW 的写法
//! 才不会两边不一致。
//!
//! 文件解析在前端（csv/tsv/json 是文本）或 [`crate::xlsx_read`]（xlsx 是 zip，必须有后端
//! 解压），这里只收**已解析成字符串矩阵**的行——后端不再关心源文件的格式。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::commands::db_cmds::{
    bridge_for, call, connect_args, drop_bridge, find_conn, prop_password_ready, PROBE_CONF,
    T_CONNECT,
};
use crate::sql_export::literal;
use crate::state::AppState;

/// 失败行最多回这么多条：坏文件可能每一行都错，几百条报文已经够定位问题了。
const MAX_FAILS: usize = 200;
/// 单批最多多少行。前端按这个切批，批太大一条命令里全是拼接的 SQL。
const MAX_BATCH: usize = 1000;
/// 会话名序号，避免两次导入撞同一个临时会话。
static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCol {
    pub name: String,
    /// 目标列类型（`VARCHAR2` / `NUMBER` / `DATE`…）。空 = 按字符串处理。
    pub ty: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReq {
    pub id: String,
    pub table: String,
    pub columns: Vec<ImportCol>,
    /// 与 `columns` 等长；`null` = 该格留空（Oracle 里也就是 NULL）。
    pub rows: Vec<Vec<Option<String>>>,
    /// 这批第一行在文件里的行号（1 起，含表头），用于把失败定位回文件。
    pub start_line: Option<usize>,
    /// `true` = 坏行跳过、其余照插；`false`（默认）= 遇到第一处错误整批回滚。
    pub skip_errors: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFail {
    /// 文件里的行号（1 起）。
    pub line: usize,
    pub error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOut {
    pub inserted: usize,
    pub failed: Vec<ImportFail>,
    /// 失败条数超过 [`MAX_FAILS`] 被截断时为 `true`。
    pub truncated: bool,
    pub committed: bool,
    pub ms: u64,
}

/// 标识符加双引号：表里存的就是大写，加引号是大小写敏感的，正好对得上；
/// 内部的双引号按 SQL 规则翻倍，列名再怪也不会把语句拼坏。
fn ident(raw: &str) -> String {
    format!("\"{}\"", raw.trim().replace('"', "\"\""))
}

/// `OWNER.TABLE` 逐段加引号：整串加引号会被 Oracle 当成一个带点的表名，
/// 目标表在非默认 schema 时导入直接报「表不存在」。
fn ident_path(raw: &str) -> String {
    raw.split('.').map(ident).collect::<Vec<_>>().join(".")
}

/// 一批 insert 的 SQL 预览（单测与错误信息用）。
pub fn build_insert(table: &str, columns: &[ImportCol], row: &[Option<String>]) -> String {
    let cols: Vec<String> = columns.iter().map(|c| ident(&c.name)).collect();
    let vals: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let raw = row.get(i).and_then(|v| v.as_deref());
            // 空串在 Oracle 里本来就等于 NULL，这里显式写 null，避免 `''` 让人误以为存了空串
            match raw {
                Some(s) if !s.is_empty() => literal(Some(s), c.ty.as_deref().unwrap_or("")),
                _ => "null".to_string(),
            }
        })
        .collect();
    format!(
        "insert into {} ({}) values ({})",
        ident_path(table),
        cols.join(", "),
        vals.join(", ")
    )
}

#[tauri::command]
pub async fn db_import_rows(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    req: ImportReq,
) -> Result<ImportOut, String> {
    let st = state.inner().clone();
    let t0 = Instant::now();
    let table = req.table.trim().to_string();
    if table.is_empty() {
        return Err("没有指定目标表".to_string());
    }
    if req.columns.is_empty() {
        return Err("没有选择要写入的列".to_string());
    }
    if req.rows.is_empty() {
        return Ok(ImportOut {
            inserted: 0,
            failed: Vec::new(),
            truncated: false,
            committed: true,
            ms: 0,
        });
    }
    // 多拦一道：每行长度必须与列数一致，否则是前端映射写错了，不能悄悄少插几列
    if let Some((i, r)) = req
        .rows
        .iter()
        .enumerate()
        .find(|(_, r)| r.len() != req.columns.len())
    {
        return Err(format!(
            "第 {} 行的字段数（{}）与列数（{}）不一致，导入前请重新核对列映射",
            i + 1,
            r.len(),
            req.columns.len()
        ));
    }
    let rows = if req.rows.len() > MAX_BATCH {
        return Err(format!(
            "一次最多导入 {MAX_BATCH} 行（收到 {}），请分批",
            req.rows.len()
        ));
    } else {
        req.rows
    };
    let skip_errors = req.skip_errors.unwrap_or(false);
    let start = req.start_line.unwrap_or(1);

    let cfg = st.config.read().await.clone();
    let mut conn = find_conn(&cfg, &req.id)?;
    let engine = crate::db_engine::EngineKind::parse(&conn.engine);
    if engine != crate::db_engine::EngineKind::Java && conn.source == "prop" {
        prop_password_ready(&app, &st, &cfg, &mut conn, None, PROBE_CONF).await?;
    }

    // 写操作：autoCommit=false，自己管事务；跑完断开，不留未提交状态。
    // 目标表名不带 schema 时按「当前生效 schema」解析（用户切过就跟随，别悄悄回到配置值）。
    let (cmd, args) = connect_args(
        &cfg,
        &super::db_cmds::conn_with_runtime_schema(&st, &conn),
        None,
        false,
        engine,
    )?;
    let key = format!(
        "__import:{}:{}",
        conn.id,
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let bridge = bridge_for(&app, &st, &cfg, &key, engine, &conn.id)
        .map_err(|e| format!("开不了导入用的独立会话：{e}"))?;
    if let Err(e) = call(bridge.clone(), cmd, args, T_CONNECT).await {
        drop_bridge(&st, &key);
        return Err(format!("导入会话连不上：{e}"));
    }

    let mut inserted = 0usize;
    let mut failed: Vec<ImportFail> = Vec::new();
    let mut truncated = false;
    let mut aborted = false;

    for (i, row) in rows.iter().enumerate() {
        let sql = build_insert(&table, &req.columns, row);
        match call(bridge.clone(), "exec", vec![sql], Duration::from_secs(120)).await {
            Ok(_) => inserted += 1,
            Err(e) => {
                if failed.len() < MAX_FAILS {
                    failed.push(ImportFail {
                        line: start + i,
                        error: e,
                    });
                } else {
                    truncated = true;
                }
                if !skip_errors {
                    aborted = true;
                    break;
                }
            }
        }
    }

    // 出事就整批回滚：导入最怕「一半进去了、一半没进去」，用户还以为导成功了
    let committed = if aborted || (!skip_errors && !failed.is_empty()) {
        let _ = call(bridge.clone(), "rollback", vec![], Duration::from_secs(60)).await;
        // 回滚之后这一批一条都没进库：`inserted` 必须归零。
        // 前端是按批把这个数累加后显示「已写入 N 行」的，不归零就会出现
        // 「界面说写进去了、库里一条没有」这种最难排查的假成功。
        inserted = 0;
        false
    } else {
        match call(bridge.clone(), "commit", vec![], Duration::from_secs(120)).await {
            Ok(_) => true,
            Err(e) => {
                let _ = call(bridge.clone(), "rollback", vec![], Duration::from_secs(60)).await;
                drop_bridge(&st, &key);
                return Err(format!("提交失败，已回滚这一批：{e}"));
            }
        }
    };

    drop_bridge(&st, &key);
    Ok(ImportOut {
        inserted,
        failed,
        truncated,
        committed,
        ms: t0.elapsed().as_millis() as u64,
    })
}

/// 一张工作表读出来的样子（行优先的纯文本矩阵，第一行通常就是表头）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxSheetOut {
    /// 工作表显示名，界面上要告诉用户"读的是哪张表"（多 sheet 的文件很常见）。
    pub sheet: String,
    pub rows: Vec<Vec<String>>,
}

/// 从 IPC 载荷里取文件字节。
///
/// 正路是裸载荷（`InvokeBody::Raw`）。`Json` 分支是兜底：万一某个平台/版本上二进制
/// 载荷被序列化成 `{ bytes: [...] }`，这里还能读下去，总比在导入窗口里给一句
/// 「需要把文件字节作为原始载荷传入」让用户无路可走强。
fn payload_bytes(body: &tauri::ipc::InvokeBody) -> Result<Vec<u8>, String> {
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        tauri::ipc::InvokeBody::Json(value) => {
            let list = value
                .get("bytes")
                .and_then(|b| b.as_array())
                .ok_or("读取 XLSX 需要把文件字节作为原始载荷传入")?;
            list.iter()
                .map(|v| {
                    v.as_u64()
                        .filter(|n| *n <= u8::MAX as u64)
                        .map(|n| n as u8)
                        .ok_or_else(|| "文件字节里有非法数值".to_string())
                })
                .collect()
        }
    }
}

/// 读前端选中的 XLSX，返回文本矩阵。
///
/// **字节走 IPC 裸载荷**（`invoke(cmd, uint8Array)`），不走 `{ bytes: [...] }`：一个 5MB 的
/// 表按 JSON 数字数组要编出几千万个字符，编码和解析都在白等，而裸载荷是一次内存拷贝。
/// 代价是命令不能带别的参数，所以行数上限用 [`crate::xlsx_read::MAX_ROWS`] 而不是入参。
///
/// 解析放 `spawn_blocking`：zip 解压 + 扫描是纯 CPU 活，几百毫秒到几秒，钉在异步运行时
/// 的 worker 上会连带拖慢同一时刻的数据库命令。
#[tauri::command]
pub async fn db_xlsx_read(request: tauri::ipc::Request<'_>) -> Result<XlsxSheetOut, String> {
    let bytes = payload_bytes(request.body())?;
    tauri::async_runtime::spawn_blocking(move || {
        let sheet = crate::xlsx_read::read_xlsx_from(
            std::io::Cursor::new(bytes),
            crate::xlsx_read::MAX_ROWS,
        )?;
        Ok(XlsxSheetOut {
            sheet: sheet.sheet,
            rows: sheet.rows,
        })
    })
    .await
    .map_err(|e| format!("读取 XLSX 的后台任务失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<ImportCol> {
        vec![
            ImportCol {
                name: "ID".into(),
                ty: Some("NUMBER".into()),
            },
            ImportCol {
                name: "NAME".into(),
                ty: Some("VARCHAR2".into()),
            },
            ImportCol {
                name: "MAKEDATE".into(),
                ty: Some("DATE".into()),
            },
        ]
    }

    #[test]
    fn 标识符加引号并转义内部引号() {
        assert_eq!(ident("bd_material"), "\"bd_material\"");
        assert_eq!(ident("  BD_MATERIAL "), "\"BD_MATERIAL\"");
        // 列名里带引号也不能把语句拼断
        assert_eq!(ident("A\"B"), "\"A\"\"B\"");
    }

    #[test]
    fn 库名与表名逐段加引号() {
        assert_eq!(ident_path("BD_MATERIAL"), "\"BD_MATERIAL\"");
        assert_eq!(
            ident_path("AIER633.BD_MATERIAL"),
            "\"AIER633\".\"BD_MATERIAL\""
        );
        let sql = build_insert("AIER633.T", &cols(), &[Some("1".into()), None, None]);
        assert!(sql.starts_with("insert into \"AIER633\".\"T\""), "{sql}");
    }

    #[test]
    fn 按列类型写字面量_空值写_null() {
        let sql = build_insert(
            "T",
            &cols(),
            &[
                Some("12".into()),
                Some("O'Brien".into()),
                Some("2026-10-31 10:00:00".into()),
            ],
        );
        assert_eq!(
            sql,
            "insert into \"T\" (\"ID\", \"NAME\", \"MAKEDATE\") values (12, 'O''Brien', \
             to_date('2026-10-31 10:00:00', 'YYYY-MM-DD HH24:MI:SS'))"
        );
    }

    #[test]
    fn 空串与缺列都写_null() {
        // 空串在 Oracle 里就是 NULL；写成 '' 会让人以为存了空串
        let sql = build_insert("T", &cols(), &[Some("1".into()), Some("".into()), None]);
        assert!(sql.ends_with("values (1, null, null)"), "{sql}");
    }

    #[test]
    fn 数字列收到非数字时退回带引号() {
        // 宁可让 Oracle 报类型错（用户能看见是哪一行），也不要拼出 `values (abc, …)` 这种语法错误
        let sql = build_insert("T", &cols(), &[Some("abc".into()), Some("x".into()), None]);
        assert!(sql.contains("values ('abc', 'x', null)"), "{sql}");
    }

    #[test]
    fn 裸载荷直接取字节_对象载荷也能兜底() {
        let raw = payload_bytes(&tauri::ipc::InvokeBody::Raw(vec![1, 2, 3])).unwrap();
        assert_eq!(raw, vec![1, 2, 3]);
        let json = payload_bytes(&tauri::ipc::InvokeBody::Json(
            serde_json::json!({ "bytes": [80, 75, 3, 4] }),
        ))
        .unwrap();
        assert_eq!(json, vec![80, 75, 3, 4]);
    }

    #[test]
    fn 载荷形状不对时报错而不是给空表() {
        // 空表会让界面说「文件里没有数据」，把前端接错伪装成文件问题
        let e = payload_bytes(&tauri::ipc::InvokeBody::Json(serde_json::json!({ "x": 1 })))
            .unwrap_err();
        assert!(e.contains("原始载荷"), "{e}");
        let e = payload_bytes(&tauri::ipc::InvokeBody::Json(
            serde_json::json!({ "bytes": [1, 300] }),
        ))
        .unwrap_err();
        assert!(e.contains("非法数值"), "{e}");
    }
}
