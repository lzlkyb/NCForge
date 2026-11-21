//! 代码智能（jdt.ls）的会话状态与路径映射。纯逻辑，不依赖 tauri，可单测。
//!
//! 编辑器里打开的是工作副本里的真实文件，jdt.ls 看到的却是影子工程里的 junction 路径
//! （见 `shadow.rs`）。两边的 URI 只差一个前缀，所以：
//! - 发给 jdt.ls 之前：真实模块目录前缀 → 影子模块目录前缀；
//! - jdt.ls 返回之后：影子前缀 → 真实前缀（跳转结果、诊断才能在编辑器里打开真实文件）。
//!
//! 前缀由同一个 `lsp::path_to_uri` 生成，中文/空格的转义两边一致，所以直接做字符串替换。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::java_types::TypeCatalog;
use crate::lsp::{path_to_uri, LspClient};
use crate::nc_index::ClassIndex;

/// jdt.ls 默认堆上限（MB）。实测 gl 模块实际用 656MB。
pub const DEFAULT_XMX_MB: u32 = 1024;
/// 可设范围。下限：再小 jdt.ls 在 NC 工程上会频繁 OOM；上限：它不需要更多，设大了只会挤掉中间件的内存。
pub const XMX_MIN_MB: u32 = 512;
pub const XMX_MAX_MB: u32 = 4096;

/// 校验用户填的内存上限。
pub fn validate_xmx(mb: u32) -> Result<u32, String> {
    if (XMX_MIN_MB..=XMX_MAX_MB).contains(&mb) {
        Ok(mb)
    } else {
        Err(format!(
            "代码智能的内存上限要在 {XMX_MIN_MB}~{XMX_MAX_MB} MB 之间，当前填的是 {mb}"
        ))
    }
}

/// 语言服务当前状态，前端用 `lang-status` 事件与 `lang_status` 命令读取。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LangStatus {
    /// `stopped` / `starting`（拉起与影子工程生成）/ `indexing`（jdt.ls 在建索引）/ `ready` / `error`
    pub state: String,
    pub module: Option<String>,
    /// 给人看的一句话（进度原文或错误原因）。
    pub message: String,
    /// 进度百分比。jdt.ls 的 `language/status` 原文里带 `NN%` 或 `A/B` 时才填，
    /// 拿不到就是 `None`——**不编一个假的百分比**，UI 宁可只显示文字。
    pub progress: Option<u8>,
    /// 阶段中文短语（「启动服务」「导入工程」「建立索引」），由 [`stage_of`] 从原文归纳。
    /// 空串表示这一条状态不值得单独成句（比如 `ServiceReady`）。
    pub stage: String,
    pub source_files: usize,
    pub jar_count: usize,
}

impl LangStatus {
    pub fn stopped() -> Self {
        Self {
            state: "stopped".into(),
            module: None,
            message: String::new(),
            progress: None,
            stage: String::new(),
            source_files: 0,
            jar_count: 0,
        }
    }
}

/// 从 jdt.ls 的状态原文里取百分比。
///
/// 两种格式都见过：`"42% Starting Java Language Server"` 与 `"3/7 Importing projects"`。
/// 取不到就返回 `None`——让 UI 显示「正在建立索引…」而不是一个停在 0% 的假进度条。
pub fn parse_progress(message: &str) -> Option<u8> {
    let bytes = message.as_bytes();
    // NN%
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if bytes.get(i) == Some(&b'%') {
                let n: u32 = message[start..i].parse().ok()?;
                return Some(n.min(100) as u8);
            }
            // A/B
            if bytes.get(i) == Some(&b'/') {
                let done: u32 = message[start..i].parse().ok()?;
                let rest = &message[i + 1..];
                let end = rest
                    .char_indices()
                    .find(|(_, c)| !c.is_ascii_digit())
                    .map(|(k, _)| k)
                    .unwrap_or(rest.len());
                let total: u32 = rest[..end].parse().ok()?;
                // `checked_div` 同时兜住 total = 0：宁可不报进度，也不要一个 NaN/panic
                if let Some(pct) = done.saturating_mul(100).checked_div(total) {
                    return Some(pct.min(100) as u8);
                }
            }
            continue;
        }
        i += 1;
    }
    None
}

/// 把 jdt.ls 的英文阶段原文归纳成一句中文，前端直接拼在「代码智能：」后面。
///
/// 只做确定性关键词匹配，不猜：匹配不到就给空串，让 UI 退回通用文案。
pub fn stage_of(message: &str, kind: &str) -> String {
    if kind == "ServiceReady" {
        return String::new();
    }
    let m = message.to_ascii_lowercase();
    // 顺序有讲究：jdt.ls 在建索引时发的原文是
    // `"66% Starting Java Language Server - Refreshing '/bench'."`——
    // 它同时含 `Starting` 和 `Refreshing`，先判 `refreshing` 才说得对在干什么。
    let hit = if m.contains("refreshing") {
        "建立索引"
    } else if m.contains("import") {
        "导入工程"
    } else if m.contains("starting") || m.contains("start java") {
        "启动服务"
    } else if m.contains("build")
        || m.contains("workspace")
        || m.contains("index")
        || m.contains("search")
    {
        "建立索引"
    } else if m.contains("load") {
        "加载工程"
    } else {
        ""
    };
    hit.to_string()
}

/// 一次运行中的语言服务。
pub struct LangSession {
    pub client: LspClient,
    /// 前端语义上的「当前模块」。flat 下**不再决定映射**，只用于文案与补全目录。
    pub module: String,
    /// 真实目录 ↔ 影子目录。single 时 1 条；flat 时每个源码模块 1 条（实测 53 条）。
    roots: Vec<(PathBuf, PathBuf)>,
    /// 影子工程根（`.project` 所在目录）。flat 下是各模块影子目录的共同父目录。
    shadow_root: PathBuf,
    /// 由 `roots` 派生的 URI 前缀对，避免每次请求都重新格式化。
    pairs: Vec<PathPair>,
    pub completion_catalog: Option<(Arc<ClassIndex>, Arc<TypeCatalog>, PathBuf)>,
}

/// 由 `roots` 派生 URI 前缀对。顺序不影响匹配结果（`swap_one_multi` 取最长）。
fn pairs_of(roots: &[(PathBuf, PathBuf)]) -> Vec<PathPair> {
    roots
        .iter()
        .map(|(real, shadow)| PathPair::new(real, shadow))
        .collect()
}

impl LangSession {
    pub fn new(client: LspClient, module: &str, real_dir: &Path, shadow_dir: &Path) -> Self {
        let roots = vec![(real_dir.to_path_buf(), shadow_dir.to_path_buf())];
        Self {
            client,
            module: module.to_string(),
            pairs: pairs_of(&roots),
            shadow_root: shadow_dir.to_path_buf(),
            roots,
            completion_catalog: None,
        }
    }

    /// flat 形态：一个 jdt.ls 实例覆盖多个模块，映射表要按模块逐条登记。
    ///
    /// `roots` 为空时退化成 `new` 的签名语义（调用方不该传空，这里只是不 panic）。
    /// 影子工程根取第一条影子目录的父目录 —— flat 下所有模块影子都是它的子目录。
    pub fn with_roots(mut self, roots: Vec<(PathBuf, PathBuf)>) -> Self {
        if let Some((_, first_shadow)) = roots.first() {
            self.shadow_root = first_shadow
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| first_shadow.clone());
            self.pairs = pairs_of(&roots);
            self.roots = roots;
        }
        self
    }

    pub fn with_completion_catalog(
        mut self,
        index: Arc<ClassIndex>,
        catalog: Arc<TypeCatalog>,
        project_root: &Path,
    ) -> Self {
        self.completion_catalog = Some((index, catalog, project_root.to_path_buf()));
        self
    }

    pub fn module(&self) -> &str {
        &self.module
    }

    /// 影子工程根（`.project` 所在目录）。调试器要把源码根报给 java-debug。
    pub fn shadow_root(&self) -> &Path {
        &self.shadow_root
    }

    /// 真实文件路径 → 影子工程里的 URI。不在当前模块内返回 `Err`。
    pub fn shadow_uri_of(&self, real_path: &str) -> Result<String, String> {
        match find_root(&self.roots, real_path, false) {
            Some((shadow, rel)) => Ok(path_to_uri(&shadow.join(rel).to_string_lossy())),
            None => Err(format!("文件不在当前代码智能工程（{}）内", self.module)),
        }
    }

    /// 发给 jdt.ls 的消息：真实前缀 → 影子前缀。
    pub fn to_server(&self, v: &Value) -> Value {
        swap_prefix_multi(v, &self.pairs, true)
    }

    /// jdt.ls 返回的消息：影子前缀 → 真实前缀。
    pub fn from_server(&self, v: &Value) -> Value {
        swap_prefix_multi(v, &self.pairs, false)
    }

    /// 调试适配器返回的消息：`path` 字段里的影子目录路径 → 真实目录路径。
    ///
    /// DAP 的 `source.path` 是普通文件路径而不是 URI，`from_server` 换不到它，
    /// 栈帧点开就是影子 junction 里的那份副本（编辑器里的标签、断点都对不上）。
    pub fn from_server_paths(&self, v: &Value) -> Value {
        swap_path_fields_multi(v, &self.roots)
    }
}

/// 运行态：会话 + 状态。`AppState.lang` 持有。
pub struct LangRun {
    pub session: Option<Arc<LangSession>>,
    pub status: LangStatus,
    /// 当前实例服务的工作区根。flat 形态下一个实例覆盖全工作区，切模块时靠它判断
    /// 「要不要重启」——同工作区就复用，只有换工作区才重新拉起。
    /// `single` 形态下仍按模块重启，这两个字段一起决定（见 `lang_cmds::start_blocking`）。
    pub workspace: Option<PathBuf>,
    /// 每次拉起自增。进程退出回调据此判断「退出的是不是当前这一代」，
    /// 避免旧进程收尾时把刚起来的新会话误判成崩溃。
    pub generation: u64,
    /// 每次**停止请求**自增（不只成功停掉时才加，见 `cancel_epoch` 的注释）。
    ///
    /// `launch` 从生成影子工程到登记 session 有几秒窗口，这期间 `session` 还是 `None`：
    /// `stop_now` 摘不到东西、直接把状态置成 stopped 就返回了，而 launch 收尾时不复检
    /// 停止意图，照常登记 session 并把状态改成 indexing。结果是用户明确关了开关或换了
    /// 工作区，一个约 700MB 的 jdt.ls 还在跑，状态栏还说「正在建立索引」。
    /// 拉起时记下这个计数，登记前比一次，对不上就把刚起的 client 杀掉、不登记。
    pub cancel_epoch: u64,
}

impl Default for LangRun {
    fn default() -> Self {
        Self {
            session: None,
            status: LangStatus::stopped(),
            workspace: None,
            generation: 0,
            cancel_epoch: 0,
        }
    }
}

/// `path` 在 `base` 目录下的相对部分；不在其下返回 `None`。
///
/// Windows 路径不区分大小写，而前端传来的路径大小写取决于用户填的工作区根，
/// `base` 却是 canonicalize 后的真实大小写——用 `Path::strip_prefix` 会把大小写不同的同一目录当成不同目录，
/// 于是整个模块的文件都会被判成「不在模块里」，补全全部静默失效。
/// 只对 ASCII 折叠大小写（保持字节长度，返回的相对部分取自原路径）。
///
/// 返回的相对部分必须仍是「模块目录下的普通子路径」：`..` / `.` 段一律拒绝。
/// 调用方会把它拼到影子目录上（`shadow_dir.join(rel)`），放行 `..\..\x` 等于让
/// 前端指定的任意路径越过影子根，映射出的 URI 再发给 jdt.ls。
pub fn rel_under(base: &str, path: &str) -> Option<String> {
    let norm = |s: &str| s.trim_start_matches(r"\\?\").replace('/', "\\");
    let (b, p) = (norm(base), norm(path));
    let b = b.trim_end_matches('\\');
    let head = p.get(..b.len())?;
    if !head.eq_ignore_ascii_case(b) {
        return None;
    }
    let rest = &p[b.len()..];
    let rel = rest.strip_prefix('\\').filter(|r| !r.is_empty())?;
    if rel.split(['\\', '/']).any(|seg| seg == ".." || seg == ".") {
        return None;
    }
    Some(rel.to_string())
}

/// 一条「真实目录 ↔ 影子目录」的对应，两侧都是 **URI 前缀**（不带尾斜杠）。
///
/// single 模式下只有一条；flat 模式下每个源码模块一条（实测 53 条）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathPair {
    pub real: String,
    pub shadow: String,
}

impl PathPair {
    pub fn new(real_dir: &Path, shadow_dir: &Path) -> Self {
        Self {
            real: path_to_uri(&real_dir.to_string_lossy()),
            shadow: path_to_uri(&shadow_dir.to_string_lossy()),
        }
    }
}

/// 多前缀映射：按**最长前缀**选一条 `PathPair` 再做头替换。
///
/// 为什么必须最长优先：模块名之间存在前缀关系（实测工作区里有 `gl` 与 `gl2`、
/// `ic` 与 `ic-*`）。若按声明顺序取第一条，`file:///…/ws/gl2/A.java` 会被
/// `gl` 这条误命中——`swap_head` 的「rest 必须以 `/` 开头」保护在这里不成立，
/// 因为 `gl2` 的 rest 是 `2/A.java`，本来就过不了；真正的风险是
/// **同一个影子目录被两条规则都能解释**的嵌套布局（`ws` 与 `ws/gl` 都建了链接）。
///
/// 语义与 `swap_prefix` 完全一致：只换字符串值的开头与对象的键，不动正文。
pub fn swap_prefix_multi(v: &Value, pairs: &[PathPair], to_shadow: bool) -> Value {
    match v {
        Value::String(s) => Value::String(swap_one_multi(s, pairs, to_shadow)),
        Value::Array(a) => Value::Array(
            a.iter()
                .map(|x| swap_prefix_multi(x, pairs, to_shadow))
                .collect(),
        ),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| {
                    (
                        swap_one_multi(k, pairs, to_shadow),
                        swap_prefix_multi(x, pairs, to_shadow),
                    )
                })
                .collect(),
        ),
        _ => v.clone(),
    }
}

/// 单个字符串的多前缀替换。没有命中原样返回。
fn swap_one_multi(s: &str, pairs: &[PathPair], to_shadow: bool) -> String {
    let mut best: Option<(usize, &str)> = None; // (前缀长度, 目标前缀)
    for p in pairs {
        let (from, to) = if to_shadow {
            (p.real.as_str(), p.shadow.as_str())
        } else {
            (p.shadow.as_str(), p.real.as_str())
        };
        let Some(rest) = s.strip_prefix(from) else {
            continue;
        };
        // 与 `swap_head` 同一条边界规则：前缀之后必须是 `/` 或结束。
        if !(rest.is_empty() || rest.starts_with('/')) {
            continue;
        }
        // 不用 `is_none_or`：它要 Rust 1.82+，而本项目的 MSRV 没定那么高。
        let better = match best {
            Some((n, _)) => from.len() > n,
            None => true,
        };
        if better {
            best = Some((from.len(), to));
        }
    }
    match best {
        Some((n, to)) => format!("{to}{}", &s[n..]),
        None => s.to_string(),
    }
}

/// 把 JSON 里所有以 `from` 开头的 URI 字符串换成 `to` 开头。
///
/// 只换「字符串值的开头」，不会动正文里碰巧出现的同样文字（比如源码里写着一个 file:/// 路径）。
/// 对象的**键**也要换：`WorkspaceEdit.changes` 的键就是文件 URI，
/// 漏掉的话编辑清单里每个文件仍停在影子路径上——前端按真实路径找 model、
/// 找标签页全部落空，表现是「改了但哪儿也看不见」，重命名的预览也会列出影子目录。
pub fn swap_prefix(v: &Value, from: &str, to: &str) -> Value {
    match v {
        Value::String(s) => Value::String(swap_head(s, from, to)),
        Value::Array(a) => Value::Array(a.iter().map(|x| swap_prefix(x, from, to)).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| (swap_head(k, from, to), swap_prefix(x, from, to)))
                .collect(),
        ),
        _ => v.clone(),
    }
}

/// 把 JSON 里所有名为 `path` 的字符串字段，从 `from_dir` 目录下换到 `to_dir` 目录下。
///
/// 只认 `path` 键（DAP 的 `Source.path`），其它字符串不动；大小写、斜杠风格不敏感，
/// 含 `..` 的路径不换（见 `rel_under`）。
/// 单模块版路径字段映射 —— 现在只给单测当「一条特例」的回归基线用，
/// 生产走 `swap_path_fields_multi`（`LangSession::from_server_paths`）。
#[cfg(test)]
fn swap_path_fields(v: &Value, from_dir: &Path, to_dir: &Path) -> Value {
    // 参数方向是 (影子, 真实)，而 `roots` 存 (真实, 影子)，这里刻意反过来传。
    swap_path_fields_multi(v, &[(to_dir.to_path_buf(), from_dir.to_path_buf())])
}

/// 多模块版本：`path` 字段按**最长影子前缀**换回对应模块的真实目录。
///
/// 单模块（single 模式）时与旧实现逐字节等价 —— 旧实现就是它的 1 条特例。
fn swap_path_fields_multi(v: &Value, roots: &[(PathBuf, PathBuf)]) -> Value {
    match v {
        Value::Array(a) => {
            Value::Array(a.iter().map(|x| swap_path_fields_multi(x, roots)).collect())
        }
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| {
                    let swapped = match (k.as_str(), x) {
                        ("path", Value::String(s)) => map_one_path(s, roots),
                        _ => swap_path_fields_multi(x, roots),
                    };
                    (k.clone(), swapped)
                })
                .collect(),
        ),
        _ => v.clone(),
    }
}

/// 把一个影子路径换到它所属模块的真实目录下；不属于任何模块则原样返回。
fn map_one_path(s: &str, roots: &[(PathBuf, PathBuf)]) -> Value {
    match find_root(roots, s, true) {
        Some((real, rel)) => {
            // rel_under 只做字符串替换，返回的相对部分始终是反斜杠分隔。
            // 直接 Path::join 在 unix 上会拼出 `…/gl\src\A.java` 这种混斜杠路径，
            // 这里先换回本平台的分隔符再拼。
            let rel = rel.replace('\\', std::path::MAIN_SEPARATOR_STR);
            Value::String(real.join(rel).to_string_lossy().into_owned())
        }
        None => Value::String(s.to_string()),
    }
}

/// 在 `roots` 里按**最长前缀**找 `path` 属于哪一条，返回（对侧目录, 相对路径）。
///
/// `from_shadow = true` 表示 `path` 是影子侧路径，返回真实目录；反之返回影子目录。
/// 最长优先是必需的：flat 下 53 条前缀里存在嵌套（工作区根与某个模块目录都登记过）。
fn find_root<'a>(
    roots: &'a [(PathBuf, PathBuf)],
    path: &str,
    from_shadow: bool,
) -> Option<(&'a PathBuf, String)> {
    let mut best: Option<(usize, &PathBuf, String)> = None;
    for (real, shadow) in roots {
        let (base, target) = if from_shadow {
            (shadow, real)
        } else {
            (real, shadow)
        };
        let base_s = base.to_string_lossy();
        let Some(rel) = rel_under(&base_s, path) else {
            continue;
        };
        let better = match best {
            Some((n, _, _)) => base_s.len() > n,
            None => true,
        };
        if better {
            best = Some((base_s.len(), target, rel));
        }
    }
    best.map(|(_, target, rel)| (target, rel))
}

/// 字符串开头是 `from` 就换成 `to` 开头，否则原样返回。
///
/// 前缀后必须是结尾或 `/`，否则 `…/gl` 会误伤同名前缀的 `…/gl2`。
fn swap_head(s: &str, from: &str, to: &str) -> String {
    match s.strip_prefix(from) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{to}{rest}"),
        _ => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 进度只认原文里真的有的数字。jdt.ls 0.57 实测发的是
    /// `"66% Starting Java Language Server - Refreshing '/bench'."`，所以 `NN%` 是主路。
    #[test]
    fn 进度只从原文里的数字取() {
        assert_eq!(parse_progress("0% Starting Java Language Server"), Some(0));
        assert_eq!(
            parse_progress("66% Starting Java Language Server - Refreshing '/bench'."),
            Some(66)
        );
        assert_eq!(parse_progress("100% Starting"), Some(100));
        // 分数式：jdt.ls 换版本后可能改成这种写法，两种都认
        assert_eq!(parse_progress("3/7 Importing projects"), Some(42));
        // 没有数字就是不编：宁可 UI 只显示「正在建立索引…」
        assert_eq!(parse_progress("ServiceReady"), None);
        assert_eq!(parse_progress(""), None);
        // 超过 100 的脏值要夹住，不能让进度条溢出
        assert_eq!(parse_progress("120% weird"), Some(100));
    }

    /// 阶段文案的判据是「先看 Refreshing」：jdt.ls 建索引时那句话里
    /// 也含 `Starting`，先判 Starting 会把索引说成「启动服务」。
    #[test]
    fn 阶段文案先认_refreshing_再认_starting() {
        assert_eq!(
            stage_of(
                "66% Starting Java Language Server - Refreshing '/bench'.",
                "Starting"
            ),
            "建立索引"
        );
        assert_eq!(
            stage_of("20% Starting Java Language Server", "Starting"),
            "启动服务"
        );
        // ServiceReady 不值得单独成句：状态已经变 ready 了
        assert_eq!(stage_of("ServiceReady", "ServiceReady"), "");
        // 完全不认识的原文：给空串，让前端退回通用文案
        assert_eq!(stage_of("Something else", "Message"), "");
    }

    #[test]
    fn rel_under_ignores_case_and_separator_style() {
        let base = r"C:\work\aier\newar\gl";
        assert_eq!(
            rel_under(base, r"C:\work\aier\newar\gl\src\A.java").as_deref(),
            Some(r"src\A.java")
        );
        // 盘符、目录大小写不同，正斜杠混用，都算同一个模块
        assert_eq!(
            rel_under(base, "c:/Work/AIER/Newar/GL/src/A.java").as_deref(),
            Some(r"src\A.java")
        );
        // 带扩展长度前缀、base 带尾部斜杠
        assert_eq!(
            rel_under(
                r"C:\work\aier\newar\gl\",
                r"\\?\C:\work\aier\newar\gl\x\B.java"
            )
            .as_deref(),
            Some(r"x\B.java")
        );
        // 同名前缀的另一个模块、模块目录本身、完全无关的路径，都不算
        assert_eq!(rel_under(base, r"C:\work\aier\newar\gl2\src\A.java"), None);
        assert_eq!(rel_under(base, r"C:\work\aier\newar\gl"), None);
        assert_eq!(rel_under(base, r"D:\other\A.java"), None);
        // 非 ASCII 路径不会在字符边界上切坏
        assert_eq!(
            rel_under(r"C:\工作", r"C:\工作\a.java").as_deref(),
            Some("a.java")
        );
        assert_eq!(rel_under(r"C:\工作", r"C:\工"), None);
    }

    /// 相对部分会被拼到影子目录上，`..` 必须在这里就被拒——否则前端给一个
    /// `<模块>\..\..\x.java` 就能让映射出的影子 URI 越过影子根。
    #[test]
    fn rel_under_rejects_parent_segments() {
        let base = r"C:\work\aier\newar\gl";
        assert_eq!(
            rel_under(base, r"C:\work\aier\newar\gl\..\..\evil.java"),
            None
        );
        assert_eq!(
            rel_under(base, r"C:\work\aier\newar\gl\src\..\A.java"),
            None
        );
        assert_eq!(rel_under(base, "C:/work/aier/newar/gl/src/../../x"), None);
        assert_eq!(rel_under(base, r"C:\work\aier\newar\gl\.\A.java"), None);
        // 文件名里带两个点不是父目录段，不能误杀
        assert_eq!(
            rel_under(base, r"C:\work\aier\newar\gl\src\Foo..java").as_deref(),
            Some(r"src\Foo..java")
        );
    }

    #[test]
    fn xmx_range_is_enforced_at_both_ends() {
        assert_eq!(validate_xmx(1024), Ok(1024));
        assert_eq!(validate_xmx(XMX_MIN_MB), Ok(XMX_MIN_MB));
        assert_eq!(validate_xmx(XMX_MAX_MB), Ok(XMX_MAX_MB));
        assert!(validate_xmx(XMX_MIN_MB - 1).is_err());
        assert!(validate_xmx(XMX_MAX_MB + 1).is_err());
        assert!(validate_xmx(0).is_err());
    }

    #[test]
    fn swap_prefix_only_touches_string_heads() {
        let v = json!({
            "uri": "file:///C:/ws/gl/A.java",
            "list": [{ "targetUri": "file:///C:/ws/gl/B.java" }, "jdt://contents/x"],
            // 正文里出现同样文字，不在开头，不能被替换
            "text": "路径是 file:///C:/ws/gl/A.java 这个",
            "n": 3
        });
        let out = swap_prefix(&v, "file:///C:/ws/gl", "file:///D:/shadow/gl");
        assert_eq!(out["uri"], "file:///D:/shadow/gl/A.java");
        assert_eq!(out["list"][0]["targetUri"], "file:///D:/shadow/gl/B.java");
        assert_eq!(out["list"][1], "jdt://contents/x");
        assert_eq!(out["text"], "路径是 file:///C:/ws/gl/A.java 这个");
        assert_eq!(out["n"], 3);
        // 同名前缀的另一个模块不能被误换
        let other = json!({ "uri": "file:///C:/ws/gl2/A.java" });
        assert_eq!(
            swap_prefix(&other, "file:///C:/ws/gl", "file:///D:/s/gl"),
            other
        );
    }

    /// 影子目录 → 真实路径的映射（DAP `Source.path`）。
    ///
    /// 路径字面量随平台走：`rel_under` 只做字符串替换，拼回目标目录时才用**本平台**分隔符，
    /// 所以 Windows 得到 `D:\ws\gl\src\A.java`，unix 得到 `/ws/gl/src/A.java`。
    /// 早先这里写死 Windows 字面量，一上 macOS CI 两个 assert 全红。
    #[test]
    fn swap_path_fields_maps_stack_frame_sources_back_to_real() {
        let (shadow, real, outside) = if cfg!(windows) {
            (r"C:\data\shadow\gl", r"D:\ws\gl", r"E:\other\C.java")
        } else {
            ("/data/shadow/gl", "/ws/gl", "/other/C.java")
        };
        let under = |base: &str, rest: &str| {
            let sep = std::path::MAIN_SEPARATOR_STR;
            format!("{base}{sep}{}", rest.replace('/', sep))
        };
        let v = json!({
            "stackFrames": [
                { "id": 1, "name": "A.run", "source": { "path": under(shadow, "src/private/A.java") } },
                // 正斜杠写法（两个平台上都是分隔符）也要换
                { "id": 2, "source": { "path": format!("{shadow}/src/B.java") } },
                // 不在影子里（平台类、无源码帧）原样保留
                { "id": 3, "source": { "path": outside } },
                { "id": 4, "name": under(shadow, "src/D.java") }
            ]
        });
        let out = swap_path_fields(&v, Path::new(shadow), Path::new(real));
        assert_eq!(
            out["stackFrames"][0]["source"]["path"],
            under(real, "src/private/A.java")
        );
        assert_eq!(
            out["stackFrames"][1]["source"]["path"],
            under(real, "src/B.java")
        );
        assert_eq!(out["stackFrames"][2]["source"]["path"], outside);
        // 只换 path 键，别的字段里碰巧是影子路径的文字不动
        assert_eq!(out["stackFrames"][3]["name"], under(shadow, "src/D.java"));
    }

    /// Windows 路径不区分大小写：前端填的工作区根与 canonicalize 后的大小写不同，
    /// 也得认成同一个目录（否则整个模块的补全静默失效，见 `rel_under`）。
    #[cfg(windows)]
    #[test]
    fn swap_path_fields_matches_case_insensitively() {
        let v = json!({ "path": r"c:/DATA/shadow/GL\src\B.java" });
        let out = swap_path_fields(&v, Path::new(r"C:\data\shadow\gl"), Path::new(r"D:\ws\gl"));
        assert_eq!(out["path"], r"D:\ws\gl\src\B.java");
    }

    #[test]
    fn swap_path_fields_ignores_sibling_dir_and_parent_segments() {
        let shadow = Path::new(r"C:\data\shadow\gl");
        let real = Path::new(r"D:\ws\gl");
        let v = json!({ "a": { "path": r"C:\data\shadow\gl2\x.java" },
                        "b": { "path": r"C:\data\shadow\gl\..\..\evil.java" } });
        let out = swap_path_fields(&v, shadow, real);
        assert_eq!(out, v);
    }

    /// `WorkspaceEdit.changes` 的键就是文件 URI：值换了、键没换，前端按真实路径
    /// 找 model 会全部落空（重命名的预览也会列出影子目录）。
    #[test]
    fn swap_prefix_rewrites_uri_keys() {
        let v = json!({
            "changes": {
                "file:///C:/ws/gl/A.java": [],
                "file:///C:/ws/gl2/B.java": [],
                "jdt://contents/x.jar/A.class": []
            }
        });
        let out = swap_prefix(&v, "file:///C:/ws/gl", "file:///D:/s/gl");
        let keys: Vec<&str> = out["changes"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert!(keys.contains(&"file:///D:/s/gl/A.java"), "{keys:?}");
        // 同名前缀的另一个模块、以及不是 file 协议的键都原样保留
        assert!(keys.contains(&"file:///C:/ws/gl2/B.java"), "{keys:?}");
        assert!(keys.contains(&"jdt://contents/x.jar/A.class"), "{keys:?}");
    }

    #[test]
    fn swap_prefix_roundtrips_with_chinese_paths() {
        let real = path_to_uri(r"C:\work\aier\newar\总账 gl");
        let shadow = path_to_uri(r"D:\data\shadow\总账 gl");
        let v = json!({ "uri": format!("{real}/src/Step4View.java") });
        let there = swap_prefix(&v, &real, &shadow);
        assert!(there["uri"].as_str().unwrap().starts_with(&shadow));
        assert_eq!(swap_prefix(&there, &shadow, &real), v);
    }

    /// flat 形态：多个模块各自一条前缀，全部要能双向映射，且不串台。
    #[test]
    fn swap_prefix_multi_maps_every_module() {
        let mods = ["gl", "gl2", "ic", "ic-extra", "ar"];
        let pairs: Vec<PathPair> = mods
            .iter()
            .map(|m| PathPair {
                real: format!("file:///C:/ws/{m}"),
                shadow: format!("file:///D:/s/{m}"),
            })
            .collect();
        for m in mods {
            let real = json!({ "uri": format!("file:///C:/ws/{m}/src/A.java") });
            let to_shadow = swap_prefix_multi(&real, &pairs, true);
            assert_eq!(
                to_shadow["uri"],
                format!("file:///D:/s/{m}/src/A.java"),
                "{m} 去程"
            );
            assert_eq!(
                swap_prefix_multi(&to_shadow, &pairs, false),
                real,
                "{m} 回程"
            );
        }
    }

    /// 前缀存在包含关系时必须取最长的那条。
    ///
    /// 布局刻意让两条给出**不同**结果，否则测不出优先级：
    /// 短前缀 → `D:/s/gl/src/A.java`，长前缀 → `E:/gl-shadow/src/A.java`。
    #[test]
    fn swap_prefix_multi_prefers_longest_prefix() {
        let pairs = vec![
            PathPair {
                real: "file:///C:/ws".into(),
                shadow: "file:///D:/s".into(),
            },
            PathPair {
                real: "file:///C:/ws/gl".into(),
                shadow: "file:///E:/gl-shadow".into(),
            },
        ];
        let v = json!({ "uri": "file:///C:/ws/gl/src/A.java" });
        let out = swap_prefix_multi(&v, &pairs, true);
        assert_eq!(out["uri"], "file:///E:/gl-shadow/src/A.java");
    }

    /// `gl` 不能吃掉 `gl2` —— 前缀之后必须是 `/` 或结束。
    #[test]
    fn swap_prefix_multi_does_not_confuse_sibling_prefixes() {
        let pairs = vec![PathPair {
            real: "file:///C:/ws/gl".into(),
            shadow: "file:///D:/s/gl".into(),
        }];
        let sibling = json!({ "uri": "file:///C:/ws/gl2/A.java" });
        assert_eq!(swap_prefix_multi(&sibling, &pairs, true), sibling);
    }

    /// `find_root` 是 `shadow_uri_of` 与 DAP 路径映射的共同底座。
    #[test]
    fn find_root_picks_longest_and_rejects_outsiders() {
        let roots = vec![
            (PathBuf::from("D:/ws"), PathBuf::from("D:/s")),
            (PathBuf::from("D:/ws/gl"), PathBuf::from("E:/gl-shadow")),
        ];
        let (shadow, rel) = find_root(&roots, "D:/ws/gl/src/A.java", false).expect("应命中长前缀");
        assert_eq!(shadow, &PathBuf::from("E:/gl-shadow"));
        assert_eq!(rel, "src\\A.java");
        let (real, _) =
            find_root(&roots, "E:/gl-shadow/src/A.java", true).expect("影子侧应命中最长");
        assert_eq!(real, &PathBuf::from("D:/ws/gl"));
        assert!(find_root(&roots, "F:/other/A.java", false).is_none());
    }
}
