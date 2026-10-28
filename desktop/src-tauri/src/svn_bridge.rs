//! SVN 桥进程：常驻 JVM + 行协议。
//!
//! 为什么常驻而不是一次一进程：JVM 启动约 0.4 秒，而审查时会连续点十几个文件的 diff、
//! 再翻历史、再看 blame——每步重起一次 JVM 就是每步白等半秒。常驻后单条命令是毫秒级。
//!
//! 协议（详见 `src-tauri/svn-bridge/NcSvnBridge.java` 头部注释）：
//! - 请求：`id \t cmd \t arg…`，一行一条，UTF-8，字段内的 `\` `\t` `\n` 转义；
//! - 响应：每行一个 JSON，`{"id":..,"ok":true,"data":{..}}`；长任务先来若干
//!   `{"id":..,"progress":{..}}`（这里当心跳丢掉）；
//! - 桥进程崩溃/超时：本次调用报错，下一次调用重新拉起（不缓存坏状态）。
//!
//! 硬性约束：
//! - **必须传 `--config <自己的目录>`**。不给的话 SVNKit 会读写用户的
//!   `%APPDATA%\Subversion\auth`，实测会把已缓存的密码**改写成只剩用户名**。
//! - 读取用独立线程 + 超时：直接 `read_line` 卡死时没有任何办法知道是「服务端慢」
//!   还是「协议错位」，而超时后杀进程重来是最省事且不会留脏状态的处置。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

/// 桥的一次调用结果。
#[derive(Debug)]
pub struct BridgeError {
    pub message: String,
    /// `auth` / `conflict` / `wc` / `timeout` / `spawn` / `other`。前端按它决定引导文案。
    pub code: String,
}

impl BridgeError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// 建桥需要的环境。
#[derive(Debug, Clone)]
pub struct BridgeEnv {
    pub java: PathBuf,
    pub jars: Vec<PathBuf>,
    /// 我们自己的 SVN 配置/凭据目录（不会被 SVNKit 拿去当用户全局缓存）。
    pub config_dir: PathBuf,
}

struct Session {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    next_id: u64,
}

/// 桥本体。内部串行化所有请求：SVNKit 的 client manager 不是线程安全的，
/// 而并发请求也只会让 HTTP 连接互相排队。
pub struct Bridge {
    env: BridgeEnv,
    session: Mutex<Option<Session>>,
    /// 桥进程 stderr 的尾巴，出错时一并返回，省得用户只能看到「调用失败」。
    stderr_tail: std::sync::Arc<Mutex<VecDeque<String>>>,
}

impl Bridge {
    pub fn new(env: BridgeEnv) -> Self {
        Self {
            env,
            session: Mutex::new(None),
            stderr_tail: std::sync::Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub fn env(&self) -> &BridgeEnv {
        &self.env
    }

    /// 进程是否还活着（界面用来显示「桥已退出，将自动重启」之类的提示）。
    pub fn alive(&self) -> bool {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_mut() {
            Some(s) => matches!(s.child.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// 关掉桥进程（应用退出/切换工作区时调用）。
    pub fn shutdown(&self) {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut s) = guard.take() {
            let _ = writeln!(s.stdin, "0\tquit");
            let _ = s.stdin.flush();
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }

    /// 重启：先杀掉现有进程，下次调用重新拉起。
    pub fn restart(&self) {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut s) = guard.take() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }

    /// 跑一条命令。`args` 里不要带 TAB/换行（会被转义，桥侧会还原）。
    pub fn call(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<serde_json::Value, BridgeError> {
        self.call_with_progress(cmd, args, timeout, |_| {})
    }

    /// 带进度的版本：`on_progress` 收到桥推来的 `progress` 对象（目前只有 status 会用）。
    pub fn call_with_progress(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: Duration,
        mut on_progress: impl FnMut(&serde_json::Value),
    ) -> Result<serde_json::Value, BridgeError> {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(self.spawn()?);
        }
        let session = guard.as_mut().expect("刚拉起");

        let id = session.next_id;
        session.next_id += 1;
        let line = encode_request(id, cmd, args);
        if let Err(e) = session
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| session.stdin.flush())
        {
            let tail = self.take_stderr();
            *guard = None;
            return Err(BridgeError::new(
                "spawn",
                format!("写桥进程失败（{e}）。{tail}"),
            ));
        }

        let deadline = std::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                let tail = self.take_stderr();
                if let Some(mut s) = guard.take() {
                    let _ = s.child.kill();
                    let _ = s.child.wait();
                }
                return Err(BridgeError::new(
                    "timeout",
                    format!("SVN 命令超时（{cmd}）。{tail}"),
                ));
            }
            match session.rx.recv_timeout(left) {
                Ok(text) => {
                    let v: serde_json::Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(e) => {
                            // 协议错位：留着这个会话只会越错越远
                            *guard = None;
                            return Err(BridgeError::new(
                                "other",
                                format!("桥返回了非 JSON 内容（{e}）：{}", truncate(&text, 200)),
                            ));
                        }
                    };
                    if v.get("progress").is_some() {
                        on_progress(&v["progress"]);
                        continue;
                    }
                    if v.get("id")
                        .and_then(|x| x.as_str())
                        .map(|s| s == id.to_string())
                        != Some(true)
                    {
                        // 陈旧响应（上一次超时后残留的），丢掉继续等自己的
                        continue;
                    }
                    if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
                        return Ok(v.get("data").cloned().unwrap_or(serde_json::Value::Null));
                    }
                    let code = v.get("code").and_then(|x| x.as_str()).unwrap_or("other");
                    let msg = v
                        .get("error")
                        .and_then(|x| x.as_str())
                        .unwrap_or("未知错误")
                        .to_string();
                    // 失败不销毁会话：鉴权失败、冲突、路径不对都不是进程级问题
                    return Err(BridgeError::new(code, msg));
                }
                Err(RecvTimeoutError::Timeout) => continue, // 下一轮走到期判定
                Err(RecvTimeoutError::Disconnected) => {
                    let tail = self.take_stderr();
                    *guard = None;
                    return Err(BridgeError::new(
                        "spawn",
                        format!("SVN 桥进程已退出（{cmd}）。{tail}"),
                    ));
                }
            }
        }
    }

    fn take_stderr(&self) -> String {
        let mut q = self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
        if q.is_empty() {
            return String::new();
        }
        let joined: Vec<String> = q.drain(..).collect();
        format!("桥的 stderr 末尾：{}", joined.join(" | "))
    }

    fn spawn(&self) -> Result<Session, BridgeError> {
        let cp = self
            .env
            .jars
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(";");
        if self.env.jars.is_empty() {
            return Err(BridgeError::new(
                "spawn",
                "没有找到内置的 SVN 组件（ncsvn.jar / svnkit.jar）",
            ));
        }
        let mut cmd = Command::new(&self.env.java);
        cmd.arg("-Xmx384m")
            .arg("-Dfile.encoding=UTF-8")
            .arg("-cp")
            .arg(cp)
            .arg("NcSvnBridge")
            .arg("--config")
            .arg(&self.env.config_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // 打包版里绝不能弹黑框（Windows 上 java.exe 是控制台程序）
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            BridgeError::new(
                "spawn",
                format!("启动 SVN 桥失败（{:?}）：{e}", self.env.java),
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BridgeError::new("spawn", "桥进程没有 stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BridgeError::new("spawn", "桥进程没有 stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| BridgeError::new("spawn", "桥进程没有 stderr"))?;

        let (tx, rx) = mpsc::channel::<String>();
        std::thread::Builder::new()
            .name("svn-bridge-out".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            if tx.send(l).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| BridgeError::new("spawn", format!("起桥读取线程失败: {e}")))?;

        let tail = self.stderr_tail.clone();
        std::thread::Builder::new()
            .name("svn-bridge-err".into())
            .spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    let mut q = tail.lock().unwrap_or_else(|e| e.into_inner());
                    if q.len() >= 20 {
                        q.pop_front();
                    }
                    q.push_back(line);
                }
            })
            .map_err(|e| BridgeError::new("spawn", format!("起桥日志线程失败: {e}")))?;

        Ok(Session {
            child,
            stdin,
            rx,
            next_id: 1,
        })
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 一行请求。转义顺序必须是「先反斜杠」——否则路径里的 `\t` 会被二次转义成字面量。
pub fn encode_request(id: u64, cmd: &str, args: &[&str]) -> String {
    let mut s = String::with_capacity(64);
    s.push_str(&id.to_string());
    s.push('\t');
    s.push_str(&escape(cmd));
    for a in args {
        s.push('\t');
        s.push_str(&escape(a));
    }
    s.push('\n');
    s
}

fn escape(v: &str) -> String {
    let mut s = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            '\\' => s.push_str("\\\\"),
            '\t' => s.push_str("\\t"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            _ => s.push(c),
        }
    }
    s
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let head: String = s.chars().take(n).collect();
    format!("{head}…")
}

/// 桥需要的 jar 列表（顺序无所谓，classpath 是并列的）。
pub const BRIDGE_JARS: [&str; 5] = [
    "ncsvn.jar",
    "svnkit.jar",
    "trilead.jar",
    "sqljet.1.0.4.jar",
    "antlr-runtime-3.1.3.jar",
];

/// 在候选目录里找齐所有 jar，返回 (jar 列表, 所在目录)。
pub fn find_jars(dirs: &[PathBuf]) -> Option<(Vec<PathBuf>, PathBuf)> {
    for dir in dirs {
        let mut jars = Vec::with_capacity(BRIDGE_JARS.len());
        let mut ok = true;
        for name in BRIDGE_JARS {
            let p = dir.join(name);
            if p.is_file() {
                jars.push(p);
            } else {
                ok = false;
                break;
            }
        }
        if ok {
            return Some((jars, dir.clone()));
        }
    }
    None
}

/// 桥的工作目录是否存在（不存在则建）。
pub fn ensure_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败 {dir:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 请求行按协议转义() {
        let line = encode_request(7, "diff", &[r"C:\work\aier\A.java"]);
        assert_eq!(line, "7\tdiff\tC:\\\\work\\\\aier\\\\A.java\n");
    }

    #[test]
    fn 制表符与换行也要转义() {
        let line = encode_request(1, "commit", &["说明\t带制表符\n和换行"]);
        assert_eq!(line, "1\tcommit\t说明\\t带制表符\\n和换行\n");
        assert_eq!(line.matches('\t').count(), 2, "只有两个真分隔符");
    }

    #[test]
    fn 截断按字符不按字节() {
        assert_eq!(truncate("中文中文", 2), "中文…");
        assert_eq!(truncate("abc", 10), "abc");
    }
}
