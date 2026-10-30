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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

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
const TIME_BUDGET_MS: u128 = 20_000;

/// 搜索选项。前端传 camelCase（与 `serde(rename_all)` 对齐）。
#[derive(Debug, Clone, Deserialize)]
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
    /// 结果条数上限；0 或超过 `HARD_MAX_RESULTS` 时按上限处理。
    #[serde(default)]
    pub max_results: usize,
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
}

/// 匹配器：纯文本与正则两条路，编译一次复用（正则逐行编译会慢到不可用）。
#[derive(Debug)]
enum Matcher {
    Plain {
        needle: String,
        case_sensitive: bool,
        whole_word: bool,
    },
    Re(regex::Regex),
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
            return Ok(Matcher::Re(re));
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
            Matcher::Re(re) => re
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

    let started = Instant::now();
    let limit = match opts.max_results {
        0 => HARD_MAX_RESULTS,
        n => n.min(HARD_MAX_RESULTS),
    };

    // ── 第一段：收集候选（目录枚举也是 I/O，但只做一遍）──
    let (candidates, walk_truncated) = collect_candidates(root, &filter, started);

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

    let mut batches: Vec<Vec<SearchHit>> = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(threads);
        for _ in 0..threads {
            handles.push(scope.spawn(|| {
                let mut local: Vec<SearchHit> = Vec::new();
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let idx = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some((path, rel)) = candidates.get(idx) else {
                        break;
                    };
                    if started.elapsed().as_millis() > TIME_BUDGET_MS {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    let room = limit.saturating_sub(collected.load(Ordering::Relaxed));
                    if room == 0 {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }

                    let before = local.len();
                    let was_text = scan_file(path, rel, &matcher, room, &mut local);
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
            .map(|h| h.join().unwrap_or_default())
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
        truncated: capped || stop.load(Ordering::Relaxed) || walk_truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 走一遍工作区，返回通过掩码、大小合适的候选文件 `(绝对路径, 相对路径)`。
///
/// 掩码判断放在读文件之前：7000 个文件里通常只需要读几百个，
/// 先判掩码比先读再丢快一个量级。返回值第二项表示是否因为时间预算中途放弃。
fn collect_candidates(
    root: &Path,
    filter: &FileFilter,
    started: Instant,
) -> (Vec<(PathBuf, String)>, bool) {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if started.elapsed().as_millis() > TIME_BUDGET_MS {
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
fn scan_file(
    path: &Path,
    rel: &str,
    matcher: &Matcher,
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
    true
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
            max_results: 0,
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
        assert_eq!(files, vec!["build.xml", "gl/src/p/A.java", "gl/src/p/B.java"]);
        assert!(!truncated);
        let _ = std::fs::remove_dir_all(&dir);
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
    }
}
