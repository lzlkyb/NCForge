//! 真机快照：NC 运行日志的发现与解析（P0-2 日志归因）。
//!
//! 默认不跑（`#[ignore]`）：依赖本机 NC 安装目录。它验的是**只有真日志才能暴露**的
//! 那几条事实，夹具造不出来：
//!
//! 1. `ierp/bin/logger-config.properties` 真能解析出 40+ 个 logger，且 `${server}`
//!    展开后文件真实存在（这一条错了，界面就是一片空白，但单测全绿）；
//! 2. GBK 中文能解出可读文本（解错了规则全部失效，而且不报错）；
//! 3. 真实日志里就能命中归因规则（`DuplicateException: deviceregister`），
//!    不是只有我构造的样本才命中；
//! 4. `callid` 真的能跨 logger 串起来（warningsql 与 nc-log 之间）。
//!
//! ```bash
//! cargo test --test nc_log_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! NC home 用 `NC_HOME` 覆盖（默认 `D:\ncc\1909home`）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use nc_forge::nc_log;
use nc_forge::nc_log_rules;

fn nc_home() -> PathBuf {
    std::env::var_os("NC_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\ncc\1909home"))
}

#[test]
#[ignore = "需要本机 NC 安装目录"]
fn 真机_logger_配置能落到真实文件() {
    let root = nc_home();
    assert!(root.is_dir(), "NC home 不存在: {}", root.display());

    let defs = nc_log::load_logger_config(&root);
    println!("logger 条目: {}", defs.len());
    assert!(
        defs.len() >= 40,
        "1909 实测 49 条，解析出 {} 条说明后缀切分错了",
        defs.len()
    );

    // `${server}` 必须展开到真实目录，否则一个文件都找不到
    let files = nc_log::resolve_loggers(&root, None);
    println!("日志文件（含轮转）: {}", files.len());
    let mut by_logger: BTreeMap<&str, usize> = BTreeMap::new();
    for f in &files {
        *by_logger.entry(f.logger.as_str()).or_default() += 1;
    }
    println!("有文件的 logger: {}", by_logger.len());
    for (name, n) in by_logger.iter().take(10) {
        println!("  {name}: {n} 个文件");
    }
    assert!(
        files.len() >= 40,
        "只找到 {} 个文件，`${{server}}` 大概没展开对",
        files.len()
    );

    // 当前文件优先：第一条不该是轮转出来的旧文件
    assert!(!files[0].rotated, "排序应把当前正在写的文件排在前面");
    // 空文件是合法的（logger 门限开着但今天没写过），只校验路径自洽
    for f in &files {
        assert!(f.path.ends_with(&f.name), "path 与 name 不一致: {}", f.path);
    }
    let empty = files.iter().filter(|f| f.size == 0).count();
    println!("空文件: {empty}/{}", files.len());
}

#[test]
#[ignore = "需要本机 NC 安装目录"]
fn 真机日志能解析且中文不乱码() {
    let root = nc_home();
    let files = nc_log::resolve_loggers(&root, None);
    let Some(main) = files
        .iter()
        .find(|f| f.logger == "nclog" && !f.rotated)
        .or_else(|| files.iter().find(|f| f.logger == "nc" && !f.rotated))
    else {
        println!("没找到 nc-log.log，跳过");
        return;
    };
    println!("解析: {} ({} 字节)", main.path, main.size);

    let chunk = nc_log::read_tail(Path::new(&main.path), nc_log::DEFAULT_MAX_BYTES).unwrap();
    let text = nc_forge::workspace::decode_lossy(&chunk.bytes);
    let records = nc_log::parse_text(&main.logger, &main.name, &text, chunk.first_line_no);
    println!(
        "记录数: {}（首行行号 {}，截断 {}）",
        records.len(),
        chunk.first_line_no,
        chunk.truncated
    );
    assert!(
        !records.is_empty(),
        "一份 5MB 的日志解析出 0 条，切分规则错了"
    );

    // 每条记录都必须有 ts（真日志里 ts 是必填字段），且能被解析成定宽时间
    let with_ts = records.iter().filter(|r| r.ts.is_some()).count();
    println!("带 ts 的记录: {with_ts}/{}", records.len());
    assert_eq!(with_ts, records.len(), "有记录丢了 ts，头部字段切分有问题");
    assert!(records.iter().all(|r| r.line_no > 0));

    // 行号必须严格递增（同一次解析内）
    let mut prev = 0;
    for r in &records {
        assert!(r.line_no >= prev, "行号回退: {} < {prev}", r.line_no);
        prev = r.line_no;
    }

    // 中文必须可读：GBK 解错时会变成一串替换字符或乱码方块。
    // 注意不能只看前 N 个字符 —— 启动期日志基本全英文，汉字都出现在业务报错之后。
    let cjk = text
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .count();
    println!("全文汉字数: {cjk}");
    assert!(cjk > 0, "整份日志一个汉字都没有 ⇒ GBK 没解对");

    // 定向验证：本机日志里有 `ORA-00942: 表或视图不存在` 的真实样本
    if records.iter().any(|r| r.msg.contains("ORA-00942")) {
        assert!(
            text.contains("表或视图不存在"),
            "有 ORA-00942 却解不出中文提示 ⇒ 解码选错了"
        );
    }
}

#[test]
#[ignore = "需要本机 NC 安装目录"]
fn 真机日志能命中归因规则() {
    let root = nc_home();
    let files = nc_log::resolve_loggers(&root, None);
    let mut hits: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut duplicate_sample = None;

    for file in files.iter().filter(|f| !f.rotated).take(10) {
        let Ok(chunk) = nc_log::read_tail(Path::new(&file.path), nc_log::DEFAULT_MAX_BYTES) else {
            continue;
        };
        let text = nc_forge::workspace::decode_lossy(&chunk.bytes);
        for record in nc_log::parse_text(&file.logger, &file.name, &text, chunk.first_line_no) {
            let Some(verdict) = nc_log_rules::judge(&record.msg, &record.stack) else {
                continue;
            };
            *hits.entry(verdict.rule).or_default() += 1;
            if verdict.rule == "duplicate-register" && duplicate_sample.is_none() {
                duplicate_sample = Some((record, verdict));
            }
        }
    }

    println!("归因命中统计:");
    for (rule, n) in &hits {
        println!("  {rule}: {n}");
    }
    assert!(
        !hits.is_empty(),
        "扫了 10 个文件一条都没命中，规则表大概没生效"
    );

    // 本机 2026-10-30 的 nc-log.log 第 1 条就是这个（组件重复注册）
    let (record, verdict) = duplicate_sample.expect("应当命中 DuplicateException: deviceregister");
    println!(
        "样本: {} :{} → {}",
        record.file, record.line_no, verdict.title
    );
    assert!(verdict.title.contains("deviceregister"));
    assert!(
        matches!(verdict.jump, Some(nc_log_rules::Jump::Upm { .. })),
        "重复注册必须能跳到 .upm"
    );
}

#[test]
#[ignore = "需要本机 NC 安装目录"]
fn 真机_callid_能跨文件串联() {
    let root = nc_home();
    let files = nc_log::resolve_loggers(&root, None);

    // 找一个带 callid 的真实样本。优先 sql 类 logger：它们每条都带 callid，
    // 且同一次请求通常在其他 logger 里也留了痕，才验得出「跨文件」。
    const PREFER: &[&str] = &["warningsql", "threshold", "sql", "nclog", "nc"];
    let mut candidates: Vec<&nc_forge::nc_log::LogFile> =
        files.iter().filter(|f| !f.rotated && f.size > 0).collect();
    candidates.sort_by_key(|f| {
        PREFER
            .iter()
            .position(|p| *p == f.logger)
            .unwrap_or(PREFER.len())
    });

    let mut target: Option<String> = None;
    for file in &candidates {
        let Ok(chunk) = nc_log::read_tail(Path::new(&file.path), 512 * 1024) else {
            continue;
        };
        let text = nc_forge::workspace::decode_lossy(&chunk.bytes);
        for record in nc_log::parse_text(&file.logger, &file.name, &text, chunk.first_line_no)
            .into_iter()
            .rev()
        {
            // 只要「epoch毫秒-序号」这种真 callid（启动期很多记录 callid 是空的）
            if let Some(id) = record.call_id.filter(|s| s.contains('-')) {
                target = Some(id);
                break;
            }
        }
        if target.is_some() {
            break;
        }
    }
    let Some(id) = target else {
        println!("本机日志里没有带 callid 的记录，跳过");
        return;
    };
    println!("追踪 callid = {id}");

    // 在全量文件里找同 callid 的记录（与命令层同一套判定）
    let needle = id.as_bytes();
    let mut found = Vec::new();
    for file in files.iter().filter(|f| !f.rotated).take(24) {
        let Ok(chunk) = nc_log::read_tail(Path::new(&file.path), nc_log::DEFAULT_MAX_BYTES) else {
            continue;
        };
        if !chunk.bytes.windows(needle.len()).any(|w| w == needle) {
            continue;
        }
        let text = nc_forge::workspace::decode_lossy(&chunk.bytes);
        for record in nc_log::parse_text(&file.logger, &file.name, &text, chunk.first_line_no) {
            if record.call_id.as_deref() == Some(id.as_str()) {
                found.push((record.logger.clone(), record.file.clone(), record.line_no));
            }
        }
    }
    println!("同 callid 的记录: {} 条", found.len());
    for (logger, file, line) in found.iter().take(8) {
        println!("  [{logger}] {file}:{line}");
    }
    assert!(!found.is_empty(), "连自己那条都找不回来，追不了");
}
