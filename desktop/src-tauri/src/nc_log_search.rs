//! NC 日志的**全文/正则检索** —— 只回答「这条记录命中了吗、第一处命中的是哪一行」。
//!
//! 与 `nc_log_cmds` 的分工：那边决定读哪些文件、读多少、怎么包成前端形状；
//! 这边是纯函数，能单测、没有 IO。
//!
//! ## 三个刻意的取舍
//!
//! 1. **按「行」判，不把整条记录拼成一串**。日志的 msg 与堆栈是物理上的不同行，
//!    拼起来后 `^` / `$` 会跨行失效，`\n` 也会被拼出来的换行符骗到。逐行判，
//!    用户在心里怎么读日志，正则就怎么生效。
//! 2. **命中行优先取 msg**。列表里直接显示「为什么命中」；命中在堆栈里时显示那行堆栈，
//!    命中在头部字段（callid / thread …）时合成 `callid=…` 给出来 —— 否则列表只能
//!    显示消息首行，用户看不出这条为什么被搜出来。
//! 3. **允许忽略大小写，但按字节折**。`to_lowercase()` 会为每行分配一份新字符串，
//!    10 个 5MB 文件下来是几百 MB 的临时分配；`eq_ignore_ascii_case` 对中文等价于
//!    普通包含（中文没有大小写），正好够用。
//!
//! 正则能匹配空串（`a*`、`x?`、`^`）时直接在入口拒掉：那等于每行都命中，
//! 界面上只会看到「全部记录」，既慢又没有任何定位价值。这条与工程搜索一致。

use crate::nc_log::LogRecord;

/// 命中行的展示上限（按**字符**算，不按字节 —— 中文一行 300 字节只有 100 个字）。
const MAX_LINE_CHARS: usize = 300;

/// 一条记录的命中情况。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordMatch {
    /// 第一处命中的整行（已 trim、超长截断），列表直接显示。
    pub line: String,
    /// 命中的行数（同一行命中多次算 1，msg / 堆栈 / 头部字段都算）。
    pub lines: usize,
}

/// 匹配器：字面量（可忽略大小写）或正则，编译一次复用。
#[derive(Debug)]
pub enum Matcher {
    Literal {
        needle: String,
        case_sensitive: bool,
    },
    Regex(regex::Regex),
}

impl Matcher {
    /// 编译匹配器。空查询、非法正则都返回人话错误，界面直接摆出来。
    pub fn build(query: &str, regex: bool, case_sensitive: bool) -> Result<Self, String> {
        let q = query.trim();
        if q.is_empty() {
            return Err("检索词不能为空".into());
        }
        if !regex {
            return Ok(Matcher::Literal {
                needle: q.to_string(),
                case_sensitive,
            });
        }
        let re = regex::RegexBuilder::new(q)
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|e| format!("正则表达式不合法：{e}"))?;
        if re.is_match("") {
            return Err(
                "该正则可以匹配空串（例如 a*、x?、^），等于每一行都命中，请加上限定条件".into(),
            );
        }
        Ok(Matcher::Regex(re))
    }

    pub fn is_match(&self, line: &str) -> bool {
        match self {
            Matcher::Literal {
                needle,
                case_sensitive,
            } => contains(line, needle, *case_sensitive),
            Matcher::Regex(re) => re.is_match(line),
        }
    }

    /// 文件级预筛用的字节针。
    ///
    /// 只有「字面量 + 区分大小写 + 纯 ASCII」时才给：日志文件是 GBK，
    /// 中文查询的 UTF-8 字节与文件对不上；忽略大小写又得逐字节折，
    /// 预筛本身就不便宜了。最稳的一档已经能挡掉绝大多数无关文件。
    pub fn ascii_prefilter(&self) -> Option<&[u8]> {
        match self {
            Matcher::Literal {
                needle,
                case_sensitive: true,
            } if needle.is_ascii() => Some(needle.as_bytes()),
            _ => None,
        }
    }
}

/// 判断一条记录是否命中；命中时给出第一处命中的行与命中行数。
///
/// 判序 = msg → 堆栈 → 头部字段。msg 物理上在最后，但它是唯一「有内容」的那行：
/// 让它优先，列表才不会显示 `ts=2026-10-30 …` 这种对用户毫无意义的命中行；
/// 头部字段兜底命中（搜 callid / 线程名）。
pub fn scan_record(rec: &LogRecord, matcher: &Matcher) -> Option<RecordMatch> {
    let mut hit = RecordMatch::default();

    let take = |text: &str, hit: &mut RecordMatch, display: Option<String>| {
        if text.trim().is_empty() || !matcher.is_match(text) {
            return;
        }
        hit.lines += 1;
        if hit.line.is_empty() {
            hit.line = display.unwrap_or_else(|| clip(text));
        }
    };

    take(&rec.msg, &mut hit, None);
    for line in &rec.stack {
        take(line, &mut hit, None);
    }
    for (key, value) in header_fields(rec) {
        take(value, &mut hit, Some(format!("{key}={value}")));
    }

    (hit.lines > 0).then_some(hit)
}

/// 头部字段的 `k=v` 合成行，顺序与日志里一致。
fn header_fields(rec: &LogRecord) -> Vec<(&'static str, &str)> {
    let mut out = Vec::new();
    if let Some(v) = rec.call_id.as_deref() {
        out.push(("callid", v));
    }
    if let Some(v) = rec.thread.as_deref() {
        out.push(("thread", v));
    }
    if let Some(v) = rec.user_id.as_deref() {
        out.push(("userid", v));
    }
    if let Some(v) = rec.ts.as_deref() {
        out.push(("ts", v));
    }
    if let Some(v) = rec.remote_call.as_deref() {
        out.push(("remotecall", v));
    }
    if let Some(v) = rec.level.as_deref() {
        out.push(("debuglevel", v));
    }
    out
}

fn clip(line: &str) -> String {
    let t = line.trim();
    if t.chars().count() <= MAX_LINE_CHARS {
        return t.to_string();
    }
    let cut: String = t.chars().take(MAX_LINE_CHARS).collect();
    format!("{cut}…")
}

fn contains(hay: &str, needle: &str, case_sensitive: bool) -> bool {
    if needle.is_empty() {
        return false;
    }
    if case_sensitive {
        return hay.contains(needle);
    }
    let (hb, nb) = (hay.as_bytes(), needle.as_bytes());
    if nb.len() > hb.len() {
        return false;
    }
    hb.windows(nb.len()).any(|w| w.eq_ignore_ascii_case(nb))
}

/// 子串查找（不引依赖；callid 一般 ≤ 30 字节，暴力搜足够快）。
pub fn bytes_contain(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || hay.len() < needle.len() {
        return false;
    }
    hay.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(msg: &str) -> LogRecord {
        LogRecord {
            logger: "nc".into(),
            file: "nc-log.log".into(),
            line_no: 1,
            ts: Some("2026-10-30 15:23:47".into()),
            call_id: Some("1751016333490-3845".into()),
            thread: Some("http-bio-80-exec-7".into()),
            msg: msg.into(),
            ..LogRecord::default()
        }
    }

    #[test]
    fn 字面量默认忽略大小写() {
        let m = Matcher::build("ora-00942", false, false).unwrap();
        assert!(m.is_match("throws ORA-00942: 表或视图不存在"));
        let exact = Matcher::build("ora-00942", false, true).unwrap();
        assert!(!exact.is_match("throws ORA-00942: 表或视图不存在"));
        // 中文没有大小写，忽略大小写时等价于普通包含
        let cn = Matcher::build("表或视图不存在", false, false).unwrap();
        assert!(cn.is_match("throws ORA-00942: 表或视图不存在"));
    }

    #[test]
    fn 空检索词与非法正则是人话错误() {
        assert_eq!(
            Matcher::build("   ", false, false).unwrap_err(),
            "检索词不能为空"
        );
        let bad = Matcher::build("(unclosed", true, false).unwrap_err();
        assert!(bad.starts_with("正则表达式不合法"), "{bad}");
        // 能匹配空串的正则等于每行都命中，入口就挡掉
        let empty = Matcher::build("a*", true, false).unwrap_err();
        assert!(empty.contains("匹配空串"), "{empty}");
    }

    #[test]
    fn 命中行优先取消息再取堆栈() {
        let m = Matcher::build("DuplicateException", false, true).unwrap();
        let mut r = rec("info: module=mmbcm-scm, catch root");
        r.stack = vec![
            "nc.bs.framework.exception.DuplicateException: Detail Message".into(),
            "  at nc.bs.framework.server.AbstractContainer.register".into(),
        ];
        let hit = scan_record(&r, &m).expect("堆栈里应当命中");
        assert!(hit
            .line
            .starts_with("nc.bs.framework.exception.DuplicateException"));
        assert_eq!(hit.lines, 1);

        // msg 与堆栈都命中时，第一处给 msg（物理上在最后，但人要看的是它）
        let m2 = Matcher::build("detail", false, false).unwrap();
        let hit2 = scan_record(&r, &m2).unwrap();
        assert!(hit2
            .line
            .starts_with("nc.bs.framework.exception.DuplicateException"));
        assert_eq!(hit2.lines, 1);
    }

    #[test]
    fn 头部字段命中也给得出来() {
        let m = Matcher::build("1751016333490-3845", false, true).unwrap();
        let hit = scan_record(&rec("select 1 from dual"), &m).expect("callid 应当命中");
        assert_eq!(hit.line, "callid=1751016333490-3845");
        assert_eq!(hit.lines, 1);
    }

    #[test]
    fn 命中行超长按字符截断() {
        let long = format!("ORA-00942{}", "中".repeat(400));
        let m = Matcher::build("ORA-00942", false, true).unwrap();
        let hit = scan_record(&rec(&long), &m).unwrap();
        assert!(hit.line.ends_with('…'));
        assert_eq!(
            hit.line.chars().count(),
            MAX_LINE_CHARS + 1,
            "300 字 + 省略号"
        );
    }

    #[test]
    fn 未命中返回none() {
        let m = Matcher::build("不存在的东西", false, false).unwrap();
        assert!(scan_record(&rec("select 1 from dual"), &m).is_none());
    }

    #[test]
    fn 字节预筛只在最稳的一档出现() {
        let cs = Matcher::build("ORA-00942", false, true).unwrap();
        assert_eq!(cs.ascii_prefilter(), Some(b"ORA-00942".as_slice()));
        let ci = Matcher::build("ORA-00942", false, false).unwrap();
        assert!(
            ci.ascii_prefilter().is_none(),
            "忽略大小写时字节对不上，不能预筛"
        );
        let cn = Matcher::build("表不存在", false, true).unwrap();
        assert!(
            cn.ascii_prefilter().is_none(),
            "GBK 文件里中文的 UTF-8 字节对不上"
        );
        let re = Matcher::build("ORA-\\d+", true, true).unwrap();
        assert!(re.ascii_prefilter().is_none());
    }

    #[test]
    fn 字节子串查找() {
        assert!(bytes_contain(b"abc$$callid=x-1$$", b"x-1"));
        assert!(!bytes_contain(b"short", b"longer-than-hay"));
        assert!(!bytes_contain(b"abc", b""));
        assert!(bytes_contain(b"abc", b"abc"));
    }
}
