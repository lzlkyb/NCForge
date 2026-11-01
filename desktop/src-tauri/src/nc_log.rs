//! NC 运行日志（`nclogs/`）的**发现**与**解析** —— 纯只读，不写盘、不改配置。
//!
//! 事实来源是本机 `D:\ncc\1909home` 实测（2026-11-01）。网上流传的
//! `$NC_HOME/nclog/run.log` + `err.log` 是 NC57/NC65 的形态，1909 **完全不同**：
//!
//! | 事实 | 实测值 |
//! |------|--------|
//! | 目录 | `nclogs/`（复数），主体在 `nclogs/server/`；旁边的 `logs/` 是空的 |
//! | 文件划分 | 一个 logger 一个文件，49 个条目，**文件名由 `ierp/bin/logger-config.properties` 决定** |
//! | 轮转 | `.log.1`（最新）→ `.log.N`（最旧），5MB 一份；`icl` 另走 `.log.yyyy-MM-dd` |
//! | 编码 | **GBK**（`prop.xml` 的 `jvmArgs` 里 `-Dfile.encoding=GBK` 是铁证） |
//! | 记录格式 | 一行 `$$k=v ... $$msg=…` + N 行**裸行**续行（堆栈），CRLF |
//! | `callid` | 「epoch 毫秒-序号」，**就是 traceId**，可跨 logger 串一次请求 |
//! | `warningsql` | msg 自带 `|costtime=N||rownum=N|`，慢 SQL 不用自己算 |
//!
//! ## 四条不能想当然的约束
//!
//! 1. **`debuglevel` 不可信**：`$$debuglevel=ERROR` 后面跟的可能是 `###udapte table success`。
//!    它是 logger 的**门限**，不是这一行的严重性 —— 所以 `LogRecord::level` 只用于展示，
//!    归因一律走 [`crate::nc_log_rules`]（看内容），不按 level 过滤。
//! 2. **续行是裸行**：堆栈行没有 `$$` 前缀，末尾带 `\r`。按行切必须先去 `\r` 再判前缀。
//! 3. **值里含 `=` 与 `|`**（SQL 里全是），所以 `$$k=v` 只能切**第一个** `=`；
//!    而 `msg` 永远是最后一个字段，直接取 `$$msg=` 之后到行尾，不再切分隔符。
//! 4. **文件名不许硬编码**：换版本/换现场，logger-config 会不同。配置读不到时才回退目录探测。

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::workspace::decode_lossy;

/// logger 配置相对 HOME 的路径（实测存在，且是文件名/轮转/门限的权威表）。
pub const LOGGER_CONFIG: &str = "ierp/bin/logger-config.properties";

/// `${server}` 占位符实测恒为字面量 `server`。
///
/// `prop.xml` 里 `<server><name>` 是 `xuyserver`，但日志落盘在 `nclogs/server/` ——
/// 这个占位符指的是**节点角色**，不是服务器名。别的现场可能不同，所以
/// [`resolve_loggers`] 还会把 prop 里的 server 名当第二个候选去试。
pub const SERVER_DIR: &str = "server";

/// 单次解析从文件尾部最多读多少字节。
///
/// 实测最大的 logger 是 4.8MB，所以 6MB 基本等于「整份读」；设上限是为了
/// 「有人在生产环境留了个 500MB 的日志」时不要把内存和 UI 一起拖死。
pub const DEFAULT_MAX_BYTES: usize = 6 * 1024 * 1024;

/// 统计行号时最多回扫多少字节（只为把 `file:line` 显示准）。
///
/// 读一遍前缀只为数换行，比「整份解析」便宜得多；上限避免超大文件拖慢一次点击。
const LINE_COUNT_CAP: u64 = 64 * 1024 * 1024;

/// 一条记录最多保留多少行续行（堆栈）。超出的丢弃并置 `stackTruncated`。
const MAX_STACK_LINES: usize = 80;

// ---------------------------------------------------------------- 发现

/// `logger-config.properties` 里的一个 logger 条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggerDef {
    /// logger 名（如 `nc.md`、`com.ufida.eip.help`、`warningsql`）。
    pub name: String,
    /// 文件模板，含 `${server}`（如 `./nclogs/${server}/nc-log.log`）。
    pub file: String,
    /// 门限（`ERROR` / `DEBUG` / `OFF`）。`OFF` 的 logger 不会产出文件。
    pub level: Option<String>,
    pub max_size: Option<String>,
    pub max_index: Option<u32>,
    /// 按日期滚动（`icl.time=.yyyy-MM-dd`），轮转后缀是日期不是序号。
    pub dated: bool,
}

/// 磁盘上的一个日志文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    /// 归属的 logger；回退探测时按文件名反推。
    pub logger: String,
    /// 文件名（不含目录），界面显示用。
    pub name: String,
    pub path: String,
    pub size: u64,
    /// 修改时间（epoch 毫秒）。用于「最近改过的排前面」。
    pub mtime_ms: i64,
    /// 是不是轮转出来的旧文件（`false` = 当前正在写的那个）。
    pub rotated: bool,
}

/// 解析 properties 文本（`k=v`，`#`/`!` 开头是注释）。
///
/// 后缀按**从长到短**匹配：`.size.maxIndex` 必须先于 `.size`，否则会被切错；
/// 而 logger 名本身带点（`nc.bs.framework.codesync`），不能按点切分。
pub fn parse_logger_config(text: &str) -> Vec<LoggerDef> {
    let mut defs: Vec<LoggerDef> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());

        // 字段后缀表：顺序即优先级（长的在前）。
        const SUFFIXES: &[&str] = &[
            ".size.maxIndex",
            ".size.maxSize",
            ".pattern",
            ".level",
            ".file",
            ".time",
        ];
        let Some(suffix) = SUFFIXES.iter().find(|s| key.ends_with(*s)) else {
            continue;
        };
        let name = key[..key.len() - suffix.len()].trim();
        if name.is_empty() {
            continue;
        }

        let at = *index.entry(name.to_string()).or_insert_with(|| {
            defs.push(LoggerDef {
                name: name.to_string(),
                file: String::new(),
                level: None,
                max_size: None,
                max_index: None,
                dated: false,
            });
            defs.len() - 1
        });
        let def = &mut defs[at];
        match *suffix {
            ".file" => def.file = value.to_string(),
            ".level" => def.level = Some(value.to_string()),
            ".size.maxSize" => def.max_size = Some(value.to_string()),
            ".size.maxIndex" => def.max_index = value.parse().ok(),
            ".time" => def.dated = true,
            _ => {}
        }
    }

    // 只认文件名的 logger 条目。
    //
    // 光看「以 .file 结尾」不够：properties 里任何 `xxx.file=1` 都会被当成一个
    // logger，`file` 值还是 `1` —— 之后每次解析都要对着一个不存在的路径试一遍。
    // NC 的 logger 文件一律是 `.log`，用这一条把伪条目挡掉。
    defs.retain(|d| d.file.to_ascii_lowercase().ends_with(".log"));
    defs
}

/// logger 配置文件的完整路径。
pub fn logger_config_path(root: &Path) -> PathBuf {
    root.join(LOGGER_CONFIG.replace('/', std::path::MAIN_SEPARATOR_STR))
}

/// 读 logger 配置。文件不存在或读不到时返回空表，由调用方走目录探测。
pub fn load_logger_config(root: &Path) -> Vec<LoggerDef> {
    let path = logger_config_path(root);
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    parse_logger_config(&decode_lossy(&bytes))
}

/// 把文件模板展开成绝对路径，返回（路径，是否存在）。
///
/// `${server}` 先按字面量 `server`（本机实测），再按 prop 里的 server 名，
/// 哪个真实存在用哪个；都不存在时用第一个候选，让界面能显示「本该在哪」。
fn resolve_template(root: &Path, template: &str, server_name: Option<&str>) -> (PathBuf, bool) {
    let rel = template.trim().trim_start_matches("./").replace('\\', "/");
    let mut candidates: Vec<String> = vec![SERVER_DIR.to_string()];
    if let Some(n) = server_name {
        if n != SERVER_DIR {
            candidates.push(n.to_string());
        }
    }

    let mut first: Option<PathBuf> = None;
    for cand in &candidates {
        let filled = rel.replace("${server}", cand);
        let path = root.join(filled.replace('/', std::path::MAIN_SEPARATOR_STR));
        let exists = path.is_file();
        if first.is_none() {
            first = Some(path.clone());
        }
        if exists {
            return (path, true);
        }
    }
    (first.unwrap_or_else(|| root.join(&rel)), false)
}

/// 轮转后缀：纯数字（`.log.1`）或日期（`.log.2022-08-30`，`icl` 那种）。
fn rotation_index(name: &str, base: &str) -> Option<u32> {
    let suffix = name.strip_prefix(base)?.strip_prefix('.')?;
    if suffix.is_empty() {
        return None;
    }
    if let Ok(n) = suffix.parse::<u32>() {
        return Some(n);
    }
    let is_date = suffix.len() == 10
        && suffix.as_bytes()[4] == b'-'
        && suffix.as_bytes()[7] == b'-'
        && suffix
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    is_date.then_some(u32::MAX)
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

fn push_file(out: &mut Vec<LogFile>, logger: &str, path: PathBuf, rotated: bool) {
    let Ok(meta) = std::fs::metadata(&path) else {
        return;
    };
    if !meta.is_file() {
        return;
    }
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return;
    };
    out.push(LogFile {
        logger: logger.to_string(),
        name,
        path: path.to_string_lossy().into_owned(),
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
        rotated,
    });
}

/// 枚举某个 logger 在当前目录下的全部文件（当前文件 + 轮转）。
fn files_of_logger(root: &Path, def: &LoggerDef, server_name: Option<&str>) -> Vec<LogFile> {
    let (path, exists) = resolve_template(root, &def.file, server_name);
    let mut out = Vec::new();
    if !exists {
        return out;
    }
    let Some(dir) = path.parent() else {
        return out;
    };
    let Some(base) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return out;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let max_index = def.max_index.unwrap_or(20);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == base {
            push_file(&mut out, &def.name, entry.path(), false);
            continue;
        }
        if let Some(idx) = rotation_index(&name, &base) {
            // `.log.0` 不存在；日期滚动没有序号上限，用 MAX 表示
            if idx == u32::MAX || idx <= max_index.max(1) {
                push_file(&mut out, &def.name, entry.path(), true);
            }
        }
    }
    // 当前文件排最前，其余按序号（1 最新）升序
    out.sort_by(|a, b| {
        a.rotated
            .cmp(&b.rotated)
            .then_with(|| rotation_index(&a.name, &base).cmp(&rotation_index(&b.name, &base)))
    });
    out
}

/// 配置读不到时的兜底：直接探目录找 `*.log`。
///
/// 只探深一层（`nclogs/server/`、`nclogs/icl/`），不递归 —— 生产上 `nclogs/` 下
/// 还有 `pdf/`、`mqreceiver/` 这类业务目录，里面是成千上万的小文件，递归会卡住。
fn probe_dirs(root: &Path) -> Vec<LogFile> {
    let mut out = Vec::new();
    for rel in ["nclogs", "nclog", "ierp/nclog"] {
        let base = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let Ok(entries) = std::fs::read_dir(&base) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".log") {
                    push_file(&mut out, &logger_name_of(&name), path, false);
                }
                continue;
            }
            let Ok(inner) = std::fs::read_dir(&path) else {
                continue;
            };
            let dir = entry.file_name().to_string_lossy().into_owned();
            for e in inner.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.ends_with(".log") {
                    push_file(
                        &mut out,
                        &format!("{dir}/{}", logger_name_of(&n)),
                        e.path(),
                        false,
                    );
                }
            }
        }
    }
    out
}

/// 从文件名反推 logger 名：`nc-log.log` → `nc`，`metadata.log` → `metadata`。
fn logger_name_of(file_name: &str) -> String {
    file_name
        .strip_suffix("-log.log")
        .or_else(|| file_name.strip_suffix(".log"))
        .unwrap_or(file_name)
        .to_string()
}

/// 全部日志文件（当前 + 轮转），按「当前正在写的优先、其次修改时间新」排序。
pub fn resolve_loggers(root: &Path, server_name: Option<&str>) -> Vec<LogFile> {
    let defs = load_logger_config(root);
    let mut out = Vec::new();
    if defs.is_empty() {
        out = probe_dirs(root);
    } else {
        for def in &defs {
            out.extend(files_of_logger(root, def, server_name));
        }
    }
    out.sort_by(|a, b| {
        a.rotated
            .cmp(&b.rotated)
            .then_with(|| b.mtime_ms.cmp(&a.mtime_ms))
            .then_with(|| a.logger.cmp(&b.logger))
    });
    out
}

// ---------------------------------------------------------------- 解析

/// 一条日志记录。**只回传解析结果，不回传原始字节**（前端拿不到 5MB 的乱码）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    pub logger: String,
    /// 文件名（不含目录），给界面显示 `nc-log.log:12`。
    pub file: String,
    pub line_no: u32,
    /// `2026-10-30 15:23:47`（原样，不做时区换算）。
    pub ts: Option<String>,
    /// 就是 traceId（`epoch毫秒-序号`）。
    pub call_id: Option<String>,
    pub thread: Option<String>,
    pub user_id: Option<String>,
    /// `remotecall` 的类名，去掉方括号，可直接跳源码。
    pub remote_call: Option<String>,
    /// 只用于展示。**不能用来判严重性**（见模块文档第 1 条）。
    pub level: Option<String>,
    pub msg: String,
    /// 续行（堆栈或消息续行），已去掉行尾 `\r`。
    pub stack: Vec<String>,
    /// 续行被截断（超过 [`MAX_STACK_LINES`]）。
    pub stack_truncated: bool,
    /// `warningsql` 的 `|costtime=N|`。
    pub cost_ms: Option<u64>,
    /// `warningsql` 的 `|rownum=N|`。
    pub row_count: Option<u64>,
}

/// 从文件尾部读出来的一段字节 + 首行行号。
pub struct RawChunk {
    pub bytes: Vec<u8>,
    pub first_line_no: u32,
    /// 文件比 `max_bytes` 大，只读了尾部。
    pub truncated: bool,
}

/// 读文件尾部（最多 `max_bytes`），并算出首行在文件里的真实行号。
///
/// 为什么要算行号：界面要显示 `nc-log.log:3557` 并能跳到源码/SQL 去核对，
/// 行号错了这个入口就废了。尾部切片会从某条记录的中间切进来，所以：
/// 丢到第一个 `\n` 为止（保证接着看到的第一行是完整行），行号基数 = 前面的换行数 + 2。
pub fn read_tail(path: &Path, max_bytes: usize) -> std::io::Result<RawChunk> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let max_bytes = max_bytes.max(4096) as u64;

    if len <= max_bytes {
        let mut buf = Vec::with_capacity(len as usize);
        file.read_to_end(&mut buf)?;
        return Ok(RawChunk {
            bytes: buf,
            first_line_no: 1,
            truncated: false,
        });
    }

    let start = len - max_bytes;
    // 数出 start 之前的换行数（分块读，不把前缀整个装进内存）
    let mut skipped: u64 = 0;
    let mut read: u64 = 0;
    let mut buf64k = vec![0u8; 64 * 1024];
    while read < start.min(LINE_COUNT_CAP) {
        let want = ((start.min(LINE_COUNT_CAP) - read) as usize).min(buf64k.len());
        let n = file.read(&mut buf64k[..want])?;
        if n == 0 {
            break;
        }
        skipped += buf64k[..n].iter().filter(|b| **b == b'\n').count() as u64;
        read += n as u64;
    }

    file.seek(SeekFrom::Start(start))?;
    let mut tail = Vec::with_capacity(max_bytes as usize);
    file.read_to_end(&mut tail)?;
    let cut = tail
        .iter()
        .position(|b| *b == b'\n')
        .map_or(tail.len(), |i| i + 1);

    Ok(RawChunk {
        bytes: tail[cut..].to_vec(),
        // start 落在第 skipped+1 行的中间，丢掉这半行后从 skipped+2 行开始
        first_line_no: (skipped + 2).min(u32::MAX as u64) as u32,
        truncated: true,
    })
}

/// 解析一段日志文本。
///
/// `first_line_no` 是该文本第一行在文件里的行号（整份读时为 1）。
pub fn parse_text(logger: &str, file_name: &str, text: &str, first_line_no: u32) -> Vec<LogRecord> {
    let mut out: Vec<LogRecord> = Vec::new();
    let mut cur: Option<LogRecord> = None;

    for (i, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.starts_with("$$") {
            if let Some(done) = cur.take() {
                out.push(done);
            }
            let mut rec = LogRecord {
                logger: logger.to_string(),
                file: file_name.to_string(),
                line_no: first_line_no.saturating_add(i as u32),
                ..LogRecord::default()
            };
            rec.msg = parse_header(line, &mut rec);
            let (cost, rows) = extract_cost(&rec.msg);
            rec.cost_ms = cost;
            rec.row_count = rows;
            cur = Some(rec);
        } else if let Some(rec) = cur.as_mut() {
            let trimmed = line.trim_end();
            if trimmed.trim().is_empty() {
                continue;
            }
            if rec.stack.len() >= MAX_STACK_LINES {
                rec.stack_truncated = true;
                continue;
            }
            rec.stack.push(trimmed.to_string());
        }
        // 第一条 `$$` 之前的裸行（从文件中间切进来的碎片）直接丢掉
    }
    if let Some(done) = cur.take() {
        out.push(done);
    }
    out
}

/// 解析一行头部，把字段填进 `rec`，返回 `msg`。
///
/// 规则（见模块文档第 3 条）：`msg` 是最后一个字段，取 `$$msg=` 之后到行尾；
/// 其余按 `$$` 切段、每段只切第一个 `=`。
fn parse_header(line: &str, rec: &mut LogRecord) -> String {
    let body = line.strip_prefix("$$").unwrap_or(line);
    let (head, msg) = match body.find("$$msg=") {
        Some(p) => (&body[..p], &body[p + "$$msg=".len()..]),
        None => (body, ""),
    };

    for seg in head.split("$$") {
        let Some((key, value)) = seg.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "callid" => rec.call_id = Some(value.to_string()),
            "thread" => rec.thread = Some(unbracket(value)),
            "userid" => rec.user_id = Some(value.to_string()),
            "ts" => rec.ts = Some(value.to_string()),
            "remotecall" => rec.remote_call = Some(unbracket(value)),
            "debuglevel" => rec.level = Some(value.to_string()),
            _ => {}
        }
    }
    msg.trim().to_string()
}

/// `[Thread-14]` → `Thread-14`。
fn unbracket(value: &str) -> String {
    let t = value.trim();
    t.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(t)
        .to_string()
}

/// 从 `|costtime=24||rownum=5208|` 这类尾巴里取数字。
fn extract_cost(msg: &str) -> (Option<u64>, Option<u64>) {
    (number_field(msg, "costtime"), number_field(msg, "rownum"))
}

fn number_field(text: &str, key: &str) -> Option<u64> {
    let pat = format!("{key}=");
    let at = text.find(&pat)? + pat.len();
    let digits: String = text[at..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机真实首条记录的形态（含 `$$debuglevel=ERROR` + `###udapte` 那种前后矛盾，
    /// 以及堆栈裸行、行尾 `\r`）。
    const REAL_SAMPLE: &str = "$$callid= $$thread=[Thread-14] $$host= $$userid= $$ts=2026-10-30 15:23:47 $$remotecall=[serverstart] $$debuglevel=ERROR  $$msg=info: module=mmbcm-scm component=deviceregister, error at D:\\ncc\\1909home\\modules\\mmbcm-scm\\META-INF\\accessright.upm <module/public/component>, catch root\r\nnc.bs.framework.exception.DuplicateException: Detail Message: deviceregister\r\n\tat nc.bs.framework.server.AbstractContainer.register(AbstractContainer.java:92)\r\n\tat java.lang.Thread.run(Thread.java:748)\r\n \r\n$$callid=1751016333490-3845  $$thread=[http-bio-80-exec-7] $$userid=#UAP# $$ts=2025-06-27 17:25:34 $$msg=select * from ( select row_number () over ( partition by id order by versiontype desc ) rn, t1.id FROM md_component t1 where 1 = 1 ) a where a.rn = 1|costtime=24||rownum=5208||defcol1=null| \r\n";

    #[test]
    fn 记录切分与续行归属() {
        let recs = parse_text("nc", "nc-log.log", REAL_SAMPLE, 1);
        assert_eq!(recs.len(), 2);

        let first = &recs[0];
        assert_eq!(first.line_no, 1);
        assert_eq!(first.ts.as_deref(), Some("2026-10-30 15:23:47"));
        assert_eq!(first.thread.as_deref(), Some("Thread-14"));
        assert_eq!(first.remote_call.as_deref(), Some("serverstart"));
        assert_eq!(first.level.as_deref(), Some("ERROR"));
        assert_eq!(first.call_id, None, "空 callid 应当是 None，不是空串");
        assert!(first.msg.starts_with("info: module=mmbcm-scm"));
        assert_eq!(first.stack.len(), 3, "堆栈两行 + 空行被跳过的那条不算");
        assert!(first.stack[0].starts_with("nc.bs.framework.exception.DuplicateException"));
        assert!(!first.stack[0].ends_with('\r'), "行尾 \\r 必须去掉");

        // 第 2 条：物理第 6 行（1 行头部 + 3 行堆栈 + 1 行空白行之后）
        let second = &recs[1];
        assert_eq!(second.line_no, 6);
        assert_eq!(second.call_id.as_deref(), Some("1751016333490-3845"));
        assert_eq!(second.user_id.as_deref(), Some("#UAP#"));
        assert_eq!(second.remote_call, None, "warningsql 没有 remotecall 字段");
        assert_eq!(second.cost_ms, Some(24));
        assert_eq!(second.row_count, Some(5208));
        assert!(second.stack.is_empty());
    }

    #[test]
    fn msg_里的等号与竖线不被切碎() {
        let recs = parse_text(
            "warningsql",
            "warningsql-log.log",
            "$$callid=1-2 $$msg=SELECT * FROM sm_menuitemreg WHERE pk_menu = '1001A' AND n=1|costtime=7||rownum=5500|",
            1,
        );
        assert_eq!(recs.len(), 1);
        let r = &recs[0];
        assert!(r.msg.contains("pk_menu = '1001A'"), "msg 里的 = 要原样保留");
        assert!(r.msg.ends_with('|'));
        assert_eq!(r.cost_ms, Some(7));
        assert_eq!(r.row_count, Some(5500));
    }

    #[test]
    fn 无msg字段的行不吞掉后续内容() {
        let recs = parse_text(
            "x",
            "x.log",
            "$$ts=2026-01-01 00:00:00 $$debuglevel=INFO",
            1,
        );
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].level.as_deref(), Some("INFO"));
        assert_eq!(recs[0].msg, "");
    }

    #[test]
    fn 文件开头没有前缀的碎片被丢弃() {
        let text = "尾巴碎片\r\n$$callid=a-1 $$msg=hi\r\n";
        let recs = parse_text("x", "x.log", text, 1);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].msg, "hi");
        assert_eq!(recs[0].line_no, 2, "行号按物理行算，不按记录算");
    }

    #[test]
    fn 堆栈超长被截断并标记() {
        let mut text = String::from("$$callid=a-1 $$msg=boom\n");
        for i in 0..200 {
            text.push_str(&format!("\tat pkg.C.m({i})\n"));
        }
        let recs = parse_text("x", "x.log", &text, 1);
        assert_eq!(recs[0].stack.len(), MAX_STACK_LINES);
        assert!(recs[0].stack_truncated);
    }

    #[test]
    fn logger配置按后缀切分且保留点名() {
        let text = "\
# comment
warningsql.level=ERROR
warningsql.pattern=$$callid=%X{serial} $$msg=%m %n
warningsql.file=./nclogs/${server}/warningsql-log.log
warningsql.size.maxSize=5MB
warningsql.size.maxIndex=20

nc.bs.framework.codesync.level=OFF
nc.bs.framework.codesync.file=./nclogs/${server}/codesync-log.log

icl.file=./nclogs/${server}/icl/icl-log.log
icl.time=.yyyy-MM-dd

broken.key.no.file=1
";
        let defs = parse_logger_config(text);
        assert_eq!(defs.len(), 3, "只有带 .file 的条目才算 logger");

        let w = defs.iter().find(|d| d.name == "warningsql").unwrap();
        assert_eq!(w.max_index, Some(20));
        assert_eq!(w.max_size.as_deref(), Some("5MB"));
        assert_eq!(w.level.as_deref(), Some("ERROR"));
        assert!(!w.dated);

        let codesync = defs
            .iter()
            .find(|d| d.name == "nc.bs.framework.codesync")
            .unwrap();
        assert_eq!(
            codesync.level.as_deref(),
            Some("OFF"),
            "点名里的点不能被切掉"
        );

        let icl = defs.iter().find(|d| d.name == "icl").unwrap();
        assert!(icl.dated, "有 .time 的是按日期滚动");
        assert_eq!(icl.max_index, None);
    }

    #[test]
    fn server占位符优先字面量server() {
        let dir = std::env::temp_dir().join(format!("ncforge-logtest-{}", std::process::id()));
        let server = dir.join("nclogs").join("server");
        std::fs::create_dir_all(&server).unwrap();
        std::fs::write(server.join("nc-log.log"), b"x").unwrap();

        // prop 里的服务器名是 xuyserver，但文件在 nclogs/server/ 下
        let (path, exists) =
            resolve_template(&dir, "./nclogs/${server}/nc-log.log", Some("xuyserver"));
        assert!(exists);
        assert!(path.ends_with(Path::new("nclogs").join("server").join("nc-log.log")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 轮转后缀只认数字与日期() {
        assert_eq!(rotation_index("nc-log.log.1", "nc-log.log"), Some(1));
        assert_eq!(rotation_index("nc-log.log.12", "nc-log.log"), Some(12));
        assert_eq!(
            rotation_index("icl-log.log.2022-08-30", "icl-log.log"),
            Some(u32::MAX)
        );
        assert_eq!(rotation_index("nc-log.log", "nc-log.log"), None);
        assert_eq!(rotation_index("nc-log.log.bak", "nc-log.log"), None);
        assert_eq!(rotation_index("nc-log.log.2022-8-3", "nc-log.log"), None);
        // 别的 logger 的文件不算自己的轮转
        assert_eq!(rotation_index("sql-log.log.1", "nc-log.log"), None);
    }

    #[test]
    fn 尾部读取从完整行开始且行号准确() {
        let dir = std::env::temp_dir().join(format!("ncforge-logtail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.log");
        // 300 条记录（约 6.6KB，超过 read_tail 的 4KB 下限，必然只读尾部）
        let mut text = String::new();
        for i in 0..300 {
            text.push_str(&format!("$$callid=c-{i} $$msg=msg-{i}\n"));
        }
        std::fs::write(&path, &text).unwrap();

        let chunk = read_tail(&path, 4096).unwrap();
        assert!(chunk.truncated);
        let body = String::from_utf8(chunk.bytes.clone()).unwrap();
        assert!(!body.contains("msg-0\n"), "不该包含首条");
        let recs = parse_text("x", "big.log", &body, chunk.first_line_no);
        let last = recs.last().unwrap();
        assert_eq!(last.msg, "msg-299");
        assert_eq!(last.line_no, 300, "最后一条必须报真实行号 300");
        // 切片里的每一条行号都要自洽：msg-N 必须落在第 N+1 行
        for r in &recs {
            let n: u32 = r.msg.trim_start_matches("msg-").parse().unwrap();
            assert_eq!(r.line_no, n + 1, "行号错位: {}", r.msg);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 小文件整份读不标记截断() {
        let dir = std::env::temp_dir().join(format!("ncforge-logsmall-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.log");
        std::fs::write(&path, b"$$msg=a\n$$msg=b\n").unwrap();
        let chunk = read_tail(&path, DEFAULT_MAX_BYTES).unwrap();
        assert!(!chunk.truncated);
        assert_eq!(chunk.first_line_no, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gbk日志能正确解码() {
        let zh = "$$callid= $$msg=< SELECT * FROM bi_conf_cache>throws ORA-00942: 表或视图不存在\n";
        let (gbk, _, _) = encoding_rs::GBK.encode(zh);
        let text = decode_lossy(&gbk);
        assert!(
            text.contains("表或视图不存在"),
            "GBK 必须先解对再判规则: {text}"
        );
        let recs = parse_text("nc", "nc-log.log", &text, 1);
        assert!(recs[0].msg.contains("表或视图不存在"));
    }

    #[test]
    fn 文件名反推logger名() {
        assert_eq!(logger_name_of("nc-log.log"), "nc");
        assert_eq!(logger_name_of("metadata.log"), "metadata");
        assert_eq!(logger_name_of("weird.txt"), "weird.txt");
    }
}
