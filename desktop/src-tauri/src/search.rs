//! 工作区全文搜索（M2「全工程搜索」的后端）。
//!
//! 纯逻辑模块，**不含 tauri 类型**（理由同 `workspace.rs`：壳子 crate 开了 test
//! feature 会让测试二进制启动即挂，可测逻辑一律放这里）。
//!
//! 几条按 NC 工程实况定下的规则：
//! - 跳过 `.svn` / `.git` / `.idea` / `node_modules`：前两个是版本库元数据，
//!   后两个体积大且与源码无关；`classes` / `out` 不跳过——里面的 `.class` 会被
//!   二进制探测挡掉，不额外花时间。
//! - 编码沿用 `workspace::decode_lossy`：NC 工程里 GBK 与 UTF-8 混放，按 UTF-8
//!   硬解会把一半文件读成乱码，搜索就静默搜不到。
//! - 一个文件命中多行时，每行各出结果（Eclipse 的搜索视图也是这样按行列）。
//! - 有结果条数与耗时双上限：7000+ 个源文件全量扫一遍在机械盘上可能要几秒，
//!   不能让它无限跑；触顶就把 `truncated` 置真，前端据此提示「结果已截断」。
//! - 每行额外回 `ranges`（命中区间）。正则模式下前端无法自己 `indexOf` 出高亮位置，
//!   所以高亮一律由后端给，纯文本模式也走同一字段，前端只写一份渲染逻辑。

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

use crate::content_pack;
use crate::workspace;

/// 递归时不进入的目录。
const SKIP_DIRS: [&str; 4] = [".svn", ".git", ".idea", "node_modules"];

/// 按扩展名直接判为二进制的文件，连打开都不打开。
///
/// 实测：newar 里 16688 个文件有 8665 个是 `classes/**/*.class`，它们本来也会被
/// NUL 探测挡掉，但**每个都要 open+read 一次**。在这台机器上一次打开约 3ms，
/// 光打开它们就要 26 秒，直接把搜索预算烧光（扫到 5000 个文件就超时）。
/// 先按扩展名排除，候选文件直接砍掉一半。
const SKIP_EXTS: [&str; 34] = [
    // 编译产物与压缩包
    "class", "jar", "war", "ear", "zip", "gz", "7z", "rar", "tar", // 图片
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "psd", "tif", "tiff", "webp",
    // 文档与字体
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "ttf", "otf", "woff", "woff2",
    // 可执行与库
    "dll", "exe", "so", "dylib",
];

/// 单个文件的搜索上限：比 `workspace::MAX_FILE_BYTES` 更保守，
/// 大文件里命中一次也不值得让整体变慢。
const MAX_SEARCH_BYTES: u64 = 4 * 1024 * 1024;

/// 结果条数上限（一次搜索最多回这么多行）。
const HARD_MAX_RESULTS: usize = 500;

/// 结果行文本的截断长度（字符数）。一行 6000 字符的代码整行塞进面板没有意义。
const MAX_LINE_CHARS: usize = 300;

/// 单行最多保留多少个高亮区间。一行里命中几十次的多半是压缩或生成产物，
/// 标满反而看不清；封顶也让 regex 的 `find_iter` 有个停点。
const MAX_RANGES_PER_LINE: usize = 32;

/// 总耗时上限（毫秒）。触顶即停，返回已有结果并标 `truncated`。
///
/// 20 秒的依据是实测：本机冷缓存八线程读约 370 文件/秒，7000+ 个文件全量约 23 秒，
/// 20 秒能覆盖到八成以上；第二次搜索走系统文件缓存只要 1~2 秒。定得再长，
/// 「什么都没搜到时还要干等」的代价就超过收益了。
pub const TIME_BUDGET_MS: u128 = 20_000;

/// 搜索闸门：按来源登记正在跑的搜索，并限制同时运行的全量扫描数。
///
/// - 同一来源（如快速面板）的新搜索会把旧搜索的取消标志置位；
/// - 同时只放 `slots` 个扫描进场：单次扫描内部已有 8 线程并行，再叠加只会抢磁盘；
///   排队中被取消的不再等，直接以「已取消」进场（扫描会立刻返回半成品）。
///
/// 放在纯逻辑模块里是为了能单测（命令层只持有一个全局实例）。
pub struct SearchGate {
    slots: usize,
    state: Mutex<GateState>,
    freed: Condvar,
}

#[derive(Default)]
struct GateState {
    running: usize,
    by_source: HashMap<String, Arc<AtomicBool>>,
}

/// 请求到达时就登记，不能等阻塞线程启动后才登记：线程可能晚于取消或后来的请求。
pub struct SearchRequest<'a> {
    gate: &'a SearchGate,
    source: Option<String>,
    flag: Arc<AtomicBool>,
    holding: bool,
}

impl SearchGate {
    pub fn new(slots: usize) -> Self {
        Self {
            slots: slots.max(1),
            state: Mutex::new(GateState::default()),
            freed: Condvar::new(),
        }
    }

    /// 取消某个来源正在跑（或排队）的搜索。没有就什么都不做。
    pub fn cancel(&self, source: &str) {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(flag) = st.by_source.remove(source) {
            flag.store(true, Ordering::Relaxed);
        }
        drop(st);
        // 排队中的人要醒来看一眼自己是不是被取消了
        self.freed.notify_all();
    }

    /// 在第一个 await / spawn_blocking 之前调用；入口失败时 Drop 也会注销请求。
    pub fn register(&self, source: Option<&str>) -> SearchRequest<'_> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(src) = source {
            if let Some(old) = st.by_source.insert(src.to_string(), flag.clone()) {
                old.store(true, Ordering::Relaxed);
                self.freed.notify_all();
            }
        }
        SearchRequest {
            gate: self,
            source: source.map(str::to_owned),
            flag,
            holding: false,
        }
    }

    #[cfg(test)]
    fn run<T>(&self, source: Option<&str>, f: impl FnOnce(&AtomicBool) -> T) -> T {
        self.register(source).run(f)
    }

    #[cfg(test)]
    fn running(&self) -> usize {
        self.state.lock().unwrap().running
    }
}

impl SearchRequest<'_> {
    /// 排队、运行 `f`；被取消的请求不占扫描名额。
    pub fn run<T>(mut self, f: impl FnOnce(&AtomicBool) -> T) -> T {
        let mut st = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        // 等名额；被取消就不占名额直接跑（带着已取消的标志，扫描会马上返回）
        while !self.flag.load(Ordering::Relaxed) {
            if st.running < self.gate.slots {
                st.running += 1;
                self.holding = true;
                break;
            }
            st = self
                .gate
                .freed
                .wait_timeout(st, Duration::from_millis(50))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        drop(st);
        f(&self.flag)
    }
}

impl Drop for SearchRequest<'_> {
    fn drop(&mut self) {
        // panic 和入口提前返回也归还名额，否则会永久少一个坑位。
        let mut st = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.holding {
            st.running -= 1;
        }
        if let Some(src) = &self.source {
            // 只注销自己，不能移除后来的请求。
            if st
                .by_source
                .get(src)
                .is_some_and(|f| Arc::ptr_eq(f, &self.flag))
            {
                st.by_source.remove(src);
            }
        }
        drop(st);
        self.gate.freed.notify_all();
    }
}

/// 搜索选项。前端传 camelCase（与 `serde(rename_all)` 对齐）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    /// 搜索词。正则模式下按原样使用（不 trim：`^\s+$` 这类模式的前后空格有意义）。
    pub text: String,
    /// 是否区分大小写。
    #[serde(default)]
    pub case_sensitive: bool,
    /// 是否按整词匹配（Java 标识符边界：字母数字 `_` `$`）。
    /// 正则模式下此字段被忽略——想整词自己写 `\b`，与 IDEA 的行为一致。
    #[serde(default)]
    pub whole_word: bool,
    /// 是否把 `text` 当正则表达式。
    #[serde(default)]
    pub regex: bool,
    /// 文件过滤：IDEA「File mask」风格，逗号分隔，`!` 前缀表示排除。
    /// 例：`*.java` / `*.java,*.xml` / `*.java,!test*`。空串 = 全都要。
    #[serde(default)]
    pub include: String,
    /// 范围收窄到这些**工作区相对的目录**（`/` 或 `\` 分隔，空 = 整个工作区）。
    ///
    /// 这是「按业务组件搜索」的落点：manifest 只提供 `src/public` 这类源码根，
    /// 拼成 `bill/src/public` 后作为范围传进来。这里刻意**不**接受绝对路径：
    /// 范围只能收窄、不能跳出工作区（白名单之外读写都会被 `workspace_cmds` 拒掉，
    /// 在这里就挡掉能给出更直白的错误）。
    #[serde(default)]
    pub dirs: Vec<String>,
    /// 结果条数上限；0 或超过 `HARD_MAX_RESULTS` 时按上限处理。
    #[serde(default)]
    pub max_results: usize,
    /// 优先扫描的文件（**工作区相对**、`/` 或 `\` 分隔，非法项忽略）。
    ///
    /// 快速面板把它设成最近打开的那些文件：用户多半在找刚看过的东西，
    /// 先扫这一小撮，第一条命中就能在几十毫秒内出现在列表里。
    /// 它只影响扫描顺序，不影响范围与结果集。
    #[serde(default)]
    pub priority: Vec<String>,
    /// 未保存的编辑器内容（overlay）。
    ///
    /// 搜索语料 ≠ 磁盘内容：用户正在编辑、还没保存的文件，磁盘上还是旧的。前端把
    /// dirty 的 Monaco model 传上来，这里**先用 overlay 扫、再从文件清单里跳过这些
    /// 路径**，否则「搜自己刚写的那行」搜不到——这比慢更让人怀疑工具坏了。
    ///
    /// 只接受工作区内路径；单文件与总量上限由前端控制（大文件不进 overlay）。
    #[serde(default)]
    pub overlay: Vec<OverlayDoc>,
}

/// 一份未保存的文档内容。`path` 是工作区相对路径（`/` 分隔）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayDoc {
    pub path: String,
    pub text: String,
}

/// 一条命中里的高亮区间。
///
/// **单位是 UTF-16 码元**，不是字节也不是字符：前端是 TS/JS，字符串下标就是
/// UTF-16 码元，回字节偏移的话前端每行都要重算一遍映射，非 BMP 字符（生僻字、
/// emoji）还会错位。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MatchRange {
    pub start: u32,
    pub end: u32,
}

/// 一条命中：文件 + 行号（1 起）+ 该行内容 + 高亮区间。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// 相对工作区根的路径，统一用 `/` 分隔（前端展示与点击打开都省事）。
    pub path: String,
    pub line: u32,
    /// 该行文本（已按 `MAX_LINE_CHARS` 截断）。
    pub text: String,
    /// 相对 `text` 的命中区间，用于前端画 `<mark>`。
    pub ranges: Vec<MatchRange>,
}

/// 一次搜索的汇总。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub hits: Vec<SearchHit>,
    /// 实际读取的文件数（用于告诉用户「扫了多少」）。
    pub files_scanned: usize,
    /// 至少命中一行的文件数。
    pub files_matched: usize,
    /// 是否因条数或超时提前结束。
    pub truncated: bool,
    pub elapsed_ms: u64,
    /// 本次**真正生效**的范围（工作区相对、`/` 分隔）；空 = 整个工作区。
    ///
    /// 回显给前端而不是让它自己记：请求的范围可能被归一化（去重、丢掉被覆盖的
    /// 子目录）或回落，界面要说的是「实际搜了哪里」，不是「本来想搜哪里」。
    pub scope_dirs: Vec<String>,
    /// 请求了但磁盘上不存在（或非法）的目录，原样回显。
    pub missing_dirs: Vec<String>,
    /// 请求了范围，但一个都不存在 → 已回落成整个工作区。
    ///
    /// manifest 只做参考，磁盘才是真源：组件目录被删/搬走后必须仍然搜得到东西，
    /// 但也要让用户看见「这次没按组件搜」，否则「怎么搜出别的模块」无从解释。
    pub scope_fallback: bool,
    /// 被调用方取消（同来源的新搜索顶替、面板关闭）。此时 `truncated` 也为真，
    /// 结果只是半成品，不能当成「完整搜索无结果」展示。
    pub cancelled: bool,
}

/// 实际生效的搜索范围。
///
/// 「按业务组件搜索」只提供一组目录（`bill/src/public` 等），不是一个新的根：
/// 结果里的相对路径必须仍相对**工作区根**，否则前端拼绝对路径要换一套口径，
/// `点击命中打开文件` 与替换都会跟着分叉。
struct Scope {
    /// 工作区相对、`/` 分隔的生效范围（空 = 整个工作区）。
    rel: Vec<String>,
    /// 与 `rel` 一一对应的绝对路径。
    abs: Vec<PathBuf>,
    /// 请求了但不存在/非法的目录（原样回显给前端）。
    missing: Vec<String>,
    /// 一个都没命中 → 已回落整个工作区。
    fallback: bool,
}

/// 把范围目录归一成「工作区相对、`/` 分隔」，非法项返回 `None`。
///
/// 拒绝绝对路径、盘符与 `..`：范围只能**收窄**。不拒绝的话，前端一个笔误就能让
/// 搜索跑到工作区外面去读盘——虽然后续读写有白名单兜着，但在这里给直白结果更省事。
fn normalize_rel_dir(raw: &str) -> Option<String> {
    let mut s = raw.trim().replace('\\', "/");
    while let Some(rest) = s.strip_prefix("./") {
        s = rest.to_string();
    }
    if s.contains(':') {
        return None; // 盘符 / NTFS 数据流
    }
    let mut segs: Vec<&str> = Vec::new();
    for seg in s.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return None,
            other => segs.push(other),
        }
    }
    if segs.is_empty() {
        None
    } else {
        Some(segs.join("/"))
    }
}

/// 判断 `child` 是否在 `parent` 里（含等于）。两者都是归一化后的 `小写` 串。
fn rel_within(child: &str, parent: &str) -> bool {
    child == parent
        || (child.len() > parent.len()
            && child.starts_with(parent)
            && child.as_bytes()[parent.len()] == b'/')
}

/// 把请求的范围解析成真正要走的目录。
///
/// 三件事：归一化 + 去重；丢掉被更短范围覆盖的子目录（否则同一个文件被数两遍，
/// 结果里会出现重复行）；逐个 `is_dir()` 验一下，全都不存在就回落整个工作区。
fn plan_scope(root: &Path, dirs: &[String]) -> Scope {
    if dirs.is_empty() {
        return Scope {
            rel: Vec::new(),
            abs: Vec::new(),
            missing: Vec::new(),
            fallback: false,
        };
    }
    let mut want: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for raw in dirs {
        match normalize_rel_dir(raw) {
            Some(rel) => {
                if !want.iter().any(|w| w.eq_ignore_ascii_case(&rel)) {
                    want.push(rel);
                }
            }
            None => missing.push(raw.clone()),
        }
    }
    // 短的先占位：`bill/src` 已经在范围里时，`bill/src/public` 只会让它数两遍
    want.sort_by(|a, b| a.len().cmp(&b.len()).then(a.cmp(b)));
    let mut kept: Vec<String> = Vec::new();
    for rel in want {
        let lower = rel.to_lowercase();
        if kept.iter().any(|k| rel_within(&lower, &k.to_lowercase())) {
            continue;
        }
        kept.push(rel);
    }

    let mut abs = Vec::new();
    let mut alive = Vec::new();
    for rel in kept {
        let p = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if p.is_dir() {
            abs.push(p);
            alive.push(rel);
        } else {
            missing.push(rel);
        }
    }
    if abs.is_empty() {
        // 全部不存在：manifest 与磁盘不一致（组件被删/改名）时不能让用户一无所获
        return Scope {
            rel: Vec::new(),
            abs: Vec::new(),
            missing,
            fallback: true,
        };
    }
    Scope {
        rel: alive,
        abs,
        missing,
        fallback: false,
    }
}

/// 匹配器：纯文本与正则两条路，编译一次复用（正则逐行编译会慢到不可用）。
#[derive(Debug)]
enum Matcher {
    Plain {
        needle: String,
        case_sensitive: bool,
        whole_word: bool,
    },
    /// `re` 逐行匹配（高亮与替换都用它）；`file` 是同一模式加 `(?m)` 的整文件版本，
    /// 只用来做「这个文件一个命中都没有」的先行否决（见 `file_may_match`）。
    /// `lits` 是抽出的一组「至少出现一个」的必需字面量，能用 memmem 再挡一层。
    Re {
        re: regex::Regex,
        file: Option<regex::Regex>,
        lits: Option<Vec<Vec<u8>>>,
    },
}

impl Matcher {
    fn build(opts: &SearchOptions) -> Result<Self, String> {
        if opts.regex {
            let re = RegexBuilder::new(&opts.text)
                .case_insensitive(!opts.case_sensitive)
                .build()
                .map_err(|e| format!("正则表达式无效：{e}"))?;
            // 能匹配空串的模式（`a*`、`x?`、`^`）等于「每行都命中」：7000 个文件会
            // 全量产出结果、又没有任何定位价值，直接在入口挡掉比让它跑 15 秒好。
            if re.is_match("") {
                return Err(
                    "该正则可以匹配空串（例如 a*、x?），会让每一行都命中，请加上限定条件".into(),
                );
            }
            // 整文件预判必须与「逐行 find」等价：逐行时 `^` / `$` 落在行边界上，
            // 所以预判版要加 `(?m)` 才能把行边界算进去（否则 `^foo` 只在文件开头成立，
            // 中间行的命中会被误否决——那是漏结果，不是慢）。
            // `\A` / `\z` / `\Z` 锚的是整段文本，加 `(?m)` 也不等价；用户自己写
            // `(?-m)` 关掉多行同样会让锚点回到文件级。这些模式一律**放弃预判**，
            // 老老实实逐行扫——漏结果是不能用「只是慢一点」来换的。
            let anchored = ["\\A", "\\z", "\\Z", "(?-"]
                .iter()
                .any(|a| opts.text.contains(a));
            let file = if anchored {
                None
            } else {
                RegexBuilder::new(&format!("(?m){}", opts.text))
                    .case_insensitive(!opts.case_sensitive)
                    .build()
                    .ok()
            };
            return Ok(Matcher::Re {
                re,
                file,
                lits: required_literals(&opts.text, opts.case_sensitive),
            });
        }
        Ok(Matcher::Plain {
            needle: opts.text.trim().to_string(),
            case_sensitive: opts.case_sensitive,
            whole_word: opts.whole_word,
        })
    }

    /// 返回该行所有命中区间的**字节**偏移（调用方负责换算成 UTF-16）。
    fn spans(&self, line: &str, cap: usize) -> Vec<(usize, usize)> {
        match self {
            Matcher::Plain {
                needle,
                case_sensitive,
                whole_word,
            } => {
                if !*whole_word && *case_sensitive {
                    // `str::match_indices` 走 two-way 算法（含 memchr 快路），
                    // 比手写字节循环快；只有它不覆盖「整词」和「忽略大小写」两档。
                    return line
                        .match_indices(needle.as_str())
                        .take(cap)
                        .map(|(s, m)| (s, s + m.len()))
                        .collect();
                }
                plain_spans(line, needle, *case_sensitive, *whole_word, cap)
            }
            Matcher::Re { re, .. } => re
                .find_iter(line)
                // 零宽命中（`\b`、`(?=x)` 之类）没有可高亮的字符，丢掉，
                // 免得渲染成一堆看不见的空 `<mark>` 还把 cap 占满。
                .filter(|m| m.end() > m.start())
                .take(cap)
                .map(|m| (m.start(), m.end()))
                .collect(),
        }
    }
}

/// 从正则里抽一组「匹配时至少出现一个」的字面量，供整文件 memmem 预筛。
///
/// HIR 必须用**与 `RegexBuilder` 相同的大小写默认标志**解析：忽略大小写走的是
/// Unicode 折叠（`ſ` 能匹配 `s`、`K` 能匹配 `k`），解析出的字面量集合会包含这些
/// 变体；一旦集合太大变成无限集就返回 `None`，绝不会拿 ASCII 字节去赌。
/// 前瞻/后顾与绝对锚点也一律放弃——抽出来的字节可能不是必要条件。
/// 任何拿不准的情况返回 `None`（不预筛），慢一点可以，漏结果不行。
fn required_literals(pattern: &str, case_sensitive: bool) -> Option<Vec<Vec<u8>>> {
    let unsafe_tokens = ["(?=", "(?!", "(?<=", "(?<!", "\\A", "\\z", "\\Z", "(?-"];
    if unsafe_tokens.iter().any(|a| pattern.contains(a)) {
        return None;
    }
    let mut pb = regex_syntax::ParserBuilder::new();
    if !case_sensitive {
        pb.case_insensitive(true);
    }
    let hir = pb.build().parse(pattern).ok()?;
    let seq = regex_syntax::hir::literal::Extractor::new().extract(&hir);
    // `literals()` 返回 None = 无限集合，等于没有任何可用信息
    let lits = seq.literals()?;
    if lits.is_empty() || lits.len() > 8 {
        return None;
    }
    let out: Vec<Vec<u8>> = lits.iter().map(|l| l.as_bytes().to_vec()).collect();
    // 太短的字面量候选密度高，省不了多少；太长的多半是被截断的片段，也别赌
    if out.iter().any(|b| b.len() < 2 || b.len() > 64) {
        return None;
    }
    Some(out)
}

/// 文件级快速否决（必要条件）：判 false 就保证这个文件里一行都不会命中。
///
/// 三档都等价于逐行扫的结果，因为它们只是「子串/模式必须出现在这个文件里」这层
/// 必要条件——**整词与忽略大小写同样适用**，那是早期版本的漏做，不是设计取舍：
/// 默认档（`caseSensitive: false`）此前没有预筛，只能逐字节比对，newar 上全量
/// 74 MB 要 337 ms，而区分大小写只要 13 ms。
enum Prefilter<'a> {
    /// 区分大小写：整文件查这段字节。
    Exact(&'a str),
    /// 忽略大小写：只折 ASCII（与 `plain_spans` 的 `eq_ignore_ascii_case` 同一口径，
    /// 多字节 UTF-8 字节不动）。首字节的两种大小写变体做 SIMD 候选定位，再逐位验证。
    Fold { needle: &'a str, first: [u8; 2] },
}

impl<'a> Prefilter<'a> {
    fn of(matcher: &'a Matcher) -> Option<Self> {
        match matcher {
            Matcher::Plain {
                needle,
                case_sensitive: true,
                ..
            } => Some(Prefilter::Exact(needle.as_str())),
            Matcher::Plain {
                needle,
                case_sensitive: false,
                ..
            } => {
                let b = *needle.as_bytes().first()?;
                Some(Prefilter::Fold {
                    needle: needle.as_str(),
                    first: [b.to_ascii_lowercase(), b.to_ascii_uppercase()],
                })
            }
            Matcher::Re { .. } => None,
        }
    }

    fn maybe_match(&self, hay: &[u8]) -> bool {
        match self {
            Prefilter::Exact(n) => memchr::memmem::find(hay, n.as_bytes()).is_some(),
            Prefilter::Fold { needle, first } => {
                let pb = needle.as_bytes();
                let n = pb.len();
                if n == 0 || hay.len() < n {
                    return false;
                }
                let mut start = 0usize;
                while start + n <= hay.len() {
                    let Some(off) = memchr::memchr2(first[0], first[1], &hay[start..]) else {
                        return false;
                    };
                    let pos = start + off;
                    if pos + n > hay.len() {
                        return false;
                    }
                    if hay[pos..pos + n].eq_ignore_ascii_case(pb) {
                        return true;
                    }
                    start = pos + 1;
                }
                false
            }
        }
    }
}

/// 这个文件里还有可能有命中吗？没有就整块跳过，省掉逐行切分与匹配器调用。
fn file_may_match(matcher: &Matcher, prefilter: Option<&Prefilter<'_>>, text: &str) -> bool {
    match matcher {
        // 正则走整文件 `(?m)` 预判：一次 DFG/SIMD 扫描，比按行调 500 次 `find_iter` 便宜一个量级。
        Matcher::Re { file, lits, .. } => {
            if let Some(lits) = lits {
                if !lits
                    .iter()
                    .any(|l| memchr::memmem::find(text.as_bytes(), l).is_some())
                {
                    return false;
                }
            }
            match file {
                Some(f) => f.is_match(text),
                None => true,
            }
        }
        _ => match prefilter {
            Some(p) => p.maybe_match(text.as_bytes()),
            None => true,
        },
    }
}

/// 文件过滤：IDEA「File mask」风格——逗号分隔，`!` 前缀表示排除。
///
/// 为什么只做一个框而不是 VS Code 的 include / exclude 两个框：Eclipse 的
/// File name patterns 本来就是一个框，同事的心智模型就是「填个 `*.java`」；
/// 两个框最容易把内容填反。`!` 取反是 IDEA 在同一套心智上加的最省事的扩展。
///
/// 掩码在解析时**一次性翻译成正则**（`glob_to_regex`）。不用手写通配符回溯：
/// 带 `**/` 的模式（`src/**/*.java`）要求「当前段吃不下时回到上一个 `*` 继续吃」，
/// 单指针回溯只能记住最近一个星号，遇到路径里的 `/` 就误判失配。正则引擎天然
/// 处理这种回溯，且 `FileFilter` 在搜索期间是复用的，编译成本摊薄到一次。
struct FileFilter {
    include: Vec<Mask>,
    exclude: Vec<Mask>,
}

/// 一条掩码 + 它是「比路径」还是「比文件名」。
///
/// 这个布尔必须来自**原始模式**而不是翻译后的正则：`*.java` 翻出来是
/// `[^/]*\.java`，里面也带 `/`，按正则串判断会把文件名掩码误当路径掩码。
struct Mask {
    re: regex::Regex,
    on_path: bool,
}

impl Mask {
    fn hit(&self, rel_path: &str, file_name: &str) -> bool {
        self.re
            .is_match(if self.on_path { rel_path } else { file_name })
    }
}

impl FileFilter {
    fn parse(spec: &str) -> Self {
        let mut include = Vec::new();
        let mut exclude = Vec::new();
        for raw in spec.split(',') {
            let pat = raw.trim();
            if pat.is_empty() {
                continue;
            }
            let (target, text) = match pat.strip_prefix('!') {
                // 单独的 `!` 无意义，当普通模式处理（自然匹配不到东西）
                Some(rest) if !rest.trim().is_empty() => (&mut exclude, rest.trim()),
                _ => (&mut include, pat),
            };
            if let Some(mask) = glob_to_regex(text) {
                target.push(mask);
            }
        }
        FileFilter { include, exclude }
    }

    fn accepts(&self, rel_path: &str, file_name: &str) -> bool {
        if self.exclude.iter().any(|m| m.hit(rel_path, file_name)) {
            return false;
        }
        self.include.is_empty() || self.include.iter().any(|m| m.hit(rel_path, file_name))
    }
}

/// 把 glob 翻译成锚定的正则（大小写不敏感）。
///
/// - `*` → `[^/]*`（不跨目录），`**` → `.*`，`**/` → `(?:.*/)?`（可 0 层，
///   这样 `src/**/*.java` 既能命中 `src/A.java` 也能命中 `src/a/b/A.java`）
/// - `?` → `[^/]`
/// - 其余字符一律 `regex::escape`，避免 `.` `(` 之类被当语法
///
/// 带 `/` 的模式按整条相对路径匹配，否则只比文件名——用户不必为了跨目录写 `**/`。
fn glob_to_regex(pat: &str) -> Option<Mask> {
    let on_path = pat.contains('/');
    let chars: Vec<char> = pat.chars().collect();
    let mut out = String::from("(?i)^");
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    if i + 2 < chars.len() && chars[i + 2] == '/' {
                        out.push_str("(?:.*/)?");
                        i += 3;
                    } else {
                        out.push_str(".*");
                        i += 2;
                    }
                } else {
                    out.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' => {
                out.push_str("[^/]");
                i += 1;
            }
            c => {
                out.push_str(&regex::escape(&c.to_string()));
                i += 1;
            }
        }
    }
    out.push('$');
    regex::Regex::new(&out).ok().map(|re| Mask { re, on_path })
}

/// 在工作区内搜索 `opts.text`。
///
/// 分两段：先单线程走目录收集候选文件，再多线程读取并匹配。
///
/// 为什么必须并行：NC 工程 7000+ 个 Java/XML、约 70MB，而机械盘/杀毒软件环境下
/// **顺序读只有 70~80 文件/秒**（实测：1000 个文件 13s），一次全量要一分半，15 秒预算
/// 只能覆盖 1/8 的工作区，结果是「明明有这个词却搜不到」。八线程能把冷缓存吞吐提到
/// 370 文件/秒（5 倍），代价只是几次线程创建。
pub fn search(root: &Path, opts: &SearchOptions) -> Result<SearchOutcome, String> {
    search_with_budget(root, opts, TIME_BUDGET_MS)
}

/// 同 `search`，但由调用方给定总耗时预算（「全部工程」搜索要在各工程之间分预算）。
pub fn search_with_budget(
    root: &Path,
    opts: &SearchOptions,
    budget_ms: u128,
) -> Result<SearchOutcome, String> {
    search_cancellable(root, opts, budget_ms, &AtomicBool::new(false))
}

/// 同 `search_with_budget`，另带取消标志：枚举目录、逐文件读取前都会看它，
/// 置位后尽快停下并把 `cancelled` / `truncated` 置真。
///
/// 为什么要做：快速面板的 `#内容` 搜索每改一次词就发一次全量扫描，前端只是
/// 丢弃旧结果，旧扫描的 8 个线程还在抢磁盘，新请求被拖慢。
pub fn search_cancellable(
    root: &Path,
    opts: &SearchOptions,
    budget_ms: u128,
    cancel: &AtomicBool,
) -> Result<SearchOutcome, String> {
    let needle = if opts.regex {
        opts.text.as_str()
    } else {
        opts.text.trim()
    };
    if needle.trim().is_empty() {
        return Err("搜索词为空".to_string());
    }
    let matcher = Matcher::build(opts)?;
    let filter = FileFilter::parse(&opts.include);
    // 范围在收集候选之前定下来：候选一旦开始枚举，就没有「换个范围」的余地了
    let scope = plan_scope(root, &opts.dirs);

    let started = Instant::now();
    let limit = match opts.max_results {
        0 => HARD_MAX_RESULTS,
        n => n.min(HARD_MAX_RESULTS),
    };

    // ── 内容包就绪就直接走包：免掉「走树 + 8 千次 open」──
    // 包未就绪 / 属于别的工作区时回落磁盘路径（完整扫描，只是慢）；
    // `current_for` 顺带把「磁盘上有包但还没加载」的情况加载起来。
    if let Some(pack) = content_pack::current_for(root) {
        return Ok(search_pack(
            &pack, opts, &matcher, &filter, &scope, limit, started, budget_ms, cancel, None,
        ));
    }

    // 未保存内容：磁盘路径也要先用 overlay 覆盖，否则包还没建好的那几分钟里，
    // 「搜自己刚写的那行」会读到磁盘上的旧内容。
    let overlay: HashMap<String, &str> = overlay_docs(opts);

    // ── 第一段：收集候选（目录枚举也是 I/O，但只做一遍）──
    let (candidates, walk_truncated) =
        collect_candidates(root, &scope.abs, &filter, started, budget_ms, cancel);

    // ── 第二段：并行读取 + 匹配 ──
    let cursor = AtomicUsize::new(0);
    let scanned = AtomicUsize::new(0);
    // 「匹配文件数」不在这里数：截断之后要按真正留下的命中重算（见结果组装处），
    // 扫描期计数会把被上限整份砍掉的文件也算进去。
    let collected = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);

    // 文件少时线程开销反而更大，直接串行
    let threads = if candidates.len() < 64 {
        1
    } else {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(2, 8)
    };

    let mut panicked = false;
    let mut batches: Vec<Vec<SearchHit>> = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(threads);
        for _ in 0..threads {
            handles.push(scope.spawn(|| {
                let mut local: Vec<SearchHit> = Vec::new();
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    if cancel.load(Ordering::Relaxed) {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    let idx = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some((path, rel)) = candidates.get(idx) else {
                        break;
                    };
                    if started.elapsed().as_millis() > budget_ms {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    let room = limit.saturating_sub(collected.load(Ordering::Relaxed));
                    if room == 0 {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }

                    let before = local.len();
                    let was_text = scan_candidate(path, rel, &overlay, &matcher, room, &mut local);
                    if was_text {
                        scanned.fetch_add(1, Ordering::Relaxed);
                    }
                    let added = local.len() - before;
                    if added > 0 && collected.fetch_add(added, Ordering::Relaxed) + added >= limit {
                        stop.store(true, Ordering::Relaxed);
                    }
                }
                local
            }));
        }
        handles
            .into_iter()
            .map(|h| {
                // worker panic（bug 或 OOM）不能吞成「成功」：它扫过的那批文件
                // 会从结果里凭空消失，却报告搜索完成。至少让 truncated 说实话
                h.join().unwrap_or_else(|_| {
                    panicked = true;
                    Vec::new()
                })
            })
            .collect()
    });

    // 合并后排序：并行读取完成顺序不定，按 (路径, 行号) 固定下来，
    // 同一份代码反复搜才不会每次结果顺序都不一样。
    let mut hits: Vec<SearchHit> = Vec::new();
    for batch in batches.iter_mut() {
        hits.append(batch);
    }
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));

    let capped = hits.len() > limit;
    hits.truncate(limit);
    // 截断后按实际留下的命中重算「匹配文件数」：扫描时统计的 matched 包含被 500 条
    // 上限整份砍掉的文件，汇总行那个「M 个文件」就会和下面能点开的分组对不上。
    let files_matched = {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for h in &hits {
            seen.insert(h.path.as_str());
        }
        seen.len()
    };

    Ok(SearchOutcome {
        hits,
        files_scanned: scanned.load(Ordering::Relaxed),
        files_matched,
        truncated: capped
            || stop.load(Ordering::Relaxed)
            || walk_truncated
            || panicked
            || cancel.load(Ordering::Relaxed),
        elapsed_ms: started.elapsed().as_millis() as u64,
        scope_dirs: scope.rel,
        missing_dirs: scope.missing,
        scope_fallback: scope.fallback,
        cancelled: cancel.load(Ordering::Relaxed),
    })
}

/// 流式搜索时每次推给前端的条数。太小会把 IPC 打满，太大则第一批出现得晚。
const STREAM_BATCH: usize = 16;
/// 候选队列上限：生产者走得比 worker 快时压住内存，满了就等一等（不丢候选）。
const FEED_CAP: usize = 4096;

/// 流式结果回调。包路径只在最后推一次，磁盘路径按批推。
type HitSink<'a> = &'a (dyn Fn(&[SearchHit]) + Sync);

/// 生产者 / 消费者之间的候选队列。
struct Feed {
    state: Mutex<FeedState>,
    cv: Condvar,
}

struct FeedState {
    queue: VecDeque<(PathBuf, String)>,
    /// 目录已经走完，不再有新候选。
    done: bool,
    /// 提前停（命中到上限 / 取消 / 超时）。
    stop: bool,
}

/// 走目录这一侧需要的全部输入。参数一多 clippy 会拦，打包成一个结构。
struct Walk<'a> {
    feed: &'a Feed,
    root: &'a Path,
    dirs: &'a [PathBuf],
    filter: &'a FileFilter,
    started: Instant,
    budget_ms: u128,
    cancel: &'a AtomicBool,
    stop: &'a AtomicBool,
    /// 已经在优先阶段扫过的文件（小写相对路径）：走目录时不要再扫第二遍。
    skip: &'a HashSet<String>,
}

/// 流式搜索：边扫边把新命中交给 `sink`，返回值与 [`search_cancellable`] 同口径。
///
/// 与一次性搜索的两处差别，都是为了「面板上一敲键就能看到东西」：
///
/// 1. **目录枚举与文件读取重叠**。以前先把整棵树走完（newar 上实测 1~3 秒）才开始
///    读第一个文件，用户看到的是「列表一直空着」；现在生产者线程边走边投喂，worker
///    立刻开读，命中到 `max_results` 就整体停下，不必等走完。
/// 2. **`options.priority` 里的文件先扫**（调用方传最近打开的那些）。第一条命中
///    通常几十毫秒内就能出现。
///
/// 结果集与一次性搜索完全一致：流式只改变「看到结果的节奏」，`hits` 仍按
/// (路径, 行号) 排序，条数上限、时间预算、取消语义也都相同。
pub fn search_stream(
    root: &Path,
    opts: &SearchOptions,
    budget_ms: u128,
    cancel: &AtomicBool,
    sink: &(dyn Fn(&[SearchHit]) + Sync),
) -> Result<SearchOutcome, String> {
    let needle = if opts.regex {
        opts.text.as_str()
    } else {
        opts.text.trim()
    };
    if needle.trim().is_empty() {
        return Err("搜索词为空".to_string());
    }
    let matcher = Matcher::build(opts)?;
    let filter = FileFilter::parse(&opts.include);
    let scope = plan_scope(root, &opts.dirs);

    let started = Instant::now();
    let limit = match opts.max_results {
        0 => HARD_MAX_RESULTS,
        n => n.min(HARD_MAX_RESULTS),
    };

    // 包就绪时不必「边扫边推」：整次查询只有几十毫秒，一次性把结果推过去即可。
    // 仍然调 sink 是给前端保持「同一套事件流」的心智模型（最终结果仍以返回值为准）。
    if let Some(pack) = content_pack::current_for(root) {
        return Ok(search_pack(
            &pack,
            opts,
            &matcher,
            &filter,
            &scope,
            limit,
            started,
            budget_ms,
            cancel,
            Some(sink),
        ));
    }

    let overlay: HashMap<String, &str> = overlay_docs(opts);

    let scanned = AtomicUsize::new(0);
    let collected = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let mut hits: Vec<SearchHit> = Vec::new();

    // ── 优先文件：最近打开的那些先来，让第一条结果几乎立刻可见 ──
    // 记下扫过谁：等下走目录时不能再扫一遍，否则同一行会出现两条。
    let mut scanned_first: HashSet<String> = HashSet::new();
    for rel in &opts.priority {
        if stop.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
            break;
        }
        let Some(rel) = normalize_rel_dir(rel) else {
            continue;
        };
        if !scanned_first.insert(rel.to_ascii_lowercase()) {
            continue;
        }
        let path = root.join(&rel);
        if !accept_candidate(&path, &rel, &filter) {
            continue;
        }
        let room = limit.saturating_sub(collected.load(Ordering::Relaxed));
        if room == 0 {
            break;
        }
        let before = hits.len();
        if scan_candidate(&path, &rel, &overlay, &matcher, room, &mut hits) {
            scanned.fetch_add(1, Ordering::Relaxed);
        }
        let added = hits.len() - before;
        if added > 0 {
            sink(&hits[before..]);
            if collected.fetch_add(added, Ordering::Relaxed) + added >= limit {
                stop.store(true, Ordering::Relaxed);
            }
        }
    }

    // ── 其余文件：生产者走目录、worker 并行读，两边同时跑 ──
    let feed = Feed {
        state: Mutex::new(FeedState {
            queue: VecDeque::new(),
            done: false,
            stop: false,
        }),
        cv: Condvar::new(),
    };
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);

    let mut panicked = false;
    let (mut batches, walk_truncated) = std::thread::scope(|sc| {
        let walker = Walk {
            feed: &feed,
            root,
            dirs: &scope.abs,
            filter: &filter,
            started,
            budget_ms,
            cancel,
            stop: &stop,
            skip: &scanned_first,
        };
        let producer = sc.spawn(move || feed_candidates(&walker));
        let mut handles = Vec::with_capacity(threads);
        for _ in 0..threads {
            handles.push(sc.spawn(|| {
                let mut local: Vec<SearchHit> = Vec::new();
                // 攒够一小批再推：每命中一行就 emit 一次会把 IPC 打满
                let mut pending: Vec<SearchHit> = Vec::new();
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    if cancel.load(Ordering::Relaxed) {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    let Some((path, rel)) = next_candidate(&feed, &stop) else {
                        break;
                    };
                    if started.elapsed().as_millis() > budget_ms {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    let room = limit.saturating_sub(collected.load(Ordering::Relaxed));
                    if room == 0 {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    let before = local.len();
                    let was_text =
                        scan_candidate(&path, &rel, &overlay, &matcher, room, &mut local);
                    if was_text {
                        scanned.fetch_add(1, Ordering::Relaxed);
                    }
                    let added = local.len() - before;
                    if added > 0 {
                        // 这一批先给前端看，最终结果仍按下标排好再返回
                        pending.extend(local[before..].iter().cloned());
                        if collected.fetch_add(added, Ordering::Relaxed) + added >= limit {
                            stop.store(true, Ordering::Relaxed);
                        }
                    }
                    if pending.len() >= STREAM_BATCH {
                        sink(&pending);
                        pending.clear();
                    }
                }
                if !pending.is_empty() {
                    sink(&pending);
                }
                local
            }));
        }
        let walk_truncated = producer.join().unwrap_or(true);
        let batches: Vec<Vec<SearchHit>> = handles
            .into_iter()
            .map(|h| {
                h.join().unwrap_or_else(|_| {
                    panicked = true;
                    Vec::new()
                })
            })
            .collect();
        (batches, walk_truncated)
    });

    for batch in batches.iter_mut() {
        hits.append(batch);
    }
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    let capped = hits.len() > limit;
    hits.truncate(limit);
    let files_matched = {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for h in &hits {
            seen.insert(h.path.as_str());
        }
        seen.len()
    };

    Ok(SearchOutcome {
        hits,
        files_scanned: scanned.load(Ordering::Relaxed),
        files_matched,
        truncated: capped
            || stop.load(Ordering::Relaxed)
            || walk_truncated
            || panicked
            || cancel.load(Ordering::Relaxed),
        elapsed_ms: started.elapsed().as_millis() as u64,
        scope_dirs: scope.rel,
        missing_dirs: scope.missing,
        scope_fallback: scope.fallback,
        cancelled: cancel.load(Ordering::Relaxed),
    })
}

/// 取一个候选；队列空且生产者已收工时返回 `None`。
fn next_candidate(feed: &Feed, stop: &AtomicBool) -> Option<(PathBuf, String)> {
    let mut guard = feed.state.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if guard.stop || stop.load(Ordering::Relaxed) {
            return None;
        }
        if let Some(item) = guard.queue.pop_front() {
            // 空出一个位置要叫醒可能正在等的生产者
            drop(guard);
            feed.cv.notify_one();
            return Some(item);
        }
        if guard.done {
            return None;
        }
        guard = feed
            .cv
            .wait_timeout(guard, Duration::from_millis(50))
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}

/// 走目录、把候选投进队列。返回是否因预算 / 取消提前结束。
fn feed_candidates(walk: &Walk) -> bool {
    let feed = walk.feed;
    let mut stack: Vec<PathBuf> = if walk.dirs.is_empty() {
        vec![walk.root.to_path_buf()]
    } else {
        walk.dirs.to_vec()
    };
    let mut truncated = false;
    'walk: while let Some(dir) = stack.pop() {
        if walk.started.elapsed().as_millis() > walk.budget_ms
            || walk.cancel.load(Ordering::Relaxed)
            || walk.stop.load(Ordering::Relaxed)
        {
            truncated = true;
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let path = entry.path();
            let rel = relative_slash(walk.root, &path);
            if walk.skip.contains(&rel.to_ascii_lowercase()) {
                continue;
            }
            if !accept_candidate(&path, &rel, walk.filter) {
                continue;
            }
            if !push_candidate(
                feed,
                &walk.started,
                walk.budget_ms,
                walk.cancel,
                walk.stop,
                path,
                rel,
            ) {
                truncated = true;
                break 'walk;
            }
        }
    }

    let mut guard = feed.state.lock().unwrap_or_else(|e| e.into_inner());
    guard.done = true;
    drop(guard);
    feed.cv.notify_all();
    truncated
}

/// 投递一个候选；队列满时等 worker 消化。返回 `false` 表示该停了。
fn push_candidate(
    feed: &Feed,
    started: &Instant,
    budget_ms: u128,
    cancel: &AtomicBool,
    stop: &AtomicBool,
    path: PathBuf,
    rel: String,
) -> bool {
    let mut guard = feed.state.lock().unwrap_or_else(|e| e.into_inner());
    while guard.queue.len() >= FEED_CAP {
        if guard.stop || stop.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
            return false;
        }
        if started.elapsed().as_millis() > budget_ms {
            return false;
        }
        guard = feed
            .cv
            .wait_timeout(guard, Duration::from_millis(20))
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
    if guard.stop || stop.load(Ordering::Relaxed) {
        return false;
    }
    guard.queue.push_back((path, rel));
    drop(guard);
    feed.cv.notify_one();
    true
}

/// 候选准入：掩码、二进制扩展名、大小。枚举与投喂两侧共用同一套判断。
fn accept_candidate(path: &Path, rel: &str, filter: &FileFilter) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if name.is_empty() || !filter.accepts(rel, &name) || has_binary_ext(&name) {
        return false;
    }
    std::fs::metadata(path).is_ok_and(|md| md.is_file() && md.len() <= MAX_SEARCH_BYTES)
}

/// 走一遍工作区，返回通过掩码、大小合适的候选文件 `(绝对路径, 相对路径)`。
///
/// `dirs` 是收窄后的范围（绝对路径）；空表示整个工作区。多入口时每个入口各走一遍，
/// 但 `rel` 一律相对**工作区根**算——结果路径的口径不能因为范围变窄而变。
///
/// 掩码判断放在读文件之前：7000 个文件里通常只需要读几百个，
/// 先判掩码比先读再丢快一个量级。返回值第二项表示是否因为时间预算中途放弃。
fn collect_candidates(
    root: &Path,
    dirs: &[PathBuf],
    filter: &FileFilter,
    started: Instant,
    budget_ms: u128,
    cancel: &AtomicBool,
) -> (Vec<(PathBuf, String)>, bool) {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = if dirs.is_empty() {
        vec![root.to_path_buf()]
    } else {
        dirs.to_vec()
    };

    while let Some(dir) = stack.pop() {
        if started.elapsed().as_millis() > budget_ms || cancel.load(Ordering::Relaxed) {
            return (out, true);
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            // file_type() 不跟随符号链接：NC 工程里有同事建的软链，跟进去可能成环。
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();

            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }

            let path = entry.path();
            let rel = relative_slash(root, &path);
            if !filter.accepts(&rel, &name) {
                continue;
            }
            // 扩展名就能定的二进制不要打开（见 SKIP_EXTS：本地一半候选是 .class）
            if has_binary_ext(&name) {
                continue;
            }
            let Ok(md) = entry.metadata() else { continue };
            if md.len() > MAX_SEARCH_BYTES {
                continue;
            }
            out.push((path, rel));
        }
    }
    (out, false)
}

/// 建内容包时要收录的文件（与内容搜索同一套跳过规则）。
pub struct PackSource {
    pub path: PathBuf,
    /// 工作区相对、`/` 分隔。
    pub rel: String,
    pub size: u64,
    /// 毫秒时间戳，增量建包的判据。
    pub mtime: u64,
}

/// 走一遍工作区，收集「会被内容搜索读到」的文件及其 size/mtime。
///
/// 跳过规则必须与 [`collect_candidates`] 完全一致（目录、二进制扩展名、4 MB 上限），
/// 否则包里会多出搜索根本不会读的文件，或者少掉本该能搜到的文件。
/// 这里刻意**不**套用范围与掩码：包是整工作区的快照，范围在查询时按相对路径过滤，
/// 否则换个组件搜就得重新建包。
pub fn pack_sources(root: &Path, cancel: &AtomicBool) -> Vec<PackSource> {
    let mut out: Vec<PackSource> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
                continue;
            }
            if !ft.is_file() || has_binary_ext(&name) {
                continue;
            }
            let Ok(md) = entry.metadata() else { continue };
            if md.len() > MAX_SEARCH_BYTES {
                continue;
            }
            let path = entry.path();
            out.push(PackSource {
                rel: relative_slash(root, &path),
                size: md.len(),
                mtime: mtime_ms(&md),
                path,
            });
        }
    }
    // 排序：块划分与增量复用都按这个顺序对齐
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 文件是否落在本次生效范围内（范围是工作区相对的目录）。
fn in_scope(scope: &Scope, rel: &str) -> bool {
    if scope.rel.is_empty() {
        return true;
    }
    scope.rel.iter().any(|d| {
        // 逐字节前缀比较，但要先保证切在字符边界上（`get` 会挡住非边界切片）
        rel.get(..d.len())
            .map(|p| p.eq_ignore_ascii_case(d))
            .unwrap_or(false)
            && rel.as_bytes().get(d.len()) == Some(&b'/')
    })
}

fn file_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// 用内容包搜。首次与再次搜索都走这条路，磁盘路径只在包未就绪时兜底。
///
/// 与磁盘路径的差别只有「候选与正文从哪来」：范围、掩码、条数上限、排序、切行与
/// 高亮口径全部复用同一份 [`scan_text`]，所以两条路的结果逐条相同。
///
/// 并行粒度是**块**（1 MB 未压缩）：每块解压一次，块内按 `files[]` 切片，命中才切行。
/// `priority` 在包路径上没有意义（没有逐文件 I/O 的顺序问题），忽略。
#[allow(clippy::too_many_arguments)]
fn search_pack(
    pack: &content_pack::Pack,
    opts: &SearchOptions,
    matcher: &Matcher,
    filter: &FileFilter,
    scope: &Scope,
    limit: usize,
    started: Instant,
    budget_ms: u128,
    cancel: &AtomicBool,
    sink: Option<HitSink<'_>>,
) -> SearchOutcome {
    let mut hits: Vec<SearchHit> = Vec::new();
    let scanned = AtomicUsize::new(0);
    let collected = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let chunk_failed = AtomicBool::new(false);

    // ── overlay：未保存内容先扫，并从包里跳过这些路径（否则同一行会出现两次，且一次是旧的）──
    let overlay: HashMap<String, &str> = opts
        .overlay
        .iter()
        .filter_map(|d| normalize_rel_dir(&d.path).map(|p| (p, d.text.as_str())))
        .collect();
    for (rel, text) in &overlay {
        if stop.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
            break;
        }
        if !in_scope(scope, rel) || !filter.accepts(rel, file_name(rel)) {
            continue;
        }
        let room = limit.saturating_sub(collected.load(Ordering::Relaxed));
        if room == 0 {
            break;
        }
        let before = hits.len();
        scan_text(rel, text, matcher, room, &mut hits);
        scanned.fetch_add(1, Ordering::Relaxed);
        let added = hits.len() - before;
        if added > 0 && collected.fetch_add(added, Ordering::Relaxed) + added >= limit {
            stop.store(true, Ordering::Relaxed);
        }
    }

    // ── 分块候选：只保留通过范围/掩码、且不在 overlay 里的文件 ──
    let table = pack.table();
    let mut per_chunk: Vec<Vec<&content_pack::FileMeta>> = vec![Vec::new(); table.chunks.len()];
    for f in &table.files {
        if overlay.contains_key(&f.path) || !in_scope(scope, &f.path) {
            continue;
        }
        if !filter.accepts(&f.path, file_name(&f.path)) {
            continue;
        }
        if let Some(slot) = per_chunk.get_mut(f.chunk as usize) {
            slot.push(f);
        }
    }
    let work: Vec<(usize, &Vec<&content_pack::FileMeta>)> = per_chunk
        .iter()
        .enumerate()
        .filter(|(_, v)| !v.is_empty())
        .collect();

    let threads = work.len().clamp(1, 8);
    let cursor = AtomicUsize::new(0);
    let prefilter = Prefilter::of(matcher);

    let mut panicked = false;
    let mut batches: Vec<Vec<SearchHit>> = std::thread::scope(|sc| {
        let mut handles = Vec::with_capacity(threads);
        for _ in 0..threads {
            handles.push(sc.spawn(|| {
                let mut local: Vec<SearchHit> = Vec::new();
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    if cancel.load(Ordering::Relaxed) {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    if started.elapsed().as_millis() > budget_ms {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    let idx = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some((chunk_idx, files)) = work.get(idx) else {
                        break;
                    };
                    let Some(bytes) = pack.chunk(*chunk_idx) else {
                        // 解压失败：不能当成「这些文件没有命中」，否则会静默漏结果
                        chunk_failed.store(true, Ordering::Relaxed);
                        continue;
                    };
                    let Ok(text) = std::str::from_utf8(bytes) else {
                        chunk_failed.store(true, Ordering::Relaxed);
                        continue;
                    };
                    for f in files.iter() {
                        if stop.load(Ordering::Relaxed) {
                            break;
                        }
                        let room = limit.saturating_sub(collected.load(Ordering::Relaxed));
                        if room == 0 {
                            stop.store(true, Ordering::Relaxed);
                            break;
                        }
                        let start = f.off as usize;
                        let Some(slice) = text.get(start..start + f.len as usize) else {
                            continue;
                        };
                        scanned.fetch_add(1, Ordering::Relaxed);
                        if !file_may_match(matcher, prefilter.as_ref(), slice) {
                            continue;
                        }
                        let before = local.len();
                        scan_text(&f.path, slice, matcher, room, &mut local);
                        let added = local.len() - before;
                        if added > 0
                            && collected.fetch_add(added, Ordering::Relaxed) + added >= limit
                        {
                            stop.store(true, Ordering::Relaxed);
                        }
                    }
                }
                local
            }));
        }
        handles
            .into_iter()
            .map(|h| {
                h.join().unwrap_or_else(|_| {
                    panicked = true;
                    Vec::new()
                })
            })
            .collect()
    });

    for batch in batches.iter_mut() {
        hits.append(batch);
    }
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    let capped = hits.len() > limit;
    hits.truncate(limit);
    let files_matched = {
        let mut seen: HashSet<&str> = HashSet::new();
        for h in &hits {
            seen.insert(h.path.as_str());
        }
        seen.len()
    };

    if let Some(sink) = sink {
        if !hits.is_empty() {
            sink(&hits);
        }
    }

    SearchOutcome {
        hits,
        files_scanned: scanned.load(Ordering::Relaxed),
        files_matched,
        truncated: capped
            || stop.load(Ordering::Relaxed)
            || panicked
            || chunk_failed.load(Ordering::Relaxed)
            || cancel.load(Ordering::Relaxed),
        elapsed_ms: started.elapsed().as_millis() as u64,
        scope_dirs: scope.rel.clone(),
        missing_dirs: scope.missing.clone(),
        scope_fallback: scope.fallback,
        cancelled: cancel.load(Ordering::Relaxed),
    }
}

/// 「转到文件」用的文件名清单上限。newar 全量约一万六，留足余量；超了说明选错了目录。
const LIST_FILES_CAP: usize = 200_000;

/// 列出工作区里所有「可能想打开」的文件：相对根、`/` 分隔、按字典序。
///
/// 目录与扩展名的跳过规则和全文搜索一致（`.svn` / `.git` / `node_modules`、必然是二进制的扩展名），
/// 只看目录项不读内容。返回的第二项表示是否因为时间预算 / 条数上限中途放弃。
pub fn list_files(root: &Path) -> (Vec<String>, bool) {
    let started = Instant::now();
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut truncated = false;
    while let Some(dir) = stack.pop() {
        if started.elapsed().as_millis() > TIME_BUDGET_MS || out.len() >= LIST_FILES_CAP {
            truncated = true;
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            // 不跟随符号链接，理由同 collect_candidates
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            } else if ft.is_file() && !has_binary_ext(&name) {
                out.push(relative_slash(root, &entry.path()));
            }
        }
    }
    out.sort_unstable();
    (out, truncated)
}

// ───────────────────── 文件清单缓存 ─────────────────────
//
// 「转到文件」每次打开面板都要一份完整文件名清单。全树 1.7 万个文件读一遍目录项在
// 机械盘/杀毒环境下要 1~3 秒，而这棵树半分钟内基本不会变——把它当成「每次按键都要
// 重算」是纯浪费，用户看到的就是输入框里一直转「查询中…」。
//
// 三层：进程内 60 秒直接返回 → 磁盘缓存（重启后仍然有效）→ 真扫。过期不阻塞：
// 先把手上的旧清单给出去，后台再校准一次（stale-while-revalidate）。文件树的新建 /
// 改名 / 删除由前端 `invalidateFileIndex` 触发一次强制重扫，不需要靠 TTL 保证实时。

/// 进程内清单的有效期。这段时间内连目录都不读。
const LIST_SOFT_TTL: Duration = Duration::from_secs(60);
/// 磁盘清单的有效期：覆盖「重启应用」这个最常见的冷启动场景。
const LIST_DISK_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// 磁盘缓存版式。格式改了要加一，旧文件自然失效。
const LIST_CACHE_VERSION: &str = "v1";

struct ListCache {
    root: String,
    at: Instant,
    files: Vec<String>,
    truncated: bool,
}

static LIST_CACHE: Mutex<Option<ListCache>> = Mutex::new(None);
/// 后台校准的单飞标志：连续打开面板不要排一队全量扫描。
static LIST_REFRESHING: AtomicBool = AtomicBool::new(false);

/// 带缓存的 [`list_files`]，供「转到文件」用。
///
/// `cache_dir` 是应用的配置目录（`{config_dir}`）；缓存文件放在其下的 `file-index/`。
/// 除非真的一个缓存都没有，否则**不会**让调用方等全树扫描。
pub fn list_files_cached(root: &Path, cache_dir: &Path) -> (Vec<String>, bool) {
    let key = norm_root(root);
    if let Some((files, truncated, fresh)) = list_memory_hit(&key) {
        if !fresh {
            spawn_list_refresh(root.to_path_buf(), cache_dir.to_path_buf());
        }
        return (files, truncated);
    }
    let cache_path = list_cache_path(cache_dir, &key);
    if let Some((files, truncated)) = read_list_cache(&cache_path, &key) {
        // 磁盘那份是上次退出前扫的：先给用户，后台校准
        store_list_memory(&key, &files, truncated);
        spawn_list_refresh(root.to_path_buf(), cache_dir.to_path_buf());
        return (files, truncated);
    }
    let (files, truncated) = list_files(root);
    store_list_memory(&key, &files, truncated);
    write_list_cache(&cache_path, &key, &files, truncated);
    (files, truncated)
}

/// 丢掉缓存（前端在文件树里新建 / 改名 / 删除后调用，让下一次取清单重新扫）。
pub fn invalidate_list_cache() {
    *LIST_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn list_memory_hit(key: &str) -> Option<(Vec<String>, bool, bool)> {
    let guard = LIST_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let c = guard.as_ref()?;
    if c.root != key {
        return None;
    }
    let fresh = c.at.elapsed() < LIST_SOFT_TTL;
    Some((c.files.clone(), c.truncated, fresh))
}

fn store_list_memory(key: &str, files: &[String], truncated: bool) {
    *LIST_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(ListCache {
        root: key.to_string(),
        at: Instant::now(),
        files: files.to_vec(),
        truncated,
    });
}

/// 后台重扫一次清单。单飞：已经有一个在跑就不再起。
fn spawn_list_refresh(root: PathBuf, cache_dir: PathBuf) {
    if LIST_REFRESHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        // panic 也要把标志放掉，否则这一进程内再也不会刷新（比崩溃更难查）
        struct Release;
        impl Drop for Release {
            fn drop(&mut self) {
                LIST_REFRESHING.store(false, Ordering::SeqCst);
            }
        }
        let _release = Release;
        let key = norm_root(&root);
        let (files, truncated) = list_files(&root);
        write_list_cache(&list_cache_path(&cache_dir, &key), &key, &files, truncated);
        store_list_memory(&key, &files, truncated);
    });
}

fn norm_root(root: &Path) -> String {
    root.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn list_cache_path(cache_dir: &Path, key: &str) -> PathBuf {
    cache_dir
        .join("file-index")
        .join(format!("{:016x}.lst", fnv(key)))
}

/// 磁盘清单格式：四行头部（版式 / 根 / 截断标志 / 条数）+ 每行一个相对路径。
///
/// 不用 JSON：8144 条路径的 JSON 要解析 10ms 级，纯按行切分是微秒级，且人眼可核对。
fn read_list_cache(path: &Path, key: &str) -> Option<(Vec<String>, bool)> {
    let md = std::fs::metadata(path).ok()?;
    let old = md.modified().ok()?.elapsed().unwrap_or_default();
    if old > LIST_DISK_TTL {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    if lines.next()? != LIST_CACHE_VERSION || lines.next()? != key {
        return None;
    }
    let truncated = lines.next()? == "1";
    let count: usize = lines.next()?.parse().ok()?;
    let files: Vec<String> = lines.map(str::to_string).collect();
    // 条数对不上说明文件被截断（上次写到一半被杀），宁可重扫
    (files.len() == count).then_some((files, truncated))
}

fn write_list_cache(path: &Path, key: &str, files: &[String], truncated: bool) {
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let mut out = String::with_capacity(files.iter().map(|f| f.len() + 1).sum::<usize>() + 64);
    out.push_str(LIST_CACHE_VERSION);
    out.push('\n');
    out.push_str(key);
    out.push('\n');
    out.push_str(if truncated { "1" } else { "0" });
    out.push('\n');
    out.push_str(&files.len().to_string());
    out.push('\n');
    for f in files {
        out.push_str(f);
        out.push('\n');
    }
    let temp = path.with_extension("lst.tmp");
    if std::fs::write(&temp, out).is_ok() && std::fs::rename(&temp, path).is_err() {
        let _ = std::fs::remove_file(&temp);
    }
}

/// FNV-1a：缓存文件名要跨进程稳定，不能依赖 `DefaultHasher`。
fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// 扩展名是否属于「必然是二进制」的那一类。
fn has_binary_ext(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((_, ext)) => SKIP_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// 扫描单个文件，命中追加进 `out`（最多 `room` 条）。
///
/// 返回是否把它当作文本读过——二进制探测和读取失败都不算「扫过」，
/// 这样界面上「扫描 N 个文件」指的是真正比过的文件数。
/// 扫一个候选：未保存内容优先，其余读磁盘。
///
/// 返回是否真的按文本处理过（二进制/读失败算「没扫」，与 `scan_file` 同口径）。
fn scan_candidate(
    path: &Path,
    rel: &str,
    overlay: &HashMap<String, &str>,
    matcher: &Matcher,
    room: usize,
    out: &mut Vec<SearchHit>,
) -> bool {
    match overlay.get(rel) {
        Some(text) => {
            scan_text(rel, text, matcher, room, out);
            true
        }
        // 预筛是每次搜索同一份（只是借 matcher 里的字面量），这里就地建一次即可，
        // 不用把参数穿过 Walk / 优先文件那两层。
        None => scan_file(
            path,
            rel,
            matcher,
            Prefilter::of(matcher).as_ref(),
            room,
            out,
        ),
    }
}

/// 把前端传来的未保存文档归一成「工作区相对路径 → 文本」。
fn overlay_docs(opts: &SearchOptions) -> HashMap<String, &str> {
    opts.overlay
        .iter()
        .filter_map(|d| normalize_rel_dir(&d.path).map(|p| (p, d.text.as_str())))
        .collect()
}

fn scan_file(
    path: &Path,
    rel: &str,
    matcher: &Matcher,
    prefilter: Option<&Prefilter<'_>>,
    room: usize,
    out: &mut Vec<SearchHit>,
) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    // 二进制探测：前 8KB 里出现 NUL 就跳过（.class / .jar / 图片都会被挡住）。
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return false;
    }
    let text = workspace::decode_lossy(&bytes);
    if !file_may_match(matcher, prefilter, &text) {
        return true;
    }
    scan_text(rel, &text, matcher, room, out);
    true
}

/// 在一份已经解码好的文本里找出命中行。
///
/// 磁盘路径（`scan_file`）与内容包路径共用这一份：切行口径、`MAX_LINE_CHARS` 截断、
/// UTF-16 区间换算必须完全一致，否则「同样的关键词在两条路上结果不同」。
fn scan_text(rel: &str, text: &str, matcher: &Matcher, room: usize, out: &mut Vec<SearchHit>) {
    let before = out.len();
    for (idx, line_text) in text.split('\n').enumerate() {
        if out.len() - before >= room {
            break;
        }
        let spans = matcher.spans(line_text, MAX_RANGES_PER_LINE);
        if spans.is_empty() {
            continue;
        }
        let (clipped, ranges) = clip_with_ranges(line_text, &spans);
        out.push(SearchHit {
            path: rel.to_string(),
            line: (idx + 1) as u32,
            text: clipped,
            ranges,
        });
    }
}

/// 纯文本模式的所有命中位置（字节偏移）。
///
/// 忽略大小写用字节级 `eq_ignore_ascii_case`：`to_lowercase()` 会为每个文件多分配
/// 一份字符串，7000 个文件下这点开销会累积。非 ASCII 字节按原样比较，所以中文
/// 关键字等价于普通包含（Java 里 `凭证` 没有大小写之分）。
fn plain_spans(
    line: &str,
    needle: &str,
    case_sensitive: bool,
    whole_word: bool,
    cap: usize,
) -> Vec<(usize, usize)> {
    let hb = line.as_bytes();
    let pb = needle.as_bytes();
    let mut out = Vec::new();
    if pb.is_empty() || pb.len() > hb.len() {
        return out;
    }
    let mut i = 0usize;
    while i + pb.len() <= hb.len() && out.len() < cap {
        let hit = if case_sensitive {
            &hb[i..i + pb.len()] == pb
        } else {
            hb[i..i + pb.len()].eq_ignore_ascii_case(pb)
        };
        if hit {
            let end = i + pb.len();
            // 整词：两侧都不能是标识符字符。非 ASCII 字节（中文）恒算边界，
            // 所以「中文关键字的整词匹配」等于普通包含。
            let left_ok = !whole_word || i == 0 || !is_word_byte(hb[i - 1]);
            let right_ok = !whole_word || end == hb.len() || !is_word_byte(hb[end]);
            if left_ok && right_ok {
                out.push((i, end));
                i = end; // 命中之间不重叠（`aa` 在 `aaaa` 里算两处，不是三处）
                continue;
            }
        }
        i += 1;
    }
    out
}

/// 标识符字符：ASCII 字母数字、`_`、`$`。
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// 按字符截断过长的行，同时把命中区间映射到截断后文本的 UTF-16 偏移。
fn clip_with_ranges(line: &str, spans: &[(usize, usize)]) -> (String, Vec<MatchRange>) {
    let trimmed = line.trim_end_matches('\r');
    let mut out = String::new();
    let mut cut = trimmed.len();
    for (chars, (idx, ch)) in trimmed.char_indices().enumerate() {
        if chars >= MAX_LINE_CHARS {
            cut = idx;
            break;
        }
        out.push(ch);
    }
    if cut < trimmed.len() {
        out.push('…');
    }

    let mut ranges = Vec::new();
    for &(s, e) in spans {
        if e <= s || s >= cut {
            continue;
        }
        let end = e.min(cut);
        let start16 = trimmed[..s].encode_utf16().count() as u32;
        let end16 = trimmed[..end].encode_utf16().count() as u32;
        if end16 > start16 {
            ranges.push(MatchRange {
                start: start16,
                end: end16,
            });
        }
    }
    (out, ranges)
}

/// 转成相对工作区根、`/` 分隔的路径；不在根下时退回全路径。
fn relative_slash(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(text: &str) -> SearchOptions {
        SearchOptions {
            text: text.to_string(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
            include: String::new(),
            dirs: Vec::new(),
            max_results: 0,
            priority: Vec::new(),
            overlay: Vec::new(),
        }
    }

    /// 带范围目录的选项（按业务组件搜索）。
    fn opts_in(text: &str, dirs: &[&str]) -> SearchOptions {
        SearchOptions {
            dirs: dirs.iter().map(|d| d.to_string()).collect(),
            ..opts(text)
        }
    }

    /// 文件级预筛是**必要条件**：逐行能命中的，整文件预筛绝不能判否。
    /// 尤其要守住「默认忽略大小写」与「整词」两档——以前只有区分大小写有预筛，
    /// 默认档全量扫 74MB 要 337ms。
    #[test]
    fn 预筛不漏命中() {
        let hay = "// 凭证查询\nclass BillQueryServiceImpl {\n  String VOUCHER = \"凭证\";\n  int x$y = 1;\n}\n";
        let cases = [
            ("凭证", false, false),
            ("凭证", true, false),
            ("billquery", false, false),
            ("billquery", true, false),
            ("BILLQUERY", false, true),
            ("voucher", false, false),
            ("x$y", true, false),
        ];
        for (needle, cs, ww) in cases {
            let o = SearchOptions {
                case_sensitive: cs,
                whole_word: ww,
                ..opts(needle)
            };
            let m = Matcher::build(&o).unwrap();
            let pf = Prefilter::of(&m).expect("纯文本必须有预筛");
            let line_hit = hay.split('\n').any(|l| !m.spans(l, 8).is_empty());
            if line_hit {
                assert!(
                    pf.maybe_match(hay.as_bytes()),
                    "{needle} (cs={cs}, ww={ww}) 逐行有命中却被预筛否决"
                );
            }
        }
        // 预筛真的能干活：无关词必须被挡在逐行扫描之前
        let m = Matcher::build(&opts("zzzznotexist")).unwrap();
        assert!(!Prefilter::of(&m).unwrap().maybe_match(hay.as_bytes()));
        let m = Matcher::build(&opts("BILLQUERY")).unwrap();
        assert!(Prefilter::of(&m).unwrap().maybe_match(hay.as_bytes()));
    }

    /// 正则预判用 `(?m)` 版本：逐行 `^` / `$` 是**行边界**，直接拿原正则扫整文件
    /// 会把中间行的命中误判成「没命中」。`\A` 这类绝对锚点则必须放弃预判。
    #[test]
    fn 正则预判不漏行首锚点() {
        let hay = "// note\nclass Bill {}\n";
        for pat in [
            r"^class",
            r"^Bill",
            r"Bill$",
            r"\bbill\b",
            r"Bill\{\}",
            r"\Aclass",
        ] {
            let o = SearchOptions {
                regex: true,
                ..opts(pat)
            };
            let m = Matcher::build(&o).unwrap();
            let line_hit = hay.split('\n').any(|l| !m.spans(l, 8).is_empty());
            if line_hit {
                assert!(
                    file_may_match(&m, None, hay),
                    "{pat} 逐行有命中却被预判否决"
                );
            }
        }
        // 无关模式仍然能被整文件预判挡掉
        let o = SearchOptions {
            regex: true,
            ..opts(r"zzzznotexist")
        };
        let m = Matcher::build(&o).unwrap();
        assert!(!file_may_match(&m, None, hay));
    }

    /// 字面量预筛只放行区分大小写的模式；放行了的也必须是**必要条件**——
    /// 逐行能命中的整文件不许被判否，尤其 `^` / 前后缀截断 / 选择分支。
    #[test]
    fn 正则字面量预筛不漏命中() {
        let hay = "// note\nclass BillQueryServiceImpl {}\n  String VOUCHER = \"凭证\";\n";
        let cases = [
            r"BillQuery\w+Service",
            r"凭证|发票",
            r"VOUCHER|nope",
            r"class\s+\w+",
            r"^class",
            r"ServiceImpl$",
            r"\bBillQuery",
            r"(?i)billquery", // 内联忽略大小写：字面量集合会膨胀，应自动放弃预筛
        ];
        for cs in [true, false] {
            for pat in cases {
                let o = SearchOptions {
                    regex: true,
                    case_sensitive: cs,
                    ..opts(pat)
                };
                let m = Matcher::build(&o).unwrap();
                let line_hit = hay.split('\n').any(|l| !m.spans(l, 8).is_empty());
                if line_hit {
                    assert!(
                        file_may_match(&m, None, hay),
                        "{pat} (cs={cs}) 逐行有命中却被字面量预筛否决"
                    );
                }
                assert!(
                    !file_may_match(&m, None, "完全无关的一行\n"),
                    "{pat} (cs={cs}) 没能挡住无关文件"
                );
            }
        }
    }

    #[test]
    fn 大小写与整词规则() {
        let mut o = opts("foo");
        let m = Matcher::build(&o).unwrap();
        assert!(!m.spans("int foo = 1;", 32).is_empty());
        assert!(!m.spans("int FOO = 1;", 32).is_empty());

        o.case_sensitive = true;
        let m = Matcher::build(&o).unwrap();
        assert!(!m.spans("int foo = 1;", 32).is_empty());
        assert!(m.spans("int FOO = 1;", 32).is_empty());

        o.case_sensitive = false;
        o.whole_word = true;
        let m = Matcher::build(&o).unwrap();
        assert!(m.spans("foobar();", 32).is_empty(), "整词不能命中 foobar");
        assert!(!m.spans("a.foo();", 32).is_empty());
        assert!(m.spans("foo_1", 32).is_empty(), "下划线算标识符内字符");
    }

    #[test]
    fn 中文按字节包含即可命中() {
        let o = opts("凭证");
        let m = Matcher::build(&o).unwrap();
        assert!(!m.spans("// 生成凭证", 32).is_empty());
        assert!(m.spans("// 生成凭单", 32).is_empty());
    }

    #[test]
    fn 同一行多处命中都出区间() {
        let o = opts("aa");
        let m = Matcher::build(&o).unwrap();
        assert_eq!(m.spans("aaaa", 32), vec![(0, 2), (2, 4)], "不重叠");
        assert_eq!(m.spans("aaXaa", 32).len(), 2);
    }

    #[test]
    fn 正则_基本匹配与大小写() {
        let mut o = opts(r"foo\d+");
        o.regex = true;
        let m = Matcher::build(&o).unwrap();
        assert_eq!(m.spans("foo12 bar", 32), vec![(0, 5)]);

        // 不区分大小写（默认）
        let mut o2 = opts("FOO");
        o2.regex = true;
        assert!(!Matcher::build(&o2).unwrap().spans("foo", 32).is_empty());

        // 区分大小写由 case_sensitive 关掉 (?i)
        o2.case_sensitive = true;
        assert!(Matcher::build(&o2).unwrap().spans("foo", 32).is_empty());

        // 正则模式忽略 whole_word（想整词自己写 \b）
        let mut o3 = opts(r"\bfoo\b");
        o3.regex = true;
        o3.whole_word = true;
        let m3 = Matcher::build(&o3).unwrap();
        assert!(m3.spans("foobar", 32).is_empty());
        assert!(!m3.spans("a foo b", 32).is_empty());
    }

    #[test]
    fn 正则_非法与空串可匹配都要报错() {
        let mut o = opts("foo(");
        o.regex = true;
        let err = Matcher::build(&o).unwrap_err();
        assert!(err.contains("无效"), "实际：{err}");

        let mut o = opts("a*");
        o.regex = true;
        let err = Matcher::build(&o).unwrap_err();
        assert!(err.contains("空串"), "实际：{err}");
    }

    #[test]
    fn 区间用utf16偏移() {
        // 「凭证」占 6 个 UTF-16 码元（每字 1 个），前面 3 个字符
        let (text, ranges) = clip_with_ranges("abc凭证def", &[(3, 9)]);
        assert_eq!(text, "abc凭证def");
        assert_eq!(
            ranges,
            vec![MatchRange { start: 3, end: 5 }],
            "3 个字符 → 3..5"
        );

        // 生僻字（BMP 外）算 2 个码元：前端 slice 才对得上
        let (_, r2) = clip_with_ranges("a𝄞b", &[(1, 5)]);
        assert_eq!(r2, vec![MatchRange { start: 1, end: 3 }]);
    }

    #[test]
    fn 区间随截断裁剪() {
        let long = "x".repeat(MAX_LINE_CHARS + 10);
        let line = format!("{long}尾巴foo");
        // 命中落在截断后的「…」之外 → 不产出区间
        let start = long.len() + "尾巴".len();
        let (text, ranges) = clip_with_ranges(&line, &[(start, start + 3)]);
        assert!(text.ends_with('…'));
        assert!(ranges.is_empty(), "看不见的区间不该回给前端");
    }

    #[test]
    fn 长行截断() {
        let long = "x".repeat(MAX_LINE_CHARS + 50);
        let (got, _) = clip_with_ranges(&long, &[]);
        assert_eq!(
            got.chars().count(),
            MAX_LINE_CHARS + 1,
            "截断后带一个省略号"
        );
        assert!(got.ends_with('…'));
    }

    #[test]
    fn 文件过滤_包含与排除() {
        let f = FileFilter::parse("*.java, *.xml, !test*");
        assert!(f.accepts("gl/src/A.java", "A.java"));
        assert!(f.accepts("gl/src/B.xml", "B.xml"));
        assert!(!f.accepts("gl/src/C.txt", "C.txt"), "不在 include 里");
        assert!(
            !f.accepts("gl/src/testA.java", "testA.java"),
            "被 !test* 排除"
        );

        // 空掩码 = 全都要
        assert!(FileFilter::parse("").accepts("a/b.txt", "b.txt"));
        // 只有排除时，其余都放行
        let f2 = FileFilter::parse("!*.class");
        assert!(f2.accepts("a/b.java", "b.java"));
        assert!(!f2.accepts("a/B.CLASS", "B.CLASS"), "大小写不敏感");
    }

    #[test]
    fn 文件过滤_带斜杠按相对路径() {
        let f = FileFilter::parse("src/*.java");
        assert!(f.accepts("src/A.java", "A.java"), "`*` 不跨目录");
        assert!(!f.accepts("src/sub/A.java", "A.java"));
        let f2 = FileFilter::parse("src/**/*.java");
        assert!(f2.accepts("src/sub/deep/A.java", "A.java"), "`**` 可跨目录");
    }

    #[test]
    fn glob翻译基本形态() {
        let hit = |pat: &str, text: &str| glob_to_regex(pat).unwrap().re.is_match(text);
        assert!(hit("*.java", "A.java"));
        assert!(!hit("*.java", "A.javax"));
        assert!(hit("*.java", "a.Java"), "大小写不敏感");
        assert!(hit("A?java", "ABjava"));
        assert!(hit("*", "anything"));
        assert!(!hit("A*", "B.java"));
        assert!(hit("A*", "A"), "`*` 可以匹配空串");
        assert!(hit("*.java", "含正则元字符(1).java"), "元字符要被转义");
    }

    #[test]
    fn 空搜索词报错() {
        let root = std::env::temp_dir();
        let err = search(&root, &opts("  ")).unwrap_err();
        assert!(err.contains("为空"));
    }

    #[test]
    fn 并行扫描不漏文件且结果有序() {
        // 200 个文件（超过串行/并行分界的 64）每个一行命中：条数必须一个不少，
        // 且顺序按路径固定下来——并行完成顺序不定，不排序每次搜出来顺序都不一样。
        let dir = std::env::temp_dir().join("ncforge_search_parallel");
        let _ = std::fs::remove_dir_all(&dir);
        for i in 0..200 {
            let sub = dir.join(format!("m{:03}", i % 10));
            std::fs::create_dir_all(&sub).unwrap();
            std::fs::write(sub.join(format!("F{:03}.java", i)), "// foo\nclass A {}\n").unwrap();
        }

        let out = search(&dir, &opts("foo")).unwrap();
        assert_eq!(out.hits.len(), 200, "并行扫描不能漏文件");
        assert_eq!(out.files_matched, 200);
        assert!(!out.truncated, "没超上限不该标截断");

        let mut sorted = out.hits.clone();
        sorted.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
        let got: Vec<_> = out.hits.iter().map(|h| (h.path.as_str(), h.line)).collect();
        let want: Vec<_> = sorted.iter().map(|h| (h.path.as_str(), h.line)).collect();
        assert_eq!(got, want, "结果要按 (路径, 行号) 有序");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 取消后立即停下并标记半成品() {
        let dir = std::env::temp_dir().join("ncforge_search_cancel");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..100 {
            std::fs::write(dir.join(format!("F{i:03}.java")), "// foo\n").unwrap();
        }

        // 已取消：一个文件都不读，结果必须同时标 cancelled 与 truncated，
        // 前端才不会把它当成「完整搜索、没有结果」
        let cancel = AtomicBool::new(true);
        let out = search_cancellable(&dir, &opts("foo"), TIME_BUDGET_MS, &cancel).unwrap();
        assert!(out.cancelled && out.truncated);
        assert!(out.hits.is_empty());
        assert_eq!(out.files_scanned, 0);

        // 未取消：照常全量
        let out = search_cancellable(&dir, &opts("foo"), TIME_BUDGET_MS, &AtomicBool::new(false))
            .unwrap();
        assert!(!out.cancelled && !out.truncated);
        assert_eq!(out.hits.len(), 100);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 后台线程尚未启动时也能取消请求() {
        let gate = SearchGate::new(1);
        let request = gate.register(Some("palette"));
        gate.cancel("palette");
        assert!(request.run(|cancel| {
            assert_eq!(gate.running(), 0);
            cancel.load(Ordering::Relaxed)
        }));
    }

    #[test]
    fn 旧请求晚启动不能取消新请求() {
        let gate = SearchGate::new(1);
        let old = gate.register(Some("palette"));
        let new = gate.register(Some("palette"));
        assert!(old.run(|cancel| cancel.load(Ordering::Relaxed)));
        assert!(!new.run(|cancel| cancel.load(Ordering::Relaxed)));
        assert_eq!(gate.running(), 0);
    }

    #[test]
    fn 同来源新搜索顶替旧搜索_名额用完排队() {
        use std::sync::mpsc;
        let gate = Arc::new(SearchGate::new(1));

        // A 占住唯一名额，一直跑到被取消
        let (started_tx, started_rx) = mpsc::channel();
        let g = gate.clone();
        let a = std::thread::spawn(move || {
            g.run(Some("palette"), |cancel| {
                started_tx.send(()).unwrap();
                let t = Instant::now();
                while !cancel.load(Ordering::Relaxed) && t.elapsed() < Duration::from_secs(10) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                cancel.load(Ordering::Relaxed)
            })
        });
        started_rx.recv().unwrap();
        assert_eq!(gate.running(), 1);

        // 另一来源 B 排队；同来源 C 进来顶替 A，A 让出名额
        let g = gate.clone();
        let b =
            std::thread::spawn(move || g.run(Some("search-tab"), |c| c.load(Ordering::Relaxed)));
        std::thread::sleep(Duration::from_millis(30));
        let g = gate.clone();
        let c = std::thread::spawn(move || g.run(Some("palette"), |c| c.load(Ordering::Relaxed)));

        assert!(a.join().unwrap(), "A 应被同来源的新搜索取消");
        assert!(!b.join().unwrap(), "B 是别的来源，不能被牵连");
        assert!(!c.join().unwrap(), "C 自己不该带着取消标志");
        assert_eq!(gate.running(), 0, "名额都要归还");

        // 显式取消排队中的搜索：不等名额，带着已取消标志立刻返回
        let gate = Arc::new(SearchGate::new(1));
        let (hold_tx, hold_rx) = mpsc::channel::<()>();
        let (in_tx, in_rx) = mpsc::channel();
        let g = gate.clone();
        let holder = std::thread::spawn(move || {
            g.run(None, |_| {
                in_tx.send(()).unwrap();
                hold_rx.recv().ok();
            })
        });
        in_rx.recv().unwrap();
        let g = gate.clone();
        let waiting =
            std::thread::spawn(move || g.run(Some("palette"), |c| c.load(Ordering::Relaxed)));
        std::thread::sleep(Duration::from_millis(30));
        gate.cancel("palette");
        assert!(waiting.join().unwrap());
        hold_tx.send(()).unwrap();
        holder.join().unwrap();
        assert_eq!(gate.running(), 0);
    }

    #[test]
    fn 并行扫描仍然守住条数上限() {
        // 上限必须由「已收集条数」这个全局计数来卡：每个线程各自数自己那份
        // 会得到 线程数 × limit 条。
        let dir = std::env::temp_dir().join("ncforge_search_parallel_cap");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..120 {
            std::fs::write(dir.join(format!("F{:03}.java", i)), "foo\nfoo\n").unwrap();
        }

        let mut o = opts("foo");
        o.max_results = 5;
        let out = search(&dir, &o).unwrap();
        assert_eq!(out.hits.len(), 5);
        assert!(out.truncated);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 二进制扩展名不读文件() {
        // 名字像文本、内容也是文本，但扩展名属二进制类：必须按扩展名挡掉，
        // 不能靠 NUL 探测——探测意味着已经 open+read 过了，那才是慢的原因。
        let dir = std::env::temp_dir().join("ncforge_search_ext");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("A.class"), "foo\n").unwrap();
        std::fs::write(dir.join("B.CLASS"), "foo\n").unwrap();
        std::fs::write(dir.join("C.java"), "foo\n").unwrap();
        std::fs::write(dir.join("noext"), "foo\n").unwrap();

        let out = search(&dir, &opts("foo")).unwrap();
        let paths: Vec<&str> = out.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["C.java", "noext"],
            "二进制扩展名（含大写）都要跳过"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 目录跳过与行号从1开始() {
        let dir = std::env::temp_dir().join("ncforge_search_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join(".svn")).unwrap();
        std::fs::write(dir.join("src/A.java"), "class A {\n  int foo;\n}\n").unwrap();
        std::fs::write(dir.join(".svn/entries"), "foo\n").unwrap();

        let out = search(&dir, &opts("foo")).unwrap();
        assert_eq!(out.hits.len(), 1, ".svn 必须被跳过");
        assert_eq!(out.hits[0].line, 2, "行号从 1 开始");
        assert_eq!(out.hits[0].path, "src/A.java", "路径统一用 / 分隔");
        assert_eq!(out.files_matched, 1);
        assert_eq!(out.hits[0].ranges.len(), 1, "命中位置要回给前端高亮");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 文件清单跳过目录与二进制并按字典序() {
        let dir = std::env::temp_dir().join("ncforge_list_files_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("gl/src/p")).unwrap();
        std::fs::create_dir_all(dir.join(".svn")).unwrap();
        std::fs::create_dir_all(dir.join("gl/classes")).unwrap();
        std::fs::write(dir.join("gl/src/p/B.java"), "x").unwrap();
        std::fs::write(dir.join("gl/src/p/A.java"), "x").unwrap();
        std::fs::write(dir.join(".svn/entries"), "x").unwrap();
        std::fs::write(dir.join("gl/classes/A.class"), "x").unwrap();
        std::fs::write(dir.join("build.xml"), "x").unwrap();

        let (files, truncated) = list_files(&dir);
        assert_eq!(
            files,
            vec!["build.xml", "gl/src/p/A.java", "gl/src/p/B.java"]
        );
        assert!(!truncated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 流式搜索要「先出结果」：优先文件的第一批必须最先到，最终结果与一次性搜索一致。
    #[test]
    fn 流式搜索先推优先文件且结果与一次性一致() {
        let root = crate::test_support::tmp("stream-priority");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a/one.txt"), "needle 1\n").unwrap();
        std::fs::write(root.join("b/two.txt"), "needle 2\n").unwrap();
        std::fs::write(root.join("z.txt"), "nothing\n").unwrap();

        let mut o = opts("needle");
        o.max_results = 10;
        o.priority = vec!["b/two.txt".to_string()];
        let batches: Mutex<Vec<Vec<SearchHit>>> = Mutex::new(Vec::new());
        let out = search_stream(&root, &o, 5_000, &AtomicBool::new(false), &|batch| {
            batches.lock().unwrap().push(batch.to_vec());
        })
        .unwrap();

        {
            let seen = batches.lock().unwrap();
            assert!(!seen.is_empty(), "至少要推一批");
            assert_eq!(seen[0][0].path, "b/two.txt", "优先文件必须第一批出来");
        }

        assert_eq!(out.hits.len(), 2);
        assert_eq!(out.hits[0].path, "a/one.txt", "最终结果按路径排序");
        assert!(!out.cancelled);

        // 与一次性搜索同口径：流式只改节奏，不改结果集
        let one = search(&root, &o).unwrap();
        assert_eq!(one.hits.len(), out.hits.len());
        for (a, b) in one.hits.iter().zip(&out.hits) {
            assert_eq!((a.path.as_str(), a.line), (b.path.as_str(), b.line));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 流式搜索命中上限后立即停() {
        let root = crate::test_support::tmp("stream-cap");
        for i in 0..50 {
            std::fs::write(root.join(format!("f{i:02}.txt")), "needle\n").unwrap();
        }
        let mut o = opts("needle");
        o.max_results = 3;
        let out = search_stream(&root, &o, 5_000, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(out.hits.len(), 3);
        assert!(out.truncated, "到上限要标截断");
        // 多线程各在飞一个文件，最多多看几个；扫完 50 个说明没提前停
        assert!(out.files_scanned < 50, "到上限就该停，不该扫完整棵树");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真机：newar 上量首批延迟。手动跑：
    /// `cargo test --lib -- 真机_流式搜索首批延迟 --ignored --nocapture`
    #[test]
    #[ignore]
    fn 真机_流式搜索首批延迟() {
        let root = PathBuf::from(r"C:\work\aier\newar");
        if !root.is_dir() {
            return;
        }
        let mut o = opts("getBillNo");
        o.max_results = 50;
        // 用户真正会传的两类：刚打开过的文件 + 文件名就带关键词的文件
        o.priority = vec!["gl/src/private/nc/bs/gl/voucher/VoucherBO.java".to_string()];
        let first = Mutex::new(None::<u128>);
        let started = Instant::now();
        let out = search_stream(&root, &o, TIME_BUDGET_MS, &AtomicBool::new(false), &|_b| {
            let mut f = first.lock().unwrap();
            if f.is_none() {
                *f = Some(started.elapsed().as_millis());
            }
        })
        .unwrap();
        let elapsed = started.elapsed().as_millis();
        println!(
            "首批 {} ms / 完成 {elapsed} ms，{} 条，扫了 {} 个文件",
            first.lock().unwrap().unwrap_or(0),
            out.hits.len(),
            out.files_scanned
        );
    }

    #[test]
    fn 文件清单缓存_内存命中与磁盘往返() {
        let root = crate::test_support::tmp("list-cache-root");
        std::fs::create_dir_all(root.join("m/src")).unwrap();
        std::fs::write(root.join("m/src/A.java"), "x").unwrap();
        let cache_dir = crate::test_support::tmp("list-cache-dir");

        invalidate_list_cache();
        let (files, truncated) = list_files_cached(&root, &cache_dir);
        assert_eq!(files, vec!["m/src/A.java"]);
        assert!(!truncated);

        // 软 TTL 内：磁盘上新增了文件也不重扫，直接给同一份（这才是「秒开」的来源）
        std::fs::write(root.join("m/src/B.java"), "x").unwrap();
        let (again, _) = list_files_cached(&root, &cache_dir);
        assert_eq!(again, files, "软 TTL 内不该重新扫盘");

        // 清掉进程内的那份 → 从磁盘读回，冷启动（重启应用）走的就是这条路
        invalidate_list_cache();
        let (from_disk, _) = list_files_cached(&root, &cache_dir);
        assert_eq!(from_disk, files, "磁盘缓存应与上次扫描一致");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&cache_dir);
        invalidate_list_cache();
    }

    #[test]
    fn 清单磁盘缓存_版式与条数不符时丢弃() {
        let cache_dir = crate::test_support::tmp("list-cache-parse");
        let key = norm_root(Path::new("C:/proj"));
        let path = list_cache_path(&cache_dir, &key);
        write_list_cache(&path, &key, &["a/A.java".into(), "b/B.java".into()], false);
        assert_eq!(read_list_cache(&path, &key).unwrap().0.len(), 2);

        // 别的工程 → 不认（缓存文件名已按根哈希，这里是第二道保险）
        assert!(read_list_cache(&path, &norm_root(Path::new("C:/other"))).is_none());

        // 上次写到一半被杀：条数对不上，宁可重扫也别给出半份清单
        std::fs::write(&path, format!("{LIST_CACHE_VERSION}\n{key}\n0\n9\na\nb\n")).unwrap();
        assert!(read_list_cache(&path, &key).is_none());

        // 版式变了（升级后）同样丢弃
        std::fs::write(&path, format!("v0\n{key}\n0\n0\n")).unwrap();
        assert!(read_list_cache(&path, &key).is_none());

        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    #[test]
    fn 搜索结果按掩码过滤() {
        let dir = std::env::temp_dir().join("ncforge_search_mask");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("A.java"), "foo\n").unwrap();
        std::fs::write(dir.join("B.txt"), "foo\n").unwrap();

        let mut o = opts("foo");
        o.include = "*.java".into();
        let out = search(&dir, &o).unwrap();
        assert_eq!(out.hits.len(), 1);
        assert_eq!(out.hits[0].path, "A.java");
        assert_eq!(out.files_scanned, 1, "被掩码挡掉的文件不该计入扫描数");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 正则搜索走完整链路() {
        let dir = std::env::temp_dir().join("ncforge_search_regex");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("A.java"), "int foo1;\nint bar;\nint foo22;\n").unwrap();

        let mut o = opts(r"foo\d+");
        o.regex = true;
        let out = search(&dir, &o).unwrap();
        assert_eq!(out.hits.len(), 2);
        assert_eq!(out.hits[0].line, 1);
        assert_eq!(out.hits[0].ranges, vec![MatchRange { start: 4, end: 8 }]);
        assert_eq!(out.hits[1].ranges, vec![MatchRange { start: 4, end: 9 }]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 结果条数上限与截断标记() {
        let dir = std::env::temp_dir().join("ncforge_search_limit");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "hit\nhit\nhit\nhit\n").unwrap();

        let mut o = opts("hit");
        o.max_results = 2;
        let out = search(&dir, &o).unwrap();
        assert_eq!(out.hits.len(), 2);
        assert!(out.truncated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 前端传的是 camelCase（见 desktop/src/lib/search.ts）。这条断言是给
    /// TS ↔ Rust 的契约上锁用的：两边字段名一旦不一致，搜索会静默把所有选项
    /// 当默认值（比如「区分大小写」勾了却没用），单测里看不出来。
    #[test]
    fn 前端camelcase选项能反序列化() {
        let o: SearchOptions = serde_json::from_str(
            r#"{"text":"foo","caseSensitive":true,"wholeWord":true,"regex":false,
                "include":"*.java","maxResults":20}"#,
        )
        .unwrap();
        assert!(o.case_sensitive);
        assert!(o.whole_word);
        assert_eq!(o.include, "*.java");
        assert_eq!(o.max_results, 20);
    }

    /// 只传 `text` 时其余字段必须走默认值（前端确实只在需要时传可选字段）。
    #[test]
    fn 缺省字段走默认值() {
        let o: SearchOptions = serde_json::from_str(r#"{"text":"foo"}"#).unwrap();
        assert!(!o.regex);
        assert!(!o.whole_word);
        assert!(o.include.is_empty());
        assert_eq!(o.max_results, 0);
        assert!(o.dirs.is_empty(), "不传范围 = 整个工作区");
    }

    // ── 范围收窄（按业务组件搜索）──
    //
    // 口径：范围只是「收窄入口目录」，结果路径仍相对工作区根；范围不存在时搜索
    // 回落整个工作区（并标记），替换**拒绝执行**（破坏性操作不许悄悄扩大范围）。

    /// 三个源码根各放一个同名文件：整工程 3 处命中，只搜一个根就 1 处。
    fn scope_fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("ncf-scope-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for dir in ["bill/src/public", "bill/src/client", "gl/src/public"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("A.java"), "foo\n").unwrap();
        }
        root
    }

    fn paths(out: &SearchOutcome) -> Vec<&str> {
        out.hits.iter().map(|h| h.path.as_str()).collect()
    }

    #[test]
    fn 范围目录只搜指定目录且路径仍相对工作区根() {
        let root = scope_fixture("only");
        let out = search(&root, &opts_in("foo", &["bill/src/public"])).unwrap();
        assert_eq!(out.scope_dirs, vec!["bill/src/public"]);
        assert!(out.missing_dirs.is_empty());
        assert!(!out.scope_fallback);
        // 关键：路径是 `bill/src/public/A.java`，不是相对范围目录的 `A.java`
        assert_eq!(paths(&out), vec!["bill/src/public/A.java"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 多个范围目录都走一遍() {
        let root = scope_fixture("multi");
        let out = search(
            &root,
            &opts_in("foo", &["bill\\src\\public", "bill/src/client"]),
        )
        .unwrap();
        // 反斜杠写法与 `/` 等价（NC 的 manifest 写的可能是任一种）；
        // 回显顺序按 (长度, 字典序) 固定，同一份清单反复搜不会每次都变
        assert_eq!(out.scope_dirs, vec!["bill/src/client", "bill/src/public"]);
        assert_eq!(
            paths(&out),
            vec!["bill/src/client/A.java", "bill/src/public/A.java"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 嵌套范围去重后不重复计数() {
        let root = scope_fixture("nested");
        // `bill/src` 已覆盖 `bill/src/public`：不丢的话每个文件会被数两遍
        let out = search(&root, &opts_in("foo", &["bill/src", "bill/src/public"])).unwrap();
        assert_eq!(out.scope_dirs, vec!["bill/src"]);
        assert_eq!(out.hits.len(), 2, "bill 下两个源码根各一处，不能翻倍");
        assert_eq!(out.files_matched, 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 不存在的范围目录记下来其余照搜() {
        let root = scope_fixture("partial");
        let out = search(
            &root,
            &opts_in("foo", &["bill/src/public", "bill/src/nope"]),
        )
        .unwrap();
        assert_eq!(out.hits.len(), 1);
        assert_eq!(out.scope_dirs, vec!["bill/src/public"]);
        assert_eq!(out.missing_dirs, vec!["bill/src/nope"]);
        assert!(!out.scope_fallback, "还有一个能搜，就不算回落");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 范围全不存在时回落整个工作区() {
        let root = scope_fixture("fallback");
        // manifest 说组件在 `gone/`，磁盘上却没了（组件被删/改名）
        let out = search(&root, &opts_in("foo", &["gone/src", "gone/client"])).unwrap();
        assert!(out.scope_fallback);
        assert!(out.scope_dirs.is_empty());
        assert_eq!(out.missing_dirs.len(), 2);
        assert_eq!(out.hits.len(), 3, "回落不能连结果一起丢掉");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 非法范围被挡在工作区里() {
        let root = scope_fixture("illegal");
        // `..` 能跳出工作区、盘符是绝对路径、空串没有意义：都当非法范围
        let out = search(
            &root,
            &opts_in("foo", &["../../Windows", "C:\\Windows", "", "."]),
        )
        .unwrap();
        assert!(out.scope_fallback, "没有可用范围 → 回落整个工作区");
        assert_eq!(out.missing_dirs.len(), 4);
        assert_eq!(out.hits.len(), 3, "只能搜到工作区里的东西");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 范围收窄后替换也只改范围内的文件() {
        let root = scope_fixture("replace-in");
        let out = replace(&root, &opts_in("foo", &["bill/src/client"]), "bar").unwrap();
        assert_eq!(out.files_changed, 1);
        assert_eq!(
            std::fs::read_to_string(root.join("bill/src/public/A.java")).unwrap(),
            "foo\n",
            "范围外的文件一个字节都不能动"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("bill/src/client/A.java")).unwrap(),
            "bar\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 范围全不存在时拒绝替换而不是改整个工程() {
        let root = scope_fixture("replace-gone");
        let err = replace(&root, &opts_in("foo", &["gone/src"]), "bar").unwrap_err();
        assert!(err.contains("已取消替换"), "实际：{err}");
        for dir in ["bill/src/public", "bill/src/client", "gl/src/public"] {
            assert_eq!(
                std::fs::read_to_string(root.join(dir).join("A.java")).unwrap(),
                "foo\n",
                "拒绝时磁盘必须原样"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}

// ───────────────────── 替换 ─────────────────────

/// 「全部替换」的时间预算。
///
/// 比搜索的 20 秒宽：替换是**写操作**，跑到一半停下来会变成「改了一半」，
/// 比多等一会儿难查得多。仍要设上限——机械盘上一次全量可能几分钟，不能无限等。
const REPLACE_TIME_BUDGET_MS: u128 = 60_000;

/// 一次「全部替换」的汇总。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    /// 实际被改写的文件数。
    pub files_changed: usize,
    /// 替换了多少处。
    pub replacements: usize,
    /// 实际读过的文件数。
    pub files_scanned: usize,
    /// 编码无法无损往返或换行混合、被跳过的文件数。
    ///
    /// 跳过而不是硬改：按检测出的编码写回去，会让原文件里原本就有的「乱码字节」
    /// 被规范化，等于顺手破坏了别人的文件。宁可不改 + 报出来。
    pub skipped_unsafe: usize,
    /// 读写失败的文件（路径 + 原因）。只留前若干条，够定位就行。
    pub errors: Vec<String>,
    /// 是否因预算提前结束（此时「没改的文件」不代表「没有匹配」）。
    pub truncated: bool,
    pub elapsed_ms: u64,
}

impl Matcher {
    /// 把一行里的命中全部替换掉；没有命中返回 `None`（省掉一次字符串重建）。
    /// 返回 `(新行, 处数)`。`replacement` 必须是过过 [`escape_replacement`] 的。
    fn replace_line(&self, line: &str, replacement: &str) -> Option<(String, usize)> {
        match self {
            Matcher::Plain {
                needle,
                case_sensitive,
                whole_word,
            } => {
                let spans = plain_spans(line, needle, *case_sensitive, *whole_word, usize::MAX);
                if spans.is_empty() {
                    return None;
                }
                let n = spans.len();
                // with_capacity 只是提示：命中数 × 替换串长度可能是个天文数字
                // （4MB 的压缩单行里能命中几百万次），算出来的容量会把分配器直接
                // 打爆。封顶后按需增长——真需要那么大内存时该失败的是字符串本身，
                // 不是一次容量提示。
                let cap = line
                    .len()
                    .saturating_add(replacement.len().saturating_mul(n.min(1024)));
                let mut out = String::with_capacity(cap);
                let mut last = 0usize;
                for (s, e) in &spans {
                    out.push_str(&line[last..*s]);
                    out.push_str(replacement);
                    last = *e;
                }
                out.push_str(&line[last..]);
                Some((out, n))
            }
            Matcher::Re { re, .. } => {
                if !re.is_match(line) {
                    return None;
                }
                // 正则在**每行内**做替换，不跨行：跨行的工作由用户自己写 (?s)，
                // 这里保持与搜索（逐行扫描）一致的口径，否则「替换的」和「搜到的」不一样多。
                let n = re.find_iter(line).count();
                Some((re.replace_all(line, replacement).into_owned(), n))
            }
        }
    }

    /// 把用户写的替换串过一遍安全转义（仅正则需要：纯文本模式 `$` 没有特殊含义）。
    fn escape_replacement(&self, rep: &str) -> String {
        match self {
            Matcher::Plain { .. } => rep.to_string(),
            Matcher::Re { re, .. } => escape_replacement(re, rep),
        }
    }
}

/// 把用户写的替换串转成 `regex` crate 能安全消费的形式。
///
/// `replace_all` 的替换串里 `$1` / `${name}` 是分组引用，且**指向不存在组的引用
/// 会被静默替换成空串**——用户在替换框里打一个字面 `$`（价格、`$变量`）就被吃掉了。
/// 这里只放行指向存在组的引用，其余一律转义成字面量（`$$`）。
///
/// 解析口径与 crate 的 `find_cap_ref` 保持一致（先数字后名称、`{}` 必须闭合），
/// 否则同一串文本会在「我们觉得合法」与「crate 实际怎么解」之间打架。
fn escape_replacement(re: &regex::Regex, rep: &str) -> String {
    // 合法数字组上标（0 号组是整匹配，也算合法引用）
    let max_group = re.captures_len().saturating_sub(1);
    let names: Vec<&str> = re.capture_names().flatten().collect();
    let bytes = rep.as_bytes();
    let mut out = String::with_capacity(rep.len() + 4);
    let mut i = 0usize;
    while i < bytes.len() {
        // 非 `$` 片段整段拷贝（`$` 是 ASCII，字节下标即字符边界）
        match rep[i..].find('$') {
            None => {
                out.push_str(&rep[i..]);
                break;
            }
            Some(off) => {
                out.push_str(&rep[i..i + off]);
                i += off;
            }
        }
        let after = i + 1;
        match bytes.get(after) {
            // 末尾的 `$`：crate 会把它吞掉，转义成字面
            None => {
                out.push_str("$$");
                i = after;
            }
            // `$$` 本来就是字面 `$` 的转义，原样保留
            Some(b'$') => {
                out.push_str("$$");
                i = after + 1;
            }
            Some(_) => {
                let (end, valid) = parse_group_ref(bytes, after, max_group, &names);
                if valid {
                    out.push_str(&rep[i..end]);
                } else {
                    out.push_str("$$");
                    out.push_str(&rep[after..end]);
                }
                i = end;
            }
        }
    }
    out
}

/// 解析 `$` 之后的组引用，返回 `(引用结束的字节下标, 是否是合法引用)`。
/// 非法时结束下标可能等于 `start`（如 `$` 后跟空格），调用方据此只转义 `$` 本身。
fn parse_group_ref(bytes: &[u8], start: usize, max_group: usize, names: &[&str]) -> (usize, bool) {
    let mut i = start;
    let brace = bytes.get(i) == Some(&b'{');
    if brace {
        i += 1;
    }
    let valid = if matches!(bytes.get(i), Some(b) if b.is_ascii_digit()) {
        // 数字引用：取最长数字串（`$12` 是组 12，不是组 1 后跟 '2'）
        let mut num = 0usize;
        while let Some(&b) = bytes.get(i) {
            if b.is_ascii_digit() {
                num = num.saturating_mul(10).saturating_add((b - b'0') as usize);
                i += 1;
            } else {
                break;
            }
        }
        num <= max_group
    } else {
        // 名称引用：`[0-9A-Za-z_]` 最长串
        let mut name = String::new();
        while let Some(&b) = bytes.get(i) {
            if b.is_ascii_alphanumeric() || b == b'_' {
                name.push(b as char);
                i += 1;
            } else {
                break;
            }
        }
        !name.is_empty() && names.contains(&name.as_str())
    };
    if brace {
        // `${` 不闭合：整个不算引用（crate 的 find_cap_ref 返回 None，
        // 效果是 `$` 按字面输出、后面原样跟着）
        if bytes.get(i) != Some(&b'}') {
            return (start, false);
        }
        i += 1;
    }
    (i, valid)
}

/// 单个文件的替换结果。
enum FileOutcome {
    /// 改了几处。
    Changed(usize),
    /// 没有命中。
    Same,
    /// 编码 / 换行不安全，主动跳过。
    Unsafe,
}

fn replace_in_file(
    path: &Path,
    matcher: &Matcher,
    replacement: &str,
) -> Result<FileOutcome, String> {
    let c = match workspace::read_text_file(path) {
        Ok(c) => c,
        // 二进制文件（扩展名不在名单上、内容含 NUL）归到「主动跳过」而不是错误：
        // 一个工程里几百个这种文件会把 20 条错误名额占满，把真正的权限/占用错误
        // 挤到看不到的地方
        Err(e) if workspace::is_binary_read_error(&e) => return Ok(FileOutcome::Unsafe),
        Err(e) => return Err(e),
    };
    // 混合换行、或编码无法无损往返的文件不改：按检测结果写回去会顺手改动原本的字节。
    // 这不是「替换」该有的副作用，宁可跳过并报数。
    if c.eol == workspace::Eol::Mixed || !c.lossless {
        return Ok(FileOutcome::Unsafe);
    }
    let mut changed = 0usize;
    let mut new_len = 0usize;
    let mut lines: Vec<String> = Vec::new();
    for line in c.text.split('\n') {
        match matcher.replace_line(line, replacement) {
            Some((l, n)) => {
                changed += n;
                new_len += l.len();
                lines.push(l);
            }
            None => {
                new_len += line.len();
                lines.push(line.to_string());
            }
        }
    }
    if changed == 0 {
        return Ok(FileOutcome::Same);
    }
    // 替换把文件撑到编辑器自己都打不下的大小就跳过：这种「替换」实质是内容生成，
    // 且产物在本工具里没法再编辑。判定放在写盘前，跳过后磁盘上还是原样。
    if new_len as u64 > workspace::MAX_FILE_BYTES {
        return Ok(FileOutcome::Unsafe);
    }
    // 用读到的 mtime 做期望值：中途被别的程序改过就报 CONFLICT，而不是覆盖别人的改动
    workspace::write_text_file(
        path,
        &lines.join("\n"),
        c.encoding,
        c.has_bom,
        c.eol,
        Some(c.mtime_ms),
    )?;
    Ok(FileOutcome::Changed(changed))
}

/// 在工作区内替换。候选收集与搜索同一套（同样的目录跳过、掩码、大小上限），
/// 因此「替换」覆盖的范围与「搜索」完全一致——人看到的结果就是会被改的范围。
pub fn replace(
    root: &Path,
    opts: &SearchOptions,
    replacement: &str,
) -> Result<ReplaceOutcome, String> {
    // 与 search() 同一道空词校验：否则「全部替换」对空搜索词什么都不做，
    // 用户以为点了没反应（搜索那边至少会报错）
    let needle = if opts.regex {
        opts.text.as_str()
    } else {
        opts.text.trim()
    };
    if needle.trim().is_empty() {
        return Err("搜索词为空".to_string());
    }
    let matcher = Matcher::build(opts)?;
    // 正则模式下 $1/${name} 是分组引用，指向不存在组的引用会被静默替换成空串
    // （用户在替换框里打的字面 $ 会被吃掉）。先整串转义一遍：只放行合法引用。
    let replacement = matcher.escape_replacement(replacement);
    let filter = FileFilter::parse(&opts.include);
    let started = Instant::now();
    // 与搜索同一份范围解析：替换的覆盖面必须**逐字等于**屏幕上列出的结果，
    // 否则「按组件搜索 + 全部替换」会改到组件外面的文件（不可撤销）
    let scope = plan_scope(root, &opts.dirs);
    // 搜索可以静默回落（非破坏性，顶多噪声多一点）；替换不行：请求的范围一个都
    // 不存在时会退化成「改整个工作区」，而用户按下按钮时脑子里是「只改这个组件」。
    // 宁可拒绝并让他重新搜一次——那时界面上会明确显示「已回落成整个工作区」。
    if !opts.dirs.is_empty() && scope.fallback {
        return Err(format!(
            "范围目录都不存在（{}），已取消替换：重新搜索确认范围后再改",
            scope.missing.join("、")
        ));
    }
    let (candidates, walk_truncated) = collect_candidates(
        root,
        &scope.abs,
        &filter,
        started,
        TIME_BUDGET_MS,
        &AtomicBool::new(false),
    );

    let cursor = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);

    // 写操作按文件互不相交，并行安全。线程数与搜索一致（盘快线程才有意义）
    let threads = if candidates.len() < 64 {
        1
    } else {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(2, 8)
    };

    struct Totals {
        files_changed: usize,
        replacements: usize,
        scanned: usize,
        skipped: usize,
        errors: Vec<String>,
    }

    let mut panicked = false;
    let mut batches: Vec<Totals> = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(threads);
        for _ in 0..threads {
            handles.push(scope.spawn(|| {
                let mut t = Totals {
                    files_changed: 0,
                    replacements: 0,
                    scanned: 0,
                    skipped: 0,
                    errors: Vec::new(),
                };
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let idx = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some((path, _rel)) = candidates.get(idx) else {
                        break;
                    };
                    if started.elapsed().as_millis() > REPLACE_TIME_BUDGET_MS {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    match replace_in_file(path, &matcher, &replacement) {
                        Ok(FileOutcome::Changed(n)) => {
                            t.files_changed += 1;
                            t.replacements += n;
                        }
                        Ok(FileOutcome::Unsafe) => t.skipped += 1,
                        Ok(FileOutcome::Same) => {}
                        Err(e) => {
                            // 错误只留前 20 条：一次替换里成百上千个同类错误没有信息量
                            if t.errors.len() < 20 {
                                t.errors.push(format!("{}: {e}", path.display()));
                            }
                        }
                    }
                    t.scanned += 1;
                }
                t
            }));
        }
        handles
            .into_iter()
            .map(|h| {
                h.join().unwrap_or_else(|_| {
                    // worker panic（bug 或 OOM）不能吞成「成功」：它那份文件的计数
                    // 会凭空消失，汇总却报告替换完成。至少让 truncated 与 errors 说实话
                    panicked = true;
                    Totals {
                        files_changed: 0,
                        replacements: 0,
                        scanned: 0,
                        skipped: 0,
                        errors: Vec::new(),
                    }
                })
            })
            .collect()
    });

    let mut files_changed_n = 0usize;
    let mut replacements_n = 0usize;
    let mut scanned_n = 0usize;
    let mut skipped_n = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for t in batches.iter_mut() {
        files_changed_n += t.files_changed;
        replacements_n += t.replacements;
        scanned_n += t.scanned;
        skipped_n += t.skipped;
        errors.append(&mut t.errors);
    }
    if panicked {
        errors.push("内部错误：有替换线程异常退出，结果可能不完整".to_string());
    }
    errors.truncate(20);

    Ok(ReplaceOutcome {
        files_changed: files_changed_n,
        replacements: replacements_n,
        files_scanned: scanned_n,
        skipped_unsafe: skipped_n,
        errors,
        truncated: stop.load(Ordering::Relaxed) || walk_truncated || panicked,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod replace_tests {
    use super::*;
    use std::fs;

    fn opts(text: &str) -> SearchOptions {
        SearchOptions {
            text: text.to_string(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
            include: String::new(),
            dirs: Vec::new(),
            max_results: 0,
            priority: Vec::new(),
            overlay: Vec::new(),
        }
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncf-replace-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 纯文本替换_多文件多行() {
        let root = tmpdir("plain");
        fs::write(
            root.join("A.java"),
            "class A {\n  void save() {}\n  void run() { save(); }\n}\n",
        )
        .unwrap();
        fs::write(root.join("B.java"), "int save = 1;\n").unwrap();
        fs::create_dir_all(root.join(".svn")).unwrap();
        fs::write(root.join(".svn/S.java"), "save save save").unwrap();

        let out = replace(&root, &opts("save"), "persist").unwrap();
        assert_eq!(out.files_changed, 2);
        // A.java 两处（第 2、3 行）+ B.java 一处
        assert_eq!(out.replacements, 3);
        assert!(out.errors.is_empty());
        let a = fs::read_to_string(root.join("A.java")).unwrap();
        assert_eq!(
            a,
            "class A {\n  void persist() {}\n  void run() { persist(); }\n}\n"
        );
        let b = fs::read_to_string(root.join("B.java")).unwrap();
        assert_eq!(b, "int persist = 1;\n");
        // .svn 是版本库元数据，不动
        assert_eq!(
            fs::read_to_string(root.join(".svn/S.java")).unwrap(),
            "save save save"
        );
    }

    #[test]
    fn 大小写不敏感默认命中() {
        let root = tmpdir("case");
        fs::write(root.join("A.java"), "int FOO = 1;\n").unwrap();
        let out = replace(&root, &opts("foo"), "bar").unwrap();
        assert_eq!(out.replacements, 1);
        assert_eq!(
            fs::read_to_string(root.join("A.java")).unwrap(),
            "int bar = 1;\n"
        );
    }

    #[test]
    fn 整词模式不误伤更长标识符() {
        let root = tmpdir("word");
        fs::write(root.join("A.java"), "save(saved);\n").unwrap();
        let mut o = opts("save");
        o.whole_word = true;
        let out = replace(&root, &o, "persist").unwrap();
        // 只有独立的 save 命中：saved 是更长标识符，整词模式必须放过它。
        // （这条期望值曾经写错过一次——写成 2 处、断言 persist(persisted)，那是把
        //   「不误伤」的测试写成了「误伤才对」。改期望前先想清楚要的是什么行为。）
        assert_eq!(out.replacements, 1);
        assert_eq!(
            fs::read_to_string(root.join("A.java")).unwrap(),
            "persist(saved);\n"
        );
    }

    #[test]
    fn 正则支持分组引用() {
        let root = tmpdir("regex");
        fs::write(root.join("A.java"), "String a = \"x\";\n").unwrap();
        let mut o = opts("\"([a-z]+)\"");
        o.regex = true;
        let out = replace(&root, &o, "'$1'").unwrap();
        assert_eq!(out.replacements, 1);
        assert_eq!(
            fs::read_to_string(root.join("A.java")).unwrap(),
            "String a = 'x';\n"
        );
    }

    /// `replace_all` 会把指向不存在组的 `$引用` 静默替换成空串——用户在替换框里
    /// 打的字面 `$`（价格、`$变量`）就这样被吃掉了。转义后必须按字面输出。
    #[test]
    fn 正则替换_字面美元符号不被吞掉() {
        let root = tmpdir("dollar");
        fs::write(root.join("A.java"), "price = 10;\n").unwrap();
        let mut o = opts("price");
        o.regex = true;
        let out = replace(&root, &o, "$price").unwrap();
        assert_eq!(out.replacements, 1);
        assert_eq!(
            fs::read_to_string(root.join("A.java")).unwrap(),
            "$price = 10;\n"
        );
    }

    #[test]
    fn 正则替换_越界与不闭合引用按字面输出() {
        let root = tmpdir("oor");
        fs::write(root.join("A.java"), "a\n").unwrap();
        let mut o = opts("(a)");
        o.regex = true;
        // 只有 1 个组，$2 越界：按字面写 $2，不是静默删掉
        let out = replace(&root, &o, "$2").unwrap();
        assert_eq!(out.replacements, 1);
        assert_eq!(fs::read_to_string(root.join("A.java")).unwrap(), "$2\n");
        // ${1 不闭合：$ 与后续字符都按字面（原文恢复，两次替换互不相干）
        fs::write(root.join("A.java"), "a\n").unwrap();
        let out = replace(&root, &o, "${1").unwrap();
        assert_eq!(out.replacements, 1);
        assert_eq!(fs::read_to_string(root.join("A.java")).unwrap(), "${1\n");
    }

    #[test]
    fn 替换串转义_只放行合法组引用() {
        let re = regex::Regex::new(r"(a)(?P<mid>b)").unwrap();
        assert_eq!(escape_replacement(&re, "$1-$2"), "$1-$2", "合法引用原样");
        assert_eq!(escape_replacement(&re, "$3"), "$$3", "越界数字组转义");
        assert_eq!(escape_replacement(&re, "${mid}"), "${mid}", "命名组原样");
        assert_eq!(
            escape_replacement(&re, "${nope}"),
            "$${nope}",
            "不存在的命名组转义"
        );
        assert_eq!(escape_replacement(&re, "$"), "$$", "末尾的 $ 转义");
        assert_eq!(escape_replacement(&re, "a$ b"), "a$$ b", "$ 后跟空格转义");
        assert_eq!(
            escape_replacement(&re, "$$1"),
            "$$1",
            "$$ 保留（它本就是字面 $ 的转义）"
        );
        assert_eq!(
            escape_replacement(&re, "${1"),
            "$${1",
            "不闭合花括号只转义 $"
        );
        assert_eq!(escape_replacement(&re, "50$"), "50$$", "价格场景");
    }

    /// 与 search() 同一道空词校验：替换对空搜索词什么都不做的话，
    /// 用户会以为「全部替换」按钮没反应。
    #[test]
    fn 空搜索词替换报错() {
        let root = tmpdir("empty");
        fs::write(root.join("A.java"), "foo\n").unwrap();
        let err = replace(&root, &opts("   "), "x").unwrap_err();
        assert!(err.contains("为空"), "实际：{err}");
        assert_eq!(fs::read_to_string(root.join("A.java")).unwrap(), "foo\n");
    }

    /// 含 NUL 的文件（扩展名不在二进制名单上）归到「主动跳过」而不是错误：
    /// 否则一个工程里几百个这种文件会占满 20 条错误名额。
    #[test]
    fn 二进制内容按跳过处理不占错误名额() {
        let root = tmpdir("bin");
        fs::write(root.join("A.bin.txt"), b"foo\x00bar\n").unwrap();
        fs::write(root.join("B.java"), "foo\n").unwrap();
        let out = replace(&root, &opts("foo"), "bar").unwrap();
        assert_eq!(out.files_changed, 1, "只有 B.java 被改");
        assert_eq!(out.skipped_unsafe, 1, "二进制文件计入跳过");
        assert!(out.errors.is_empty(), "二进制不算错误");
        assert_eq!(
            fs::read(root.join("A.bin.txt")).unwrap(),
            b"foo\x00bar\n",
            "原文一个字节都没动"
        );
    }

    /// 替换把文件撑到编辑器自己都打不下的大小（>10MB）就跳过：那种「替换」
    /// 实质是内容生成，产物在本工具里没法再编辑。
    #[test]
    fn 替换产物体积过大时跳过不改() {
        let root = tmpdir("balloon");
        let path = root.join("A.java");
        fs::write(&path, "a".repeat(200_000)).unwrap();
        // 20 万处命中 × 60 字节 ≈ 12MB，超过 10MB 上限
        let out = replace(path.parent().unwrap(), &opts("a"), &"b".repeat(60)).unwrap();
        assert_eq!(out.files_changed, 0);
        assert_eq!(out.skipped_unsafe, 1);
        assert_eq!(fs::read_to_string(&path).unwrap(), "a".repeat(200_000));
    }

    #[test]
    fn 混合换行的文件跳过不改() {
        let root = tmpdir("mixed");
        let path = root.join("A.java");
        fs::write(&path, b"a\r\nsave\r\nb\nsave\n").unwrap();
        let out = replace(&root, &opts("save"), "persist").unwrap();
        assert_eq!(out.files_changed, 0);
        assert_eq!(out.skipped_unsafe, 1);
        // 原文一个字节都没动：按行替换再写回会把整份文件的换行都变一遍
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nsave\r\nb\nsave\n");
    }

    #[test]
    fn 没有命中就不写文件() {
        let root = tmpdir("nohit");
        fs::write(root.join("A.java"), "nothing here").unwrap();
        let out = replace(&root, &opts("save"), "persist").unwrap();
        assert_eq!(out.files_changed, 0);
        assert_eq!(out.replacements, 0);
        assert_eq!(
            fs::read_to_string(root.join("A.java")).unwrap(),
            "nothing here"
        );
    }
}

// ───────────────────── 真机 ─────────────────────

/// 真机快照（`#[ignore]`，本机 `C:\work\aier\newar`）。
///
/// 为什么放在 lib 里而不是 `tests/*_live.rs`：`cargo test --test <名>` 会顺带重建
/// 主二进制（为了 `CARGO_BIN_EXE_*`），开发时 `nc-forge.exe` 正在跑就必然
/// 「拒绝访问」；`--lib` 不碰 bin。`shadow.rs` 的真机用例也是这个理由。
///
/// ```bash
/// node scripts/rust-gate.mjs test --lib -- --ignored 范围搜索_
/// ```
#[cfg(test)]
mod live_tests {
    use super::*;

    const ROOT: &str = r"C:\work\aier\newar";
    /// 注册在 manifest 里、磁盘上真有 `.java` 的组件（`bill` 只有资源，比不了）。
    const COMPONENT: &str = "gl";

    fn opts(text: &str, dirs: &[&str]) -> SearchOptions {
        SearchOptions {
            text: text.to_string(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
            include: "*.java".to_string(),
            dirs: dirs.iter().map(|d| d.to_string()).collect(),
            max_results: 0,
            priority: Vec::new(),
            overlay: Vec::new(),
        }
    }

    fn find(root: &Path, o: &SearchOptions) -> SearchOutcome {
        // 预算给足：7000 个 java 冷缓存实测 29.8 秒；180 秒保证不会因截断而误判
        search_with_budget(root, o, 180_000).expect("搜索不该报错")
    }

    /// 命中行的可比形态（`SearchHit` 没实现 `PartialEq`）。
    fn lines(out: &SearchOutcome) -> Vec<(String, u32)> {
        out.hits.iter().map(|h| (h.path.clone(), h.line)).collect()
    }

    /// **等价性**：在 `gl` 里搜 X ≡ 全工程搜 X 再按路径前缀 `gl/` 过滤。
    ///
    /// 这是「按组件搜索」能不能信的全部依据。范围实现换的是「入口目录」，一旦在
    /// `collect_candidates` 里把相对路径算成了相对范围目录、或漏了范围外的目录，
    /// 结果就会和过滤对不上——界面上看不出来，只会「少几条」。
    ///
    /// 2026-11-03 实测（`gl_voucher`，冷缓存）：全工程 127 条 / 扫 7339 个文件 / 29.8s；
    /// `gl` 内 126 条 / 扫 111 个文件 / **90ms**——范围外只排掉 1 条（`ia/`）。
    /// 也就是说这个例子的价值在**速度**（330 倍）而不在噪声，热缓存下全量约 1~2s。
    #[test]
    #[ignore = "真机：依赖 C:\\work\\aier\\newar"]
    fn 范围搜索_按组件与全量过滤一致() {
        let root = Path::new(ROOT);
        if !root.is_dir() {
            eprintln!("跳过：本机没有 {ROOT}");
            return;
        }

        let full = find(root, &opts("gl_voucher", &[]));
        let scoped = find(root, &opts("gl_voucher", &[COMPONENT]));

        println!(
            "全工程 {} 条 / 扫 {} 个文件 / {}ms；组件 {COMPONENT} {} 条 / 扫 {} 个文件 / {}ms",
            full.hits.len(),
            full.files_scanned,
            full.elapsed_ms,
            scoped.hits.len(),
            scoped.files_scanned,
            scoped.elapsed_ms
        );

        // 截断会让对比失去意义：先确认两边都搜完
        assert!(!full.truncated, "全量搜索被截断（条数或时间上限）");
        assert!(
            !scoped.truncated,
            "范围搜索被截断，说明范围没生效或结果过多"
        );
        assert!(!full.hits.is_empty(), "这个词在 newar 里应该搜得到");
        assert!(
            scoped.files_scanned < full.files_scanned,
            "范围没生效：组件内扫了 {} 个文件，全量扫了 {} 个",
            scoped.files_scanned,
            full.files_scanned
        );

        let want: Vec<(String, u32)> = full
            .hits
            .iter()
            .filter(|h| h.path.starts_with(&format!("{COMPONENT}/")))
            .map(|h| (h.path.clone(), h.line))
            .collect();
        assert_eq!(
            lines(&scoped),
            want,
            "范围搜索与「全量 + 路径过滤」必须逐行一致"
        );
        // 范围外确有命中，这条对比才说明「范围真的排除了东西」
        assert!(
            want.len() < full.hits.len(),
            "全工程的命中全在 {COMPONENT} 里，换个词才能验证范围"
        );
        println!(
            "范围内 {} 条，范围外排除 {} 条",
            want.len(),
            full.hits.len() - want.len()
        );
    }

    /// 组件目录被删 / 改名（manifest 与磁盘不一致）时必须回落全量，不能一条都搜不到。
    #[test]
    #[ignore = "真机：依赖 C:\\work\\aier\\newar"]
    fn 范围搜索_组件不存在时回落全量() {
        let root = Path::new(ROOT);
        if !root.is_dir() {
            eprintln!("跳过：本机没有 {ROOT}");
            return;
        }

        let full = find(root, &opts("gl_voucher", &[]));
        let fallen = find(root, &opts("gl_voucher", &["ncforge-不存在的组件"]));

        println!(
            "回落：{} 条 / scope_fallback={} / missing={:?}",
            fallen.hits.len(),
            fallen.scope_fallback,
            fallen.missing_dirs
        );

        assert!(fallen.scope_fallback, "范围全不存在时必须标记回落");
        assert_eq!(
            fallen.missing_dirs,
            vec!["ncforge-不存在的组件".to_string()]
        );
        assert!(fallen.scope_dirs.is_empty(), "回落时生效范围就是整个工作区");
        assert_eq!(lines(&fallen), lines(&full), "回落不能丢结果");
    }
}

/// 内容包路径与磁盘路径必须给出**逐条相同**的结果。
///
/// 这是整个改造的正确性底线：两条路共用 `scan_text`，但候选来源、编码（包内已归一成
/// UTF-8）、范围过滤方式都不同，任何一处口径漂移都会变成「同一个词搜两次结果不一样」。
#[cfg(test)]
mod pack_parity {
    use super::*;
    use std::fs;

    fn opt(text: &str) -> SearchOptions {
        SearchOptions {
            text: text.to_string(),
            ..Default::default()
        }
    }

    /// 一条命中的可比签名：路径 / 行号 / 行文本 / 高亮区间。
    type HitSig = (String, u32, String, Vec<(u32, u32)>);

    fn sig(o: &SearchOutcome) -> Vec<HitSig> {
        o.hits
            .iter()
            .map(|h| {
                (
                    h.path.clone(),
                    h.line,
                    h.text.clone(),
                    h.ranges.iter().map(|r| (r.start, r.end)).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn pack_and_disk_agree() {
        let root = crate::test_support::tmp("pack-parity");
        fs::create_dir_all(root.join("bill")).unwrap();
        fs::write(
            root.join("bill/A.java"),
            "class A {\n  // 凭证查询\n  String s = \"凭证\";\n}\n".as_bytes(),
        )
        .unwrap();
        fs::write(
            root.join("bill/B.java"),
            "class B { int Voucher = 1; }\n".as_bytes(),
        )
        .unwrap();
        let (gbk, _, _) = encoding_rs::GBK.encode("凭证 发票\nvoucher");
        fs::write(root.join("bill/C.xml"), &gbk).unwrap();
        fs::write(root.join("doc.txt"), "凭证\nvoucher BAR\n").unwrap();

        let cases = [
            opt("凭证"),
            opt("voucher"),
            SearchOptions {
                case_sensitive: true,
                ..opt("Voucher")
            },
            SearchOptions {
                whole_word: true,
                ..opt("voucher")
            },
            SearchOptions {
                regex: true,
                ..opt("凭.*查询")
            },
            SearchOptions {
                include: "*.java".to_string(),
                ..opt("凭证")
            },
            SearchOptions {
                dirs: vec!["bill".to_string()],
                ..opt("voucher")
            },
            SearchOptions {
                overlay: vec![OverlayDoc {
                    path: "bill/A.java".to_string(),
                    text: "class A {\n  String s = \"未保存的凭证\";\n}\n".to_string(),
                }],
                ..opt("未保存")
            },
        ];

        // ① 磁盘路径：把包目录指到一个不存在的位置
        crate::content_pack::set_cache_dir(&root.join("no-pack"));
        let disk: Vec<Vec<_>> = cases
            .iter()
            .map(|o| {
                sig(&search_cancellable(&root, o, TIME_BUDGET_MS, &AtomicBool::new(false)).unwrap())
            })
            .collect();

        // ② 建包后同一条路走包（按新布局写进 `<base>/<根哈希>/`）
        let base = root.join("search-pack");
        let pack_dir = crate::content_pack::dir_for(&base, &root);
        crate::content_pack::build(&root, &pack_dir, &AtomicBool::new(false)).unwrap();
        crate::content_pack::set_cache_dir(&root);
        assert!(
            crate::content_pack::current_for(&root).is_some(),
            "建完包必须能加载"
        );

        for (i, o) in cases.iter().enumerate() {
            let packed =
                search_cancellable(&root, o, TIME_BUDGET_MS, &AtomicBool::new(false)).unwrap();
            assert_eq!(
                disk[i],
                sig(&packed),
                "第 {i} 组（{:?}）两条路结果不同",
                o.text
            );
        }
    }
}
