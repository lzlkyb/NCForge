//! 热替换：把自动编译产出的 class 换进运行中的 NC JVM。
//!
//! 方案见 `docs/NCForge-热替换-方案设计-2026-11-06.md`。本模块是纯逻辑（不含 tauri 类型），
//! 目前只管「启动时挂上 agent」这一步（批 A）：
//!
//! - agent 本体是 `src-tauri/hotswap-agent/HotswapAgent.java`，由
//!   `node scripts/build-bridge-jar.mjs hotswap` 打成 `resources/hotswap/ncforge-hotswap.jar`，随安装包走。
//! - 启动参数只带「会话文件」路径；**令牌只在会话文件里**，不进命令行（进程列表、命令行预览
//!   都看得到命令行）。agent 绑 127.0.0.1 的系统分配端口，写进「会话文件.ready」。
//! - 每次启动换一个新令牌并删掉旧的 `.ready`：否则轮询到的可能是上一个 JVM 留下的端口。
//!
//! 批 B 加上推送客户端：编译成功后把「类名 + class 文件 + 产物根目录」打成一批（[`Batch`]），
//! 读就绪文件拿端口、读会话文件拿令牌，发给 agent，把回复整理成 [`Report`]。
//! 「服务没跑 / 没挂 agent / 连不上」都是常态，统一归为 `unavailable`，调用方静默即可。
//!
//! 动态挂载（批 F）之后也放在这里。

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// agent jar 文件名（编译自 `src-tauri/hotswap-agent/HotswapAgent.java`）。
pub const JAR_NAME: &str = "ncforge-hotswap.jar";

/// 与 agent 的 `HotswapAgent.PROTOCOL` 一致；不一致说明 JVM 里是旧版 agent，要重启才能升级。
pub const PROTOCOL: u32 = 1;

/// 会话文件所在目录：`<配置目录>/hotswap`。
pub fn session_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("hotswap")
}

/// 工作台自己启动的中间件用的会话文件。动态挂载到别的 JVM 时另建按 pid 命名的文件（批 F）。
pub fn launch_session_file(config_dir: &Path) -> PathBuf {
    session_dir(config_dir).join("launch.properties")
}

/// agent 写出的就绪文件：会话文件名后加 `.ready`。
pub fn ready_file(session: &Path) -> PathBuf {
    let mut s = session.as_os_str().to_owned();
    s.push(".ready");
    PathBuf::from(s)
}

/// 按顺序在候选目录里找 agent jar（安装包资源目录 → 源码树）。
///
/// 找不到不是错误：热替换是锦上添花，调用方记一行日志后照常启动。
pub fn find_jar(dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(JAR_NAME)).find(|p| p.is_file())
}

/// 生成 32 位十六进制令牌。
///
/// 不引随机数 crate：`getrandom` 0.3+ 在本机 Windows 上会因缺 `ProcessPrng` 导出启动即挂
/// （见项目记忆）。`RandomState` 的种子来自系统随机源，每个实例不同，再混入时间、pid
/// 与进程内计数。令牌只用于本机回环端口鉴权，强度足够。
pub fn new_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let half = |salt: u64| {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(nanos);
        h.write_u32(std::process::id());
        h.write_u64(seq);
        h.write_u64(salt);
        h.finish()
    };
    format!("{:016x}{:016x}", half(1), half(2))
}

/// 写会话文件（`token=...`）并删掉旧的就绪文件。
///
/// 先删 `.ready` 再写令牌：顺序反过来的话，新 JVM 还没起来时读到的是「旧端口 + 新令牌」，
/// 连过去只会得到一个让人困惑的鉴权失败。
pub fn write_session(session: &Path, token: &str) -> Result<(), String> {
    if let Some(dir) = session.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("创建热替换会话目录失败（{}）：{e}", dir.display()))?;
    }
    match std::fs::remove_file(ready_file(session)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("清理旧的热替换就绪文件失败：{e}")),
    }
    crate::atomic_file::write_atomic(session, format!("token={token}\n").as_bytes())
}

/// 拼 `-javaagent:<jar>=<会话文件>`。
///
/// JVM 按**第一个** `=` 切分 jar 路径与参数，jar 路径里带 `=` 会被截断成一个不存在的文件，
/// 而启动参数里的 agent 加载失败会让整个 JVM 起不来——所以这里先拦住。
pub fn javaagent_arg(jar: &Path, session: &Path) -> Result<String, String> {
    let j = jar.to_string_lossy();
    if j.contains('=') {
        return Err(format!("热替换 agent 路径里有等号，JVM 无法解析：{j}"));
    }
    Ok(format!("-javaagent:{j}={}", session.to_string_lossy()))
}

/// 启动 / 预览共用：算出要追加的 `-javaagent` 参数。
///
/// - `enabled=false` 或找不到 jar → `Ok(None)`（按不挂 agent 启动）；
/// - `write=true`（真启动）→ 换新令牌、清旧就绪文件；`write=false`（命令行预览）只算参数，
///   不碰磁盘——预览要是顺手换了令牌，正在跑的 JVM 就再也连不上了。
pub fn launch_agent_arg(
    config_dir: &Path,
    jar: Option<&Path>,
    enabled: bool,
    write: bool,
) -> Result<Option<String>, String> {
    let Some(jar) = jar.filter(|_| enabled) else {
        return Ok(None);
    };
    let session = launch_session_file(config_dir);
    if write {
        write_session(&session, &new_token())?;
    }
    javaagent_arg(jar, &session).map(Some)
}

// ────────────────────────── 批 B：推送 ──────────────────────────

/// 一个待替换的类。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassItem {
    /// 二进制名，如 `nc.bs.Foo$1`。
    pub name: String,
    pub file: PathBuf,
}

/// 一批待替换的类及其产物根目录。
///
/// agent 只替换 codeSource 正好是这些根目录的类，其余报「被遮蔽」，所以根目录必须是编译真正写入的产物目录（`ModuleLayout::output_for`），不能用模块根代替。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Batch {
    pub roots: Vec<PathBuf>,
    pub classes: Vec<ClassItem>,
}

impl Batch {
    pub fn is_empty(&self) -> bool {
        self.classes.is_empty()
    }

    fn add_root(&mut self, root: &Path) {
        if !self
            .roots
            .iter()
            .any(|r| crate::build_layout::eq_path(r, root))
        {
            self.roots.push(root.to_path_buf());
        }
    }

    fn add_class(&mut self, item: ClassItem) {
        if !self
            .classes
            .iter()
            .any(|c| c.name == item.name && crate::build_layout::eq_path(&c.file, &item.file))
        {
            self.classes.push(item);
        }
    }

    /// 一个源文件编译后的产物：`Outer.class` + `Outer$*.class`（与清单的映射口径一致）。
    ///
    /// 同文件里的次要顶层类（`class Foo` 旁边的 `class Helper`）映射不到，会漏推；
    /// NC 二开里几乎没有这种写法，漏了的类重启后一样生效。
    pub fn add_source(&mut self, out_dir: &Path, package: &str, source: &Path) {
        let rels = crate::build_state::classes_for_source(out_dir, package, source);
        if rels.is_empty() {
            return;
        }
        self.add_root(out_dir);
        for rel in rels {
            let name = rel.trim_end_matches(".class").replace('/', ".");
            let file = out_dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            self.add_class(ClassItem { name, file });
        }
    }

    pub fn merge(&mut self, other: Batch) {
        for r in &other.roots {
            self.add_root(r);
        }
        for c in other.classes {
            self.add_class(c);
        }
    }
}

/// agent 写出的就绪文件内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ready {
    pub port: u16,
    pub pid: String,
    pub protocol: u32,
}

pub fn parse_ready(text: &str) -> Option<Ready> {
    let mut port = None;
    let mut pid = None;
    let mut protocol = None;
    for line in text.lines() {
        match line.split_once('=') {
            Some(("port", v)) => port = v.trim().parse().ok(),
            Some(("pid", v)) => pid = Some(v.trim().to_string()),
            Some(("protocol", v)) => protocol = v.trim().parse().ok(),
            _ => {}
        }
    }
    Some(Ready {
        port: port.filter(|p| *p > 0)?,
        pid: pid?,
        protocol: protocol?,
    })
}

pub fn read_ready(session: &Path) -> Option<Ready> {
    parse_ready(&std::fs::read_to_string(ready_file(session)).ok()?)
}

/// 读会话文件里的令牌（与 agent 同一口径：至少 16 位）。
pub fn read_token(session: &Path) -> Option<String> {
    let text = std::fs::read_to_string(session).ok()?;
    text.lines()
        .find_map(|l| l.strip_prefix("token="))
        .map(|t| t.trim().to_string())
        .filter(|t| t.len() >= 16)
}

/// 拼一个请求（协议见 `HotswapAgent` 头注释）。
pub fn request_text(token: &str, op: &str, batch: Option<&Batch>) -> String {
    let mut s = format!("NCFORGE-HOTSWAP {PROTOCOL}\ntoken {token}\nop {op}\n");
    if let Some(b) = batch {
        for r in &b.roots {
            s.push_str(&format!("root {}\n", r.display()));
        }
        for c in &b.classes {
            s.push_str(&format!("class {}\t{}\n", c.name, c.file.display()));
        }
    }
    s.push_str("end\n");
    s
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub name: String,
    pub loader: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shadowed {
    pub name: String,
    pub loader: String,
    /// 实际加载来源目录；来自 jar 或启动类加载器时为空。
    pub source: String,
}

/// agent 的回复（成功与失败共用，缺的字段取默认值）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentReply {
    pub ok: bool,
    pub code: Option<String>,
    pub message: Option<String>,
    pub redefined: Vec<Loaded>,
    pub not_loaded: Vec<String>,
    pub shadowed: Vec<Shadowed>,
    pub elapsed_ms: u64,
    pub protocol: Option<u32>,
}

/// 连接超时：本机回环，连不上就是没在听，不必等。
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
/// 回复上限：几百个类的结果也到不了 1MB，超过就当异常截断。
const MAX_REPLY: u64 = 1 << 20;

/// 发一个请求、收一行 JSON。只连 127.0.0.1。
pub fn send(port: u16, text: &str, timeout: Duration) -> Result<AgentReply, String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = std::net::TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("连不上热替换 agent（127.0.0.1:{port}）：{e}"))?;
    s.set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    s.set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    s.write_all(text.as_bytes())
        .map_err(|e| format!("发送热替换请求失败：{e}"))?;
    let mut buf = String::new();
    s.take(MAX_REPLY)
        .read_to_string(&mut buf)
        .map_err(|e| format!("读取热替换回复失败：{e}"))?;
    serde_json::from_str(buf.trim()).map_err(|e| format!("热替换回复不是 JSON（{e}）：{buf}"))
}

/// 一次推送的结果，原样发给前端（`hotswap-result` 事件 / `hotswap_status`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// `ok` 全部按预期；`partial` 替换成功但有类被遮蔽；`failed` agent 拒绝（整批未生效）；
    /// `unavailable` 服务没跑 / 没挂 agent / 连不上（常态，调用方通常静默）。
    pub state: &'static str,
    pub at_ms: u64,
    /// 本批请求替换的类数。
    pub requested: usize,
    pub redefined: Vec<Loaded>,
    pub not_loaded: Vec<String>,
    pub shadowed: Vec<Shadowed>,
    /// 失败码（与 agent 一致：`unsupported` / `verify` / `auth` / `protocol` …）。
    pub code: Option<String>,
    pub message: Option<String>,
    /// 工作台侧往返耗时。
    pub elapsed_ms: u64,
    /// 本批请求替换的类名。失败时 `redefined` 是空的，要靠它判断「后来的成功是否覆盖了失败的那批」。
    pub requested_names: Vec<String>,
}

impl Report {
    fn new(requested: usize) -> Self {
        Self {
            state: "ok",
            at_ms: crate::build_state::now_ms(),
            requested,
            redefined: Vec::new(),
            not_loaded: Vec::new(),
            shadowed: Vec::new(),
            code: None,
            message: None,
            elapsed_ms: 0,
            requested_names: Vec::new(),
        }
    }

    /// 把「服务活着、就绪文件在，却送不到 agent」从静默的 `unavailable` 升级成可见的失败。
    /// 此时磁盘上的 class 已经更新而 JVM 里还是旧的，和 agent 拒绝是同一种后果。
    pub fn escalate(mut self) -> Self {
        self.state = "failed";
        self
    }

    fn fail(mut self, state: &'static str, code: Option<String>, message: String) -> Self {
        self.state = state;
        self.code = code;
        self.message = Some(message);
        self
    }

    /// 这次之后「运行中的代码不是最新」：整批被拒，或有类被遮蔽没换。
    pub fn makes_stale(&self) -> bool {
        self.state == "failed" || !self.shadowed.is_empty()
    }

    /// 写进服务日志的一行（翻日志时能对上「这次请求之前换没换过代码」）。
    /// 与启动阶段的分隔行同一前缀 `[nc-forge]`。
    pub fn log_line(&self) -> String {
        let names = |v: &mut dyn Iterator<Item = &str>| -> String {
            let all: Vec<&str> = v.collect();
            let head = all.iter().take(5).copied().collect::<Vec<_>>().join(", ");
            if all.len() > 5 {
                format!("{head} 等 {} 个", all.len())
            } else {
                head
            }
        };
        let body = match self.state {
            "ok" => format!(
                "已替换 {} 个类 ({})",
                self.redefined.len(),
                names(&mut self.redefined.iter().map(|c| c.name.as_str()))
            ),
            "partial" => format!(
                "部分生效：替换 {} 个类，{} 个被遮挡 ({})",
                self.redefined.len(),
                self.shadowed.len(),
                names(&mut self.shadowed.iter().map(|c| c.name.as_str()))
            ),
            _ => format!(
                "失败，本批 {} 个类未应用：{}",
                self.requested,
                self.message.as_deref().unwrap_or("未知原因")
            ),
        };
        format!("[nc-forge] 热替换 {body} · {} ms\n", self.elapsed_ms)
    }
}

/// 把一批类推给会话对应的 agent。阻塞，最坏约 1.5 s 连接 + 30 s 读；调用方放后台线程。
pub fn push(session: &Path, batch: &Batch) -> Report {
    let t0 = std::time::Instant::now();
    let mut report = Report::new(batch.classes.len());
    report.requested_names = batch.classes.iter().map(|c| c.name.clone()).collect();
    let mut report = match (read_ready(session), read_token(session)) {
        (None, _) => report.fail(
            "unavailable",
            None,
            "服务没有在运行，或启动时没有挂热替换 agent".into(),
        ),
        (Some(r), _) if r.protocol != PROTOCOL => report.fail(
            "failed",
            Some("protocol".into()),
            format!(
                "运行中的热替换 agent 是协议 {}，工作台是 {PROTOCOL}：重启服务后生效",
                r.protocol
            ),
        ),
        (Some(_), None) => report.fail(
            "unavailable",
            Some("session".into()),
            "热替换会话文件缺失或损坏".into(),
        ),
        (Some(r), Some(token)) => {
            let text = request_text(&token, "redefine", Some(batch));
            match send(r.port, &text, Duration::from_secs(30)) {
                Err(e) => report.fail("unavailable", Some("unreachable".into()), e),
                Ok(rep) if !rep.ok => report.fail(
                    "failed",
                    rep.code,
                    rep.message.unwrap_or_else(|| "agent 拒绝了这次替换".into()),
                ),
                Ok(rep) => {
                    let mut ok = report;
                    ok.state = if rep.shadowed.is_empty() {
                        "ok"
                    } else {
                        "partial"
                    };
                    ok.redefined = rep.redefined;
                    ok.not_loaded = rep.not_loaded;
                    ok.shadowed = rep.shadowed;
                    ok
                }
            }
        }
    };
    report.elapsed_ms = t0.elapsed().as_millis() as u64;
    report
}

/// agent 是否在线（就绪文件存在、协议一致、ping 通）。用于状态显示，超时很短。
pub fn ping(session: &Path) -> bool {
    let (Some(r), Some(token)) = (read_ready(session), read_token(session)) else {
        return false;
    };
    r.protocol == PROTOCOL
        && send(
            r.port,
            &request_text(&token, "ping", None),
            Duration::from_secs(2),
        )
        .map(|rep| rep.ok)
        .unwrap_or(false)
}

/// `stale_names` 里的哨兵：失败那批没有类名可追踪时用，永远不会被某次推送移除。
const UNKNOWN_STALE: &str = "?";

/// 放在 `AppState` 上的热替换状态。
#[derive(Debug, Default)]
pub struct HotswapState {
    /// 最近一次有效推送的结果（`unavailable` 不记，那是常态）。
    pub last: Option<Report>,
    /// 运行中的代码与磁盘不一致。由 `stale_names` 推出：失败或被遮挡的类进集合，
    /// 后续推送把它们真正替换进 JVM（或确认 JVM 还没加载）才逐个移出，集合空了才清。
    /// 不能拿任意一次成功把它盖掉：那次成功可能根本没碰失败的类。
    pub stale: bool,
    /// 仍然没进 JVM 的类名。失败批没记类名时放一个永不移除的哨兵，保守地等重启。
    stale_names: std::collections::BTreeSet<String>,
    /// 让 `stale` 置位的最近一次结果。`last` 可能已被后来的成功覆盖，告警条要讲的是这次。
    pub stale_report: Option<Report>,
    /// 手动模式下攒着、还没推的类。
    pub pending: Batch,
    /// 本次启动带了 `-javaagent`。agent 要等 JVM 打开完所有 jar 才就绪（实测约 2.5 分钟），
    /// 这期间 ping 不通，靠它区分「准备中」和「这次压根没挂」。
    pub attached: bool,
}

impl HotswapState {
    pub fn record(&mut self, r: Report) {
        if r.state == "unavailable" {
            return;
        }
        if r.state == "failed" {
            if r.requested_names.is_empty() {
                self.stale_names.insert(UNKNOWN_STALE.to_string());
            }
            self.stale_names.extend(r.requested_names.iter().cloned());
        } else {
            // 替换成功的和 JVM 还没加载的（首次加载就是新代码）都不再过时
            for n in r
                .redefined
                .iter()
                .map(|c| &c.name)
                .chain(r.not_loaded.iter())
            {
                self.stale_names.remove(n);
            }
            self.stale_names
                .extend(r.shadowed.iter().map(|s| s.name.clone()));
        }
        self.stale = !self.stale_names.is_empty();
        if r.makes_stale() {
            self.stale_report = Some(r.clone());
        } else if !self.stale {
            self.stale_report = None;
        }
        self.last = Some(r);
    }

    /// 新启动的 JVM 加载的就是磁盘上的最新产物：之前的结果、待推列表都作废。
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        crate::test_support::tmp(&format!("hotswap-{tag}"))
    }

    #[test]
    fn 令牌是32位十六进制且每次不同() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn 就绪文件名是会话文件名加ready() {
        let s = Path::new(r"C:\cfg\hotswap\launch.properties");
        assert_eq!(
            ready_file(s),
            PathBuf::from(r"C:\cfg\hotswap\launch.properties.ready")
        );
    }

    #[test]
    fn javaagent参数不含令牌_jar路径带等号时拒绝() {
        let arg = javaagent_arg(
            Path::new(r"D:\app\hotswap\ncforge-hotswap.jar"),
            Path::new(r"C:\cfg\s.properties"),
        )
        .unwrap();
        assert_eq!(
            arg,
            r"-javaagent:D:\app\hotswap\ncforge-hotswap.jar=C:\cfg\s.properties"
        );
        assert!(javaagent_arg(Path::new(r"D:\a=b\x.jar"), Path::new("s")).is_err());
    }

    #[test]
    fn 写会话会清掉旧的就绪文件并写入令牌() {
        let d = temp_dir("session");
        let s = d.join("hotswap").join("launch.properties");
        std::fs::create_dir_all(s.parent().unwrap()).unwrap();
        std::fs::write(ready_file(&s), "port=1\n").unwrap();
        write_session(&s, "0123456789abcdef0123").unwrap();
        assert!(!ready_file(&s).exists(), "旧 .ready 必须先删掉");
        assert_eq!(
            std::fs::read_to_string(&s).unwrap(),
            "token=0123456789abcdef0123\n"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 预览不写盘_关闭或缺jar时不挂agent() {
        let d = temp_dir("launch");
        let jar = d.join(JAR_NAME);
        std::fs::write(&jar, b"x").unwrap();
        assert_eq!(launch_agent_arg(&d, Some(&jar), false, true).unwrap(), None);
        assert_eq!(launch_agent_arg(&d, None, true, true).unwrap(), None);

        let preview = launch_agent_arg(&d, Some(&jar), true, false)
            .unwrap()
            .unwrap();
        assert!(preview.starts_with("-javaagent:"));
        assert!(!launch_session_file(&d).exists(), "预览不能换令牌");

        let real = launch_agent_arg(&d, Some(&jar), true, true)
            .unwrap()
            .unwrap();
        assert_eq!(real, preview, "预览与真启动的参数必须一致");
        let body = std::fs::read_to_string(launch_session_file(&d)).unwrap();
        assert!(body.starts_with("token=") && body.trim_end().len() == 6 + 32);
        assert!(
            !real.contains(body.trim_end().trim_start_matches("token=")),
            "令牌不能进命令行"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 源文件映射到主类与内部类_重复加入不重复() {
        let d = temp_dir("batch");
        let out = d.join("classes");
        let pkg = out.join("nc").join("bs");
        std::fs::create_dir_all(&pkg).unwrap();
        for f in [
            "Foo.class",
            "Foo$1.class",
            "Foo$Inner.class",
            "FooBar.class",
            "Other.class",
        ] {
            std::fs::write(pkg.join(f), b"x").unwrap();
        }
        let src = d.join("src").join("nc").join("bs").join("Foo.java");
        let mut b = Batch::default();
        b.add_source(&out, "nc.bs", &src);
        b.add_source(&out, "nc.bs", &src);
        let names: Vec<&str> = b.classes.iter().map(|c| c.name.as_str()).collect();
        // 顺序沿用 classes_for_source 的文件名排序：`$`(0x24) 排在 `.`(0x2e) 前
        assert_eq!(names, ["nc.bs.Foo$1", "nc.bs.Foo$Inner", "nc.bs.Foo"]);
        assert_eq!(b.roots, vec![out.clone()]);
        assert_eq!(b.classes[2].file, pkg.join("Foo.class"));
        // 没有产物的源文件不带进 root
        let mut empty = Batch::default();
        empty.add_source(&d.join("nowhere"), "nc.bs", &src);
        assert!(empty.is_empty() && empty.roots.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 就绪文件与请求文本() {
        assert_eq!(
            parse_ready("port=5005\npid=42\nprotocol=1\n"),
            Some(Ready {
                port: 5005,
                pid: "42".into(),
                protocol: 1
            })
        );
        assert_eq!(parse_ready("port=0\npid=1\nprotocol=1\n"), None);
        assert_eq!(parse_ready("pid=1\nprotocol=1\n"), None);
        let b = Batch {
            roots: vec![PathBuf::from(r"C:\w\arap\classes")],
            classes: vec![ClassItem {
                name: "a.B".into(),
                file: PathBuf::from(r"C:\w\arap\classes\a\B.class"),
            }],
        };
        assert_eq!(
            request_text("tok", "redefine", Some(&b)),
            "NCFORGE-HOTSWAP 1\ntoken tok\nop redefine\nroot C:\\w\\arap\\classes\nclass a.B\tC:\\w\\arap\\classes\\a\\B.class\nend\n"
        );
    }

    /// 起一个只回一句的假 agent，返回对应的会话文件。
    fn fake_agent(tag: &str, reply: &'static str) -> (PathBuf, std::thread::JoinHandle<String>) {
        let d = temp_dir(tag);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let session = d.join("launch.properties");
        std::fs::write(&session, "token=0123456789abcdef0123\n").unwrap();
        std::fs::write(
            ready_file(&session),
            format!("port={port}\npid=7\nprotocol=1\n"),
        )
        .unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            while !req.ends_with(b"end\n") {
                let n = s.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
            }
            s.write_all(reply.as_bytes()).unwrap();
            String::from_utf8(req).unwrap()
        });
        (session, h)
    }

    fn one_class() -> Batch {
        Batch {
            roots: vec![PathBuf::from("r")],
            classes: vec![ClassItem {
                name: "a.B".into(),
                file: PathBuf::from("r/a/B.class"),
            }],
        }
    }

    #[test]
    fn 推送结果映射_成功_遮蔽_拒绝() {
        let (s, h) = fake_agent(
            "push-ok",
            r#"{"ok":true,"op":"redefine","redefined":[{"name":"a.B","loader":"App@1"}],"notLoaded":[],"shadowed":[],"elapsedMs":3}"#,
        );
        let r = push(&s, &one_class());
        assert!(h
            .join()
            .unwrap()
            .contains("token 0123456789abcdef0123\nop redefine\n"));
        assert_eq!(r.state, "ok");
        assert_eq!(r.redefined.len(), 1);
        assert!(!r.makes_stale());

        let (s, h) = fake_agent(
            "push-partial",
            r#"{"ok":true,"redefined":[],"notLoaded":["a.C"],"shadowed":[{"name":"a.B","loader":"App@1","source":"D:\\patch"}]}"#,
        );
        let r = push(&s, &one_class());
        h.join().unwrap();
        assert_eq!(r.state, "partial");
        assert_eq!(r.not_loaded, ["a.C"]);
        assert!(r.makes_stale(), "有类被遮蔽就意味着运行中的不是最新代码");

        let (s, h) = fake_agent(
            "push-fail",
            r#"{"ok":false,"code":"unsupported","message":"class redefinition failed: attempted to add a method"}"#,
        );
        let r = push(&s, &one_class());
        h.join().unwrap();
        assert_eq!(r.state, "failed");
        assert_eq!(r.code.as_deref(), Some("unsupported"));
        assert!(r.makes_stale());
    }

    #[test]
    fn 没就绪或连不上都算不可用_不记入状态() {
        let d = temp_dir("push-none");
        let s = d.join("launch.properties");
        assert_eq!(push(&s, &one_class()).state, "unavailable");
        // 就绪文件指向一个没人听的端口（上一个 JVM 被强杀后的残留）
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        std::fs::write(&s, "token=0123456789abcdef0123\n").unwrap();
        std::fs::write(ready_file(&s), format!("port={port}\npid=7\nprotocol=1\n")).unwrap();
        let r = push(&s, &one_class());
        assert_eq!(r.state, "unavailable");
        assert!(!ping(&s));
        // 协议不一致：运行中的是旧版 agent，必须提示重启
        std::fs::write(ready_file(&s), format!("port={port}\npid=7\nprotocol=0\n")).unwrap();
        assert_eq!(push(&s, &one_class()).code.as_deref(), Some("protocol"));

        let mut st = HotswapState::default();
        st.record(r);
        assert!(
            st.last.is_none() && !st.stale,
            "unavailable 是常态，不覆盖上一次结果"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 过时标记只在重启时清除() {
        let mut st = HotswapState::default();
        let mut failed = Report::new(1);
        failed.state = "failed";
        st.record(failed);
        assert!(st.stale);
        st.record(Report::new(1));
        assert!(st.stale, "后续成功不能掩盖之前未生效的结构性变更");
        assert_eq!(st.last.as_ref().map(|r| r.state), Some("ok"));
        assert_eq!(st.stale_report.as_ref().map(|r| r.state), Some("failed"));
        st.pending = one_class();
        st.reset();
        assert!(
            !st.stale && st.last.is_none() && st.pending.is_empty() && st.stale_report.is_none()
        );
    }

    #[test]
    fn 后续成功覆盖失败的全部类后过时标记清除() {
        let mut st = HotswapState::default();
        let mut failed = Report::new(2);
        failed.state = "failed";
        failed.requested_names = vec!["a.A".into(), "a.A$1".into()];
        st.record(failed);
        assert!(st.stale);

        // 只替换了 a.A：还剩 a.A$1 没进 JVM
        let mut part = Report::new(1);
        part.redefined = vec![Loaded {
            name: "a.A".into(),
            loader: "App@1".into(),
        }];
        st.record(part);
        assert!(st.stale, "a.A$1 还没被覆盖");
        assert!(st.stale_report.is_some());

        // 无关的类替换成功：不能清
        let mut other = Report::new(1);
        other.redefined = vec![Loaded {
            name: "b.B".into(),
            loader: "App@1".into(),
        }];
        st.record(other);
        assert!(st.stale);

        // a.A$1 JVM 里还没加载：首次加载就是新代码，全部覆盖
        let mut rest = Report::new(1);
        rest.not_loaded = vec!["a.A$1".into()];
        st.record(rest);
        assert!(!st.stale && st.stale_report.is_none());
    }

    #[test]
    fn 遮挡的类不会被无关成功清除() {
        let mut st = HotswapState::default();
        let mut partial = Report::new(1);
        partial.state = "partial";
        partial.shadowed = vec![Shadowed {
            name: "a.S".into(),
            loader: "App@1".into(),
            source: "D:\\patch".into(),
        }];
        st.record(partial);
        assert!(st.stale);
        let mut ok = Report::new(1);
        ok.redefined = vec![Loaded {
            name: "b.B".into(),
            loader: "App@1".into(),
        }];
        st.record(ok);
        assert!(st.stale, "遮挡的类没被替换，不能由别的类的成功清除");
    }

    #[test]
    fn 推送送不到_agent_时带上排查用的失败码() {
        let d = temp_dir("unreachable");
        let s = d.join("launch.properties");
        // 就绪文件在、端口没人监听（agent 被杀 / 进程已退）
        std::fs::write(&s, "token=0123456789abcdef0123456789abcdef\n").unwrap();
        std::fs::write(ready_file(&s), "port=1\npid=7\nprotocol=1\n").unwrap();
        let r = push(&s, &one_class());
        assert_eq!(r.state, "unavailable");
        assert_eq!(r.code.as_deref(), Some("unreachable"));
        assert_eq!(r.requested_names.len(), 1);
        assert_eq!(r.escalate().state, "failed");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 日志行按结果写明类名与原因() {
        let mut ok = Report::new(7);
        ok.redefined = (0..7)
            .map(|i| Loaded {
                name: format!("a.C{i}"),
                loader: "App".into(),
            })
            .collect();
        ok.elapsed_ms = 12;
        assert_eq!(
            ok.log_line(),
            "[nc-forge] 热替换 已替换 7 个类 (a.C0, a.C1, a.C2, a.C3, a.C4 等 7 个) · 12 ms\n"
        );
        let failed = Report::new(3).fail("failed", Some("unsupported".into()), "加了方法".into());
        assert!(failed
            .log_line()
            .contains("失败，本批 3 个类未应用：加了方法"));
        let mut partial = Report::new(2);
        partial.state = "partial";
        partial.shadowed = vec![Shadowed {
            name: "a.B".into(),
            loader: "App".into(),
            source: String::new(),
        }];
        assert!(partial.log_line().contains("1 个被遮挡 (a.B)"));
    }

    #[test]
    fn 按顺序找到第一个存在的jar() {
        let d = temp_dir("find");
        let a = d.join("a");
        let b = d.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        assert_eq!(find_jar(&[a.clone(), b.clone()]), None);
        std::fs::write(b.join(JAR_NAME), b"x").unwrap();
        assert_eq!(find_jar(&[a, b.clone()]), Some(b.join(JAR_NAME)));
        let _ = std::fs::remove_dir_all(&d);
    }
}
