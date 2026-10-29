//! NC 中间件进程的启停与日志跟随。
//!
//! 这里的进程是**外部** java.exe（不是 tauri sidecar）：命令、参数、工作目录都由
//! `launch.rs` 拼好，本模块只负责起进程、判活、杀进程树、增量读日志。
//!
//! 三个必须守住的点：
//!
//! 1. **杀进程要杀树**。中间件会起子进程（Tomcat 的 acceptor、可能还有 jstat 之类），
//!    只杀父进程会在后台留一堆 java.exe，下次启动端口被占、内存被吃。
//!    Windows 上用 `taskkill /T /F /PID`。
//! 2. **标准输出必须落文件**。Tauri 是 GUI 进程，没有控制台可看；中间件的
//!    `System.out` 就是它的日志。用 `Stdio::from(File)` 直接接文件，不做管道，
//!    免得没人读管道把 java 阻塞住（管道满了 write 会卡死整个服务）。
//! 3. **判活不能只看 `try_wait`**。子进程被 taskkill 干掉后 `try_wait` 会返回 Some，
//!    但如果是别的原因（比如句柄泄漏）也可能一直 None。所以同时比对 PID 是否还在。
//!
//! 纯逻辑模块，不含 tauri 类型（原因见 workspace.rs 头注释）。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

/// 一次启动所需的全部要素。由 `launch.rs` 生成。
#[derive(Debug, Clone)]
pub struct ServerSpec {
    pub java: PathBuf,
    pub main_class: String,
    pub vm_args: Vec<String>,
    pub classpath_jar: PathBuf,
    pub work_dir: PathBuf,
    /// 追加在 VM 参数之后、主类之前的程序参数（`StartDirectServer` 一般不需要）。
    pub program_args: Vec<String>,
}

/// 占着某个端口的进程。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortOwner {
    pub pid: u32,
    pub name: String,
}

impl PortOwner {
    /// 是否是我们自己起的 java。只有它为真才允许「强制结束端口占用」——
    /// 别的程序（甚至系统服务）占着 80 时，杀它不该由本应用代劳。
    pub fn is_java(&self) -> bool {
        is_java_name(&self.name)
    }
}

/// 进程名是不是 java。`javaw.exe` 也算（Eclipse 起 NC 用的就是它）。
pub fn is_java_name(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with("java")
}

/// 读不到进程名时 `PortOwner.name` 的占位值。
///
/// 前端按字面量认这个值（`desktop/src/lib/server.ts` 的 `UNKNOWN_PROCESS_NAME`，
/// `ServicesTab` 消费），所以它是一份对外契约：改文案必须同步改那边。
/// 「读不到名字」不等于「不是 java」，任何一侧都别把它当结论用。
pub const UNKNOWN_PROCESS: &str = "未知进程";

/// 读不到名字时能不能断定「不是我们的 java」。单独一个函数，免得各处自己比字符串。
pub fn name_unknown(name: &str) -> bool {
    name == UNKNOWN_PROCESS
}

/// 查谁在 LISTEN 这个端口。查不到返回 None（端口空闲，或 netstat 不可用）。
///
/// 为什么不用「connect 成功即占用」：连接成功只能说明有人接，拿不到 PID，
/// 而用户要的正是「是哪个进程占着，能不能关掉」。netstat -ano 是 Windows 自带的，
/// 不需要额外进程或权限。
///
/// 进程名走 `process_name_cached`：一次 `tasklist` 实测 170ms（netstat 才 30ms），
/// 而状态是每秒轮询的——不缓存等于每秒空转掉小半个核。**要拿它做安全判定
/// （比如杀进程）时必须重新实时查**，见 `server_kill_port_owner`。
#[cfg(windows)]
pub fn port_owner(port: u16) -> Option<PortOwner> {
    let pid = port_pid(port)?;
    Some(PortOwner {
        pid,
        name: process_name_cached(pid).unwrap_or_else(|| UNKNOWN_PROCESS.to_string()),
    })
}

#[cfg(not(windows))]
pub fn port_owner(_port: u16) -> Option<PortOwner> {
    None
}

/// 只查占着端口的 PID，不查进程名（省掉 tasklist 那次 fork）。查不到返回 None。
#[cfg(windows)]
pub fn port_pid(port: u16) -> Option<u32> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("netstat")
        .arg("-ano")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    // netstat 的表头是本地化中文，但 TCP / LISTENING 是固定英文，只认这两列
    let text = String::from_utf8_lossy(&out.stdout);
    let suffix = format!(":{port}");
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        // 用「以 :port 结尾」而不是 contains：否则 8080 会命中 80
        if cols[3].eq_ignore_ascii_case("LISTENING") && cols[1].ends_with(&suffix) {
            if let Ok(p) = cols[4].parse::<u32>() {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(not(windows))]
pub fn port_pid(_port: u16) -> Option<u32> {
    None
}

/// 进程名缓存的有效期。状态是 1 秒一轮，10 秒意味着稳态下几乎不查 tasklist；
/// 而 PID 在这段时间内被系统复用给另一个程序的可能性足够低——真要做安全判定时
/// 调用方会绕过缓存重查（见 `server_kill_port_owner`）。
// 只被 Windows 的 process_name_cached 用；非 Windows 平台连函数都没有，留着就是死代码
#[cfg(windows)]
const PROCESS_NAME_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// 带缓存的进程名查询。**只用于显示**；决定「能不能杀」必须用 `process_name`。
#[cfg(windows)]
fn process_name_cached(pid: u32) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

    static CACHE: OnceLock<Mutex<HashMap<u32, (String, Instant)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let now = Instant::now();
    if let Ok(map) = cache.lock() {
        if let Some((name, at)) = map.get(&pid) {
            if now.duration_since(*at) < PROCESS_NAME_TTL {
                return Some(name.clone());
            }
        }
    }
    let name = process_name(pid)?;
    if let Ok(mut map) = cache.lock() {
        // 顺便清掉过期项，免得长期运行后表越涨越大
        map.retain(|_, (_, at)| now.duration_since(*at) < PROCESS_NAME_TTL);
        map.insert(pid, (name.clone(), now));
    }
    Some(name)
}

// 没有 `#[cfg(not(windows))]` 的桩：唯一调用方 port_owner 就是 Windows 专属，
// 非 Windows 平台留桩反而触发 dead_code（2026-10-28 CI 实测）。

/// 取进程名（不含路径）。查不到返回 None。
#[cfg(windows)]
pub fn process_name(pid: u32) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // 输出形如 "java.exe","1234","Console","1","1,234 K"；没有匹配时是中文提示句
    let first = text.lines().next()?.split('"').nth(1)?.to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

#[cfg(not(windows))]
pub fn process_name(_pid: u32) -> Option<String> {
    None
}

/// 端口上是否有人在 listen（连得上就算）。
///
/// `address` 是中间件配置里声明的监听地址（prop.xml 的 `<http><address>`）。
/// 配了具体局域网 IP 时 Tomcat **只绑那个地址**，连 127.0.0.1 永远不通：状态会永久
/// 停在「启动中」，而「重启」按钮只在 running 时渲染——用户连重启都点不了。
///
/// 超时给 200ms：本机回环要么立刻通要么立刻拒，等更久只会拖慢状态轮询。
pub fn port_reachable(port: u16, address: Option<&str>) -> bool {
    use std::net::{IpAddr, SocketAddr, TcpStream};
    use std::time::Duration;
    let ip = address
        .and_then(|a| a.trim().parse::<IpAddr>().ok())
        // `0.0.0.0` / `::` 表示绑所有网卡，这时连回环一样能通
        .filter(|ip| !ip.is_unspecified())
        .unwrap_or(IpAddr::from([127, 0, 0, 1]));
    TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_millis(200)).is_ok()
}

/// 正在跑（或刚跑过）的中间件进程。
pub struct ServerProcess {
    child: Child,
    pub pid: u32,
    pub log_path: PathBuf,
    pub started_at_ms: u64,
}

impl ServerProcess {
    /// 起进程。stdout / stderr 都追加到 `log_path`（同一个文件，顺序即真实时序）。
    ///
    /// 用 append 而不是 truncate：用户往往要对照「上一次坑人的报错」，
    /// 每次启动清空会把它冲掉。日志切换由界面上的「清空」按钮负责。
    pub fn spawn(spec: &ServerSpec, log_path: &Path) -> Result<Self, String> {
        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建日志目录失败: {e}"))?;
        }
        let out = File::options()
            .create(true)
            .append(true)
            .open(log_path)
            .map_err(|e| format!("打开日志文件失败: {e}"))?;
        let err = out
            .try_clone()
            .map_err(|e| format!("复制日志句柄失败: {e}"))?;

        let mut cmd = build_command(spec);
        cmd.stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .stdin(Stdio::null());

        // 起之前先记一行分隔，日志里能一眼看出这是第几次启动
        append_log(
            log_path,
            &format!("\n===== 启动 =====\n{}\n", describe(spec)),
        )?;

        let child = cmd
            .spawn()
            .map_err(|e| format!("启动 java 失败（{}）: {e}", spec.java.display()))?;
        let pid = child.id();
        append_log(log_path, &format!("[nc-forge] pid={pid}\n"))?;

        Ok(Self {
            child,
            pid,
            log_path: log_path.to_path_buf(),
            started_at_ms: now_ms(),
        })
    }

    /// 进程是否还在跑。顺带回收僵尸（`try_wait` 必须调用一次才知道退出码）。
    pub fn is_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) => false,
            // 拿不到状态（句柄坏了）时按「已退出」处理，避免界面永远显示「运行中」
            Err(_) => false,
        }
    }

    /// 退出码；还活着返回 None。
    pub fn exit_code(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
            _ => None,
        }
    }

    /// 停止。Windows 上直接强杀进程树。
    ///
    /// 试过「先 taskkill /T 不带 /F，等 3 秒再 /F」：任务管理器里对控制台进程
    /// 不带 /F 的 taskkill 发的是 WM_CLOSE，java 根本没有窗口去收这条消息，
    /// 结果每次停止都白等满 3 秒才落到强杀。Eclipse 的停止按钮同样是直接杀，
    /// NC 中间件也没有需要优雅落盘的状态，所以省掉这一步。
    pub fn stop(&mut self) {
        if !self.is_alive() {
            return;
        }
        #[cfg(windows)]
        {
            kill_tree(self.pid, true);
            for _ in 0..20 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if !self.is_alive() {
                    return;
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

/// 停止的结果。为什么要三态而不是 bool：
/// 用户在「正在准备启动」（写 pathing jar 的那 1 秒）里点停止，既不是「停掉了一个进程」，
/// 也不是「没东西可停」——它是「已经记下，让启动流程自己放弃」。把这种中间态说成
/// 「已停止」是最坏的一种谎：服务随后照旧起来，用户以为自己已经停了。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopOutcome {
    /// 真的杀掉了一个在跑的进程。
    Stopped,
    /// 还在准备阶段，已请求取消，启动流程会自己退出。
    Cancelling,
    /// 没有在跑，也没有在启动。
    Idle,
}

/// 中间件的运行态。**跨命令共享**，放在 `AppState` 里（全应用只有一个服务实例）。
///
/// 进程退出后不清空 `java` / `classpath_jar` / `command_line`：界面要能显示
/// 「上次是怎么起的」，排错时最有用的就是这条命令行。
#[derive(Default)]
pub struct ServerRun {
    pub proc: Option<ServerProcess>,
    /// 「正在准备启动」：已通过检查、正在写 pathing jar / 暖索引，进程还没出来。
    ///
    /// 没有它的话，用户在 0.6 秒内连点两次「启动」，两个请求都能通过「当前没在跑」的
    /// 检查，最后会起两个 java 抢 80 端口——一个占着、另一个反复报错重启。
    pub starting: bool,
    /// 准备阶段收到的停止请求。启动流程在真正 fork 之前复查它，有值就放弃。
    /// 只靠 `proc.take()` 的停止挡不住这个窗口：那时进程根本还不存在。
    pub stop_requested: bool,
    pub java: Option<PathBuf>,
    pub classpath_jar: Option<PathBuf>,
    /// 本次（或上次）classpath 里的条目数。界面显示「7230 项」，也是「工程 classes
    /// 有没有进 classpath」的间接证据。
    pub classpath_entries: usize,
    pub command_line: String,
    /// 最近一次停止/失败的原因。成功启动后清空。
    pub reason: Option<String>,
    pub exit_code: Option<i32>,
}

impl ServerRun {
    /// 是否还在跑。顺带回收已退出的进程，把退出码与原因记下来。
    ///
    /// `try_wait` 必须被调用，否则 `Child` 不会释放句柄、也拿不到退出码。
    pub fn is_alive(&mut self) -> bool {
        let code = match self.proc.as_mut() {
            Some(p) => {
                if p.is_alive() {
                    return true;
                }
                p.exit_code()
            }
            None => return false,
        };
        self.exit_code = Some(code.unwrap_or(-1));
        self.proc = None;
        if self.reason.is_none() {
            self.reason = Some(match self.exit_code {
                Some(c) if c != 0 => format!("进程已退出（退出码 {c}）"),
                _ => "进程已退出".to_string(),
            });
        }
        false
    }

    /// 停止并清空进程槽位。
    pub fn stop(&mut self) -> StopOutcome {
        let Some(mut p) = self.proc.take() else {
            // 进程还没出来（还在写 pathing jar）：记下请求，启动流程 fork 前会复查
            if self.starting {
                self.stop_requested = true;
                return StopOutcome::Cancelling;
            }
            return StopOutcome::Idle;
        };
        p.stop();
        self.exit_code = p.exit_code();
        self.reason = Some("已手动停止".to_string());
        StopOutcome::Stopped
    }
}

/// 拼 `java` 命令。抽出来是为了能单测「参数顺序对不对」而不必真起进程。
pub fn build_command(spec: &ServerSpec) -> Command {
    let mut cmd = Command::new(&spec.java);
    cmd.current_dir(&spec.work_dir);
    // classpath 只有一个 pathing jar，真正的 7000+ 条目在它的 manifest 里
    cmd.arg("-cp").arg(&spec.classpath_jar);
    for a in &spec.vm_args {
        cmd.arg(a);
    }
    cmd.arg(&spec.main_class);
    for a in &spec.program_args {
        cmd.arg(a);
    }
    // GUI 进程起控制台子进程时别弹黑框
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 把命令行写成人能读的一行（写进日志，出问题时对照 Eclipse 的启动配置）。
pub fn describe(spec: &ServerSpec) -> String {
    let mut parts = vec![
        format!("{}", spec.java.display()),
        "-cp".to_string(),
        format!("{}", spec.classpath_jar.display()),
    ];
    parts.extend(spec.vm_args.iter().cloned());
    parts.push(spec.main_class.clone());
    parts.extend(spec.program_args.iter().cloned());
    parts.join(" ")
}

/// 杀进程树。`force=false` 时只请求终止（让 shutdown hook 有机会跑）。
#[cfg(windows)]
pub fn kill_tree(pid: u32, force: bool) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("taskkill");
    cmd.arg("/T");
    if force {
        cmd.arg("/F");
    }
    cmd.arg("/PID").arg(pid.to_string());
    cmd.creation_flags(CREATE_NO_WINDOW);
    // taskkill 失败（进程已退出）不是问题，静默
    let _ = cmd.output();
}

/// 追加一行到日志。失败只记 warn，不影响服务运行。
///
/// **写入用 GBK**：同一个日志文件里混着 NC 中间件自己输出的 GBK 和本模块写的分隔行，
/// 若这里写 UTF-8，读取时统一按 GBK 解就会把中文变成「鍚姩」这种乱码。
/// 编码在入口处统一，比在读取处猜测可靠。
pub fn append_log(path: &Path, text: &str) -> Result<(), String> {
    let mut f = File::options()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("写日志失败: {e}"))?;
    let (bytes, _, _) = encoding_rs::GBK.encode(text);
    f.write_all(&bytes).map_err(|e| format!("写日志失败: {e}"))
}

/// 从 `offset` 开始读日志，最多 `max_bytes`。返回（文本，新偏移）。
///
/// 为什么要偏移而不是整份读：中间件跑一整天日志能到几百 MB，
/// 每次刷新都整份读会把内存和 CPU 吃干。前端拿着上次的 offset 反复要增量。
///
/// 编码按「GBK 优先、非法则 UTF-8 lossy」解——NC 日志是 GBK（`-Dfile.encoding=GBK`），
/// 但也可能因为参数没生效而是 UTF-8。
pub fn read_log_from(path: &Path, offset: u64, max_bytes: u64) -> Result<(String, u64), String> {
    let mut f = match File::open(path) {
        Ok(f) => f,
        // 还没生成日志不是错误，界面显示「暂无输出」即可
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((String::new(), offset)),
        Err(e) => return Err(format!("打开日志失败: {e}")),
    };
    let len = f.metadata().map(|m| m.len()).map_err(|e| e.to_string())?;
    if len < offset {
        // 文件被清空或轮转了，从头读
        return read_log_from(path, 0, max_bytes);
    }
    if len == offset {
        return Ok((String::new(), offset));
    }
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("定位日志失败: {e}"))?;
    let take = (len - offset).min(max_bytes);
    let mut buf = vec![0u8; take as usize];
    let n = f.read(&mut buf).map_err(|e| format!("读日志失败: {e}"))?;
    buf.truncate(n);

    // 末尾可能截断在半个多字节字符上：退回到最后一个完整字符边界，
    // 否则前端会看到乱码且下次拼接时又多一个替换符
    let (valid, consumed) = trim_incomplete_tail(&buf, offset + take < len);
    Ok((decode(&valid), offset + consumed))
}

/// 这一批没读到文件末尾时，把最后 2 字节留给下一次。
///
/// 为什么是「保守留 2 字节」而不是精确判断：日志是 GBK（双字节），而 GBK 的
/// 首字节范围（0x81-0xFE）与尾字节范围（0x40-0xFE）重叠，**单看一个字节无法判断
/// 它到底是独立字符还是某个双字节的前半截**。精确做法要回扫整段并重新配对，
/// 代价大于收益。留 2 字节的副作用只是最新 2 个字节晚一拍显示，人眼无感。
fn trim_incomplete_tail(buf: &[u8], more_left: bool) -> (Vec<u8>, u64) {
    if !more_left || buf.len() <= 2 {
        return (buf.to_vec(), buf.len() as u64);
    }
    let end = buf.len() - 2;
    (buf[..end].to_vec(), end as u64)
}

fn decode(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    // NC 日志默认 GBK；但纯 ASCII 也走这条，没问题
    let (text, _, had_errors) = encoding_rs::GBK.decode(bytes);
    if had_errors {
        String::from_utf8_lossy(bytes).to_string()
    } else {
        text.to_string()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("ncforge-server-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn cleanup(d: &Path) {
        let _ = std::fs::remove_dir_all(d);
    }

    fn spec() -> ServerSpec {
        ServerSpec {
            java: PathBuf::from(r"D:\ncc\1909home\ufjdk\bin\java.exe"),
            main_class: "ufmiddle.start.tomcat.StartDirectServer".into(),
            vm_args: vec!["-Xmx1024m".into(), "-Dnc.runMode=develop".into()],
            classpath_jar: PathBuf::from(r"C:\logs\cp.jar"),
            work_dir: PathBuf::from(r"D:\ncc\1909home"),
            program_args: vec![],
        }
    }

    #[test]
    fn 命令行里_classpath_在_vm_参数之前且主类在最后() {
        let cmd = build_command(&spec());
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        // -cp <jar> vm... main
        assert_eq!(args[0], "-cp");
        assert!(args[1].ends_with("cp.jar"));
        assert_eq!(args[2], "-Xmx1024m");
        assert_eq!(args[4], "ufmiddle.start.tomcat.StartDirectServer");
        assert_eq!(
            cmd.get_current_dir().map(|p| p.to_path_buf()),
            Some(PathBuf::from(r"D:\ncc\1909home")),
            "工作目录必须是 NC home"
        );
    }

    #[test]
    fn 日志增量读只返回新增部分() {
        let d = temp_dir("tail");
        let log = d.join("a.log");
        std::fs::write(&log, "第一行\n").unwrap();

        let (text, off) = read_log_from(&log, 0, 1 << 20).unwrap();
        assert_eq!(text, "第一行\n");
        assert_eq!(off, "第一行\n".len() as u64);

        // 没有新增时不返回内容，偏移不变
        let (text2, off2) = read_log_from(&log, off, 1 << 20).unwrap();
        assert_eq!(text2, "");
        assert_eq!(off2, off);

        append_log(&log, "第二行\n").unwrap();
        let (text3, off3) = read_log_from(&log, off, 1 << 20).unwrap();
        assert_eq!(text3, "第二行\n");
        assert!(off3 > off);
        cleanup(&d);
    }

    #[test]
    fn 文件被清空后从头读() {
        let d = temp_dir("truncate");
        let log = d.join("b.log");
        std::fs::write(&log, "一二三四五\n").unwrap();
        let (_, off) = read_log_from(&log, 0, 1 << 20).unwrap();
        std::fs::write(&log, "新\n").unwrap();
        let (text, _) = read_log_from(&log, off, 1 << 20).unwrap();
        assert_eq!(text, "新\n", "偏移超过文件长度时应重新从头读");
        cleanup(&d);
    }

    #[test]
    fn 日志不存在时返回空而不是报错() {
        let d = temp_dir("missing");
        let (text, off) = read_log_from(&d.join("nope.log"), 7, 1024).unwrap();
        assert_eq!(text, "");
        assert_eq!(off, 7);
        cleanup(&d);
    }

    #[test]
    fn gbk_中文日志能正确解码() {
        let d = temp_dir("gbk");
        let log = d.join("c.log");
        let (bytes, _, _) = encoding_rs::GBK.encode("服务已启动\n");
        std::fs::write(&log, &bytes[..]).unwrap();
        let (text, _) = read_log_from(&log, 0, 1 << 20).unwrap();
        assert_eq!(text, "服务已启动\n");
        cleanup(&d);
    }

    #[test]
    fn 截断在半个汉字上时不吐出乱码() {
        let d = temp_dir("half");
        let log = d.join("d.log");
        // 「汉」的 GBK 是 BABA，只写一半（BA）会被当成半个字符
        std::fs::write(&log, [b'A', 0xBA]).unwrap();
        let (text, off) = read_log_from(&log, 0, 1 << 20).unwrap();
        assert!(text.starts_with('A'));
        assert!(off <= 2, "偏移不该超过实际字节数");
        cleanup(&d);
    }

    #[test]
    fn describe_把参数按真实顺序拼起来() {
        let s = describe(&spec());
        assert!(s.contains("-cp"));
        assert!(s.find("-Xmx1024m").unwrap() < s.find("ufmiddle").unwrap());
    }

    #[test]
    fn 端口在监听时可连_关闭后不可连() {
        use std::net::TcpListener;
        // 绑 0 让系统分一个空闲端口：测试不能碰真实的 80，机器上可能正跑着 NC
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_reachable(port, None), "正在 listen 的端口应当可连");
        drop(listener);
        assert!(!port_reachable(port, None), "端口关闭后不该可连");
    }

    #[test]
    fn 监听地址是通配时按回环探测() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // 0.0.0.0 / :: 表示绑所有网卡：此时连回环是能通的，不能被当成「非回环地址」漏掉
        assert!(port_reachable(port, Some("0.0.0.0")));
        assert!(port_reachable(port, Some("::")));
        // 解析不了的值退回回环，不 panic
        assert!(port_reachable(port, Some("不是 IP")));
    }

    #[test]
    fn 没有进程时状态是未运行且不误报退出码() {
        let mut run = ServerRun::default();
        assert!(!run.is_alive());
        assert!(run.exit_code.is_none(), "从没起过进程时不该编造退出码");
        assert_eq!(run.stop(), StopOutcome::Idle, "没进程也没在启动");
    }

    /// 准备阶段（写 pathing jar 的那 1 秒）点停止：不能报「已停止」，
    /// 要记下请求让启动流程放弃——否则服务随后照旧起来，用户以为已经停了。
    #[test]
    fn 准备启动阶段点停止会记为取消而不是已停止() {
        let mut run = ServerRun {
            starting: true,
            ..ServerRun::default()
        };
        assert_eq!(run.stop(), StopOutcome::Cancelling);
        assert!(run.stop_requested, "启动流程要能看到这个请求");
    }
}
