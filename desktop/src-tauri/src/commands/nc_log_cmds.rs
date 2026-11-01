//! NC 运行日志的命令层：日志源清单、归因查询、按 callid 追踪。
//!
//! 三件事分开：**发现**在 `nc_log.rs`，**归因**在 `nc_log_rules.rs`，这里只做
//! 「拿配置 → 选文件 → 读尾部 → 解析 → 归因 → 包成前端要的形状」。
//!
//! ## 三个刻意的取舍
//!
//! 1. **不全量扫**。`nclogs/server/` 有 49 个 logger、单文件 5MB、还有 20 轮转。
//!    全读是几百 MB，界面会卡死且没有任何必要 —— 默认只读「最近改过的 10 个文件」，
//!    且一旦凑够 `limit` 条就停。
//! 2. **所有读盘都在 `spawn_blocking` 里**。5MB × 10 的读 + 解析是几百毫秒级，
//!    放在 async 线程上会把 IPC 队列一起堵住（界面表现为所有按钮失灵）。
//! 3. **时间过滤用字符串比较，不做时区换算**。日志里的 `ts` 是本地墙上时间
//!    `2026-10-30 15:23:47`，定宽，字典序即时间序；前端也按同一格式传边界。
//!    换成 epoch 就得知道本机时区偏移，而 std 没有这个 API，硬凑出来的偏移量
//!    会让「最近 1 小时」在跨时区/夏令时的机器上悄悄错一小时。

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::nc_home;
use crate::nc_log::{self, LogFile, LogRecord};
use crate::nc_log_rules::{self, Verdict};
use crate::state::AppState;

/// 不带 logger 过滤时，最多读几个文件（按「当前文件优先、修改时间新」取）。
const MAX_FILES_AUTO: usize = 10;
/// 指定了 logger 时，每个 logger 最多读几个文件（当前 + 2 个轮转）。
const MAX_FILES_PER_LOGGER: usize = 3;
/// 指定 logger 时总共的上限（防止用户全选 49 个 logger）。
const MAX_FILES_TOTAL: usize = 24;
/// 默认返回条数。
const DEFAULT_LIMIT: u32 = 300;
/// 慢 SQL 默认阈值（毫秒）。
const DEFAULT_SLOW_MS: u64 = 1000;
/// 追踪时最多扫几个文件。
const TRACE_MAX_FILES: usize = 24;

// ---------------------------------------------------------------- 形状

/// 一个 logger 及其磁盘上的文件。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggerGroup {
    pub name: String,
    /// logger 门限（`ERROR` / `OFF` …）。`OFF` 的不产文件，界面据此解释「为什么没有」。
    pub level: Option<String>,
    pub files: Vec<LogFile>,
    /// 该 logger 最新一份文件的时间（epoch 毫秒），0 = 没有文件。
    pub newest_ms: i64,
    pub total_size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub home: String,
    /// `ierp/bin/logger-config.properties` 的完整路径（读不到时也给出来，便于排查）。
    pub config_path: String,
    /// 文件名是不是从 logger 配置来的（false = 走了目录探测兜底）。
    pub from_config: bool,
    /// `${server}` 占位符实际展开成的目录名。
    pub server_dir: String,
    pub loggers: Vec<LoggerGroup>,
    /// 扫描根下是否存在 `nclogs/`（不存在时界面提示「日志目录还没生成」）。
    pub logs_root: String,
}

/// 一条归因条目 = 解析后的记录 + 结论。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(flatten)]
    pub record: LogRecord,
    pub verdict: Option<Verdict>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueryArgs {
    /// 空 = 全部 logger。
    pub loggers: Option<Vec<String>>,
    /// 起始时间（含），格式 `2026-10-30 15:00:00`；None = 不限。
    pub since_ts: Option<String>,
    /// 结束时间（含）。
    pub until_ts: Option<String>,
    /// 只看归因命中的（含慢 SQL）。
    pub only_problems: Option<bool>,
    /// 慢 SQL 阈值（毫秒）。
    pub min_cost_ms: Option<u64>,
    pub limit: Option<u32>,
}

impl Default for QueryArgs {
    fn default() -> Self {
        Self {
            loggers: None,
            since_ts: None,
            until_ts: None,
            only_problems: Some(true),
            min_cost_ms: None,
            limit: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub entries: Vec<Entry>,
    /// 实际读过的文件名（让人知道结论的覆盖面，不是「全库都没问题」）。
    pub scanned_files: Vec<String>,
    pub records_scanned: usize,
    /// 有文件因为太大只读了尾部。
    pub truncated_files: usize,
    /// 已经凑满 limit 提前停了（还有文件没看）。
    pub stopped_early: bool,
    pub elapsed_ms: u64,
    pub slow_threshold_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    pub call_id: String,
    pub entries: Vec<Entry>,
    pub scanned_files: Vec<String>,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------- 公共

/// 拿 NC home。日志功能必须有一个可读的 HOME，否则直接报人话。
fn home_root(cfg_home: Option<&str>) -> Result<(String, Option<String>), String> {
    let home = nc_home::resolve(cfg_home)?;
    let root = std::path::PathBuf::from(&home.root);
    let server = nc_home::read_server_name(&root);
    Ok((home.root, server))
}

fn group_loggers(
    files: Vec<LogFile>,
    level_of: &dyn Fn(&str) -> Option<String>,
) -> Vec<LoggerGroup> {
    let mut out: Vec<LoggerGroup> = Vec::new();
    for file in files {
        let at = match out.iter().position(|g| g.name == file.logger) {
            Some(i) => i,
            None => {
                out.push(LoggerGroup {
                    name: file.logger.clone(),
                    level: level_of(&file.logger),
                    files: Vec::new(),
                    newest_ms: 0,
                    total_size: 0,
                });
                out.len() - 1
            }
        };
        let group = &mut out[at];
        group.newest_ms = group.newest_ms.max(file.mtime_ms);
        group.total_size += file.size;
        group.files.push(file);
    }
    // 最近写过日志的排前面；从没写过的（全是轮转旧文件）沉底但仍可见
    out.sort_by(|a, b| {
        b.newest_ms
            .cmp(&a.newest_ms)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// 按「当前文件优先、修改时间新」的顺序取文件，并施加预算。
fn pick_files(all: &[LogFile], wanted: Option<&[String]>) -> Vec<LogFile> {
    let usable: Vec<&LogFile> = match wanted {
        Some(list) if !list.is_empty() => all.iter().filter(|f| list.contains(&f.logger)).collect(),
        _ => all.iter().filter(|f| f.size > 0).collect(),
    };

    match wanted {
        Some(list) if !list.is_empty() => {
            let mut out: Vec<LogFile> = Vec::new();
            let mut taken: std::collections::HashMap<&str, usize> =
                std::collections::HashMap::new();
            for file in usable {
                if out.len() >= MAX_FILES_TOTAL {
                    break;
                }
                let n = taken.entry(file.logger.as_str()).or_insert(0);
                if *n >= MAX_FILES_PER_LOGGER {
                    continue;
                }
                *n += 1;
                out.push(file.clone());
            }
            out
        }
        // 不带过滤：all 已经按「当前优先 + mtime 新」排好，直接取前 N 个非空文件
        _ => usable.into_iter().take(MAX_FILES_AUTO).cloned().collect(),
    }
}

/// 解析一个文件并推进统计。返回该文件的记录（失败返回空）。
fn read_records(file: &LogFile, stats: &mut (usize, usize)) -> Vec<LogRecord> {
    let path = Path::new(&file.path);
    let Ok(chunk) = nc_log::read_tail(path, nc_log::DEFAULT_MAX_BYTES) else {
        return Vec::new();
    };
    if chunk.truncated {
        stats.1 += 1;
    }
    let text = crate::workspace::decode_lossy(&chunk.bytes);
    let records = nc_log::parse_text(&file.logger, &file.name, &text, chunk.first_line_no);
    stats.0 += records.len();
    records
}

/// 给一条记录配结论：先查规则表，没命中再看是不是慢 SQL。
fn attach(record: LogRecord, slow_ms: u64) -> Entry {
    let mut verdict = nc_log_rules::judge(&record.msg, &record.stack);
    if verdict.is_none() {
        if let Some(cost) = record.cost_ms {
            if cost >= slow_ms {
                verdict = Some(nc_log_rules::slow_sql(cost, record.row_count));
            }
        }
    }
    Entry { record, verdict }
}

fn in_window(record: &LogRecord, since: Option<&str>, until: Option<&str>) -> bool {
    // ts 定宽 `YYYY-MM-DD HH:mm:ss`，字典序即时间序；没有 ts 的记录不因时间被丢
    let Some(ts) = record.ts.as_deref() else {
        return true;
    };
    if let Some(s) = since {
        if ts < s {
            return false;
        }
    }
    if let Some(u) = until {
        if ts > u {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------- 命令

/// 列出可用的日志源（logger → 文件）。
#[tauri::command]
pub async fn nc_log_sources(state: tauri::State<'_, Arc<AppState>>) -> Result<SourceInfo, String> {
    let cfg = state.config.read().await.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (root, server_name) = home_root(cfg.nc_home.as_deref())?;
        let root_path = std::path::PathBuf::from(&root);
        let defs = nc_log::load_logger_config(&root_path);
        let from_config = !defs.is_empty();
        let levels: std::collections::HashMap<String, Option<String>> =
            defs.into_iter().map(|d| (d.name, d.level)).collect();

        let files = nc_log::resolve_loggers(&root_path, server_name.as_deref());
        let level_of = |name: &str| levels.get(name).cloned().flatten();
        let loggers = group_loggers(files, &level_of);

        Ok(SourceInfo {
            logs_root: root_path.join("nclogs").to_string_lossy().into_owned(),
            home: root,
            config_path: nc_log::logger_config_path(&root_path)
                .to_string_lossy()
                .into_owned(),
            from_config,
            server_dir: nc_log::SERVER_DIR.to_string(),
            loggers,
        })
    })
    .await
    .map_err(|e| format!("读日志目录失败：{e}"))?
}

/// 归因查询。
#[tauri::command]
pub async fn nc_log_query(
    state: tauri::State<'_, Arc<AppState>>,
    args: QueryArgs,
) -> Result<QueryResult, String> {
    let cfg = state.config.read().await.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let (root, server_name) = home_root(cfg.nc_home.as_deref())?;
        let root_path = std::path::PathBuf::from(&root);

        let all = nc_log::resolve_loggers(&root_path, server_name.as_deref());
        if all.is_empty() {
            return Err(format!(
                "还没找到 NC 日志文件。先确认「NC 服务」里配的安装目录对不对，\
                 以及服务是否启动过（日志在 {}/nclogs/ 下）。",
                root
            ));
        }

        let picked = pick_files(&all, args.loggers.as_deref());
        let only_problems = args.only_problems.unwrap_or(true);
        let slow_ms = args.min_cost_ms.unwrap_or(DEFAULT_SLOW_MS);
        let limit = args.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 5000) as usize;

        let mut entries: Vec<Entry> = Vec::new();
        let mut scanned: Vec<String> = Vec::new();
        let mut stats = (0usize, 0usize); // (记录数, 截断文件数)
        let mut stopped_early = false;

        for file in &picked {
            if entries.len() >= limit {
                stopped_early = true;
                break;
            }
            scanned.push(file.name.clone());
            for record in read_records(file, &mut stats) {
                if !in_window(&record, args.since_ts.as_deref(), args.until_ts.as_deref()) {
                    continue;
                }
                let entry = attach(record, slow_ms);
                if only_problems && entry.verdict.is_none() {
                    continue;
                }
                entries.push(entry);
                if entries.len() >= limit {
                    stopped_early = true;
                    break;
                }
            }
        }

        // 新的排前面（日志是追加写的，尾部最新）
        entries.reverse();

        Ok(QueryResult {
            entries,
            scanned_files: scanned,
            records_scanned: stats.0,
            truncated_files: stats.1,
            stopped_early,
            elapsed_ms: started.elapsed().as_millis() as u64,
            slow_threshold_ms: slow_ms,
        })
    })
    .await
    .map_err(|e| format!("日志查询失败：{e}"))?
}

/// 按 callid 把一次请求跨 logger 串成时间线。
#[tauri::command]
pub async fn nc_log_trace(
    state: tauri::State<'_, Arc<AppState>>,
    call_id: String,
) -> Result<TraceResult, String> {
    let cfg = state.config.read().await.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        if call_id.trim().is_empty() {
            return Err(
                "这条日志没有 callid，追不了（通常是启动期日志，没有请求上下文）".to_string(),
            );
        }
        let (root, server_name) = home_root(cfg.nc_home.as_deref())?;
        let root_path = std::path::PathBuf::from(&root);
        let all = nc_log::resolve_loggers(&root_path, server_name.as_deref());
        let picked: Vec<LogFile> = all
            .iter()
            .filter(|f| f.size > 0)
            .take(TRACE_MAX_FILES)
            .cloned()
            .collect();

        let needle = call_id.as_bytes();
        let mut entries: Vec<Entry> = Vec::new();
        let mut scanned: Vec<String> = Vec::new();

        for file in &picked {
            let path = Path::new(&file.path);
            let Ok(chunk) = nc_log::read_tail(path, nc_log::DEFAULT_MAX_BYTES) else {
                continue;
            };
            // 字节级预筛：callid 是 ASCII，没命中就不必解码 + 解析整份文件
            if !bytes_contain(&chunk.bytes, needle) {
                continue;
            }
            scanned.push(file.name.clone());
            let text = crate::workspace::decode_lossy(&chunk.bytes);
            for record in nc_log::parse_text(&file.logger, &file.name, &text, chunk.first_line_no) {
                if record.call_id.as_deref() != Some(call_id.as_str()) {
                    continue;
                }
                entries.push(attach(record, DEFAULT_SLOW_MS));
            }
        }

        // 时间线：按时间 + 行号排，同时刻的保持文件内顺序
        entries.sort_by(|a, b| {
            a.record
                .ts
                .cmp(&b.record.ts)
                .then_with(|| a.record.logger.cmp(&b.record.logger))
                .then_with(|| a.record.line_no.cmp(&b.record.line_no))
        });

        Ok(TraceResult {
            call_id,
            entries,
            scanned_files: scanned,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| format!("追踪请求失败：{e}"))?
}

/// 子串查找（不引依赖；callid 一般 ≤ 30 字节，暴力搜足够快）。
fn bytes_contain(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || hay.len() < needle.len() {
        return false;
    }
    hay.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ts: &str, msg: &str, call_id: &str) -> LogRecord {
        LogRecord {
            logger: "nc".into(),
            file: "nc-log.log".into(),
            line_no: 1,
            ts: Some(ts.into()),
            call_id: Some(call_id.into()),
            msg: msg.into(),
            ..LogRecord::default()
        }
    }

    #[test]
    fn 时间窗口按字典序生效() {
        let r = rec("2026-10-30 15:00:00", "x", "1-1");
        assert!(in_window(&r, Some("2026-10-30 14:00:00"), None));
        assert!(!in_window(&r, Some("2026-10-30 15:00:01"), None));
        assert!(in_window(&r, None, Some("2026-10-30 15:00:00")));
        assert!(!in_window(&r, None, Some("2026-10-30 14:59:59")));
        // 没有 ts 的记录不因时间被丢：宁可多显示，不能悄悄吞掉
        let no_ts = LogRecord::default();
        assert!(in_window(&no_ts, Some("2030-01-01 00:00:00"), None));
    }

    #[test]
    fn 慢sql阈值决定是否给结论() {
        let mut r = rec("2026-10-30 15:00:00", "select 1 from t", "1-1");
        r.cost_ms = Some(800);
        assert!(attach(r.clone(), 1000).verdict.is_none(), "800ms 不算慢");
        let hit = attach(r, 500).verdict.expect("500 阈值下应当命中");
        assert_eq!(hit.rule, "slow-sql");
    }

    #[test]
    fn 规则命中优先于慢sql() {
        let mut r = rec("2026-10-30 15:00:00", "ORA-00942: 表或视图不存在", "1-1");
        r.cost_ms = Some(9000);
        let v = attach(r, 1000).verdict.unwrap();
        assert_eq!(v.rule, "ora-00942", "有具体原因时不该只说「慢」");
    }

    #[test]
    fn 字节子串查找() {
        assert!(bytes_contain(b"abc$$callid=x-1$$", b"x-1"));
        assert!(!bytes_contain(b"short", b"longer-than-hay"));
        assert!(!bytes_contain(b"abc", b""));
        assert!(bytes_contain(b"abc", b"abc"));
    }

    #[test]
    fn 文件预算只读最近改过的几个() {
        let mk = |logger: &str, rotated: bool, mtime: i64| LogFile {
            logger: logger.into(),
            name: format!("{logger}-log.log"),
            path: format!("/x/{logger}-log.log"),
            size: 10,
            mtime_ms: mtime,
            rotated,
        };
        let all = vec![
            mk("a", false, 3000),
            mk("b", false, 2000),
            mk("c", true, 100),
        ];
        let picked = pick_files(&all, None);
        assert_eq!(picked.len(), 3);
        // 顺序沿用 resolve_loggers 的排法（当前优先 + mtime 新）
        assert_eq!(picked[0].logger, "a");

        // 指定 logger 时只取那几个
        let only_b = pick_files(&all, Some(&["b".to_string()]));
        assert_eq!(only_b.len(), 1);
        assert_eq!(only_b[0].logger, "b");
    }

    #[test]
    fn 分组按最新时间排序() {
        let mk = |logger: &str, mtime: i64, size: u64| LogFile {
            logger: logger.into(),
            name: format!("{logger}.log"),
            path: format!("/x/{logger}.log"),
            size,
            mtime_ms: mtime,
            rotated: false,
        };
        let groups = group_loggers(vec![mk("old", 100, 5), mk("fresh", 900, 7)], &|_| None);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].name, "fresh");
        assert_eq!(groups[0].total_size, 7);
    }
}
