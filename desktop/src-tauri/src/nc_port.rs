//! 改 NC 中间件的监听端口（写 NC home 里的两份配置）。
//!
//! 为什么本工具可以写 NC home：**每个人的 NC 安装目录都是自己本机独立的**
//! （团队约定 `D:\ncc\19xxhome`，但各人自己装、自己改），不像共享的测试环境那样
//! 会互相干扰。所以「改端口」这件事可以代劳，不需要用户去翻 XML。
//!
//! 但改端口从来不是一个数字的事，一次要动两处：
//!
//! | 文件 | 项 | 作用 |
//! |---|---|---|
//! | `ierp/bin/prop.xml` | `<http><port>` | 中间件监听端口（Tomcat 绑哪个口） |
//! | `hotwebs/web/WEB-INF/classes/system.properties` | `system.ejb.port` | web 端连应用服务器用 |
//!
//! 只改前者，浏览器打开门户会连到旧端口；只改后者，服务起在新端口但网页端还在找旧的。
//! 这两处之外的端口（客户端 `-Dnc.jstart.port`、生成客户端安装包时填的端口）
//! 不在 NC home 里，本模块改不到，只在 `PortPlan.manual` 里列出来提醒。
//!
//! **写入策略：按字节替换，不重新编码。** 两个文件一个声明 gb2312 一个是 UTF-8，
//! 解码再编码会在中文注释上翻车（GB2312 里有些字节序列解不出来，回写就成了乱码）。
//! 而被改的值和标签都是纯 ASCII，在字节上替换既安全又不用判断编码。

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::nc_home;

/// web 端连应用服务器的配置（相对 NC home）。
///
/// `system.ejb.host` 就在同一份里，但它写的是 `localhost` 而不是 IP，
/// 改端口时用不着动它。
pub const WEB_PROPS: &str = "hotwebs/web/WEB-INF/classes/system.properties";

/// web 端用的端口键名。
pub const EJB_PORT_KEY: &str = "system.ejb.port";

/// 一处编辑的目标类型：决定「怎么改」。
///
/// **不要用 `label` 分派**（初版就是 `match edit.label.as_str() { "中间件监听端口" => …
/// , _ => 改 properties }`）：改一个字文案、加第三种目标、以后做双语，都会让 `_` 分支
/// 静默接到别的打补丁函数上——写坏的是用户的 NC 安装目录，而且不报错。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EditKind {
    /// `ierp/bin/prop.xml` 的 `<http><port>`。
    HttpPort,
    /// `system.properties` 的 `system.ejb.port`。
    EjbPort,
}

impl EditKind {
    /// 按类型打补丁。返回 `None` = 文件里没有这一项（或不是纯数字），宁可报错也不猜。
    fn patch(self, bytes: &[u8], port: u16) -> Option<Vec<u8>> {
        match self {
            EditKind::HttpPort => patch_http_port(bytes, port),
            EditKind::EjbPort => patch_prop_port(bytes, EJB_PORT_KEY, port),
        }
    }
}

/// 一处要改的端口。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortEdit {
    /// 绝对路径。
    pub path: String,
    /// 打补丁的类型（写入时按它分派，见 `EditKind`）。
    pub kind: EditKind,
    /// 界面上的说明（「中间件监听端口」/「web 端连接端口」）。**只用于显示**。
    pub label: String,
    /// 文件里的现值；`None` = 文件不存在或没有这一项。
    pub current: Option<u16>,
    pub next: u16,
    /// 文件是否存在。不存在的目标不报错——某些裁剪版安装没有 hotwebs。
    pub exists: bool,
    /// 改前的那一行（去掉首尾空白），预览用。
    pub before: Option<String>,
    /// 改后的那一行（预览用；实际写入时按同一函数重算）。
    /// `None` = 这一项改不了（不是纯数字表达式等），`needs_write` 会跳过它。
    pub after: Option<String>,
}

impl PortEdit {
    /// 这一处需不需要动：文件在、读得到、打得成补丁，且值确实不同。
    ///
    /// `after` 必须存在：值是表达式（`${nc.port}`）时不写——把模板悄悄换成数字
    /// 比报错更难查，用户会以为配置还是原来那套。
    pub fn needs_write(&self) -> bool {
        self.exists
            && self.before.is_some()
            && self.after.is_some()
            && self.current != Some(self.next)
    }

    /// 文件在、这一项也在，但改不了（值不是纯数字）。
    fn blocked_value(&self) -> bool {
        self.exists && self.before.is_some() && self.after.is_none()
    }
}

/// 改端口的完整方案。预览与执行用同一份数据，避免「说的」和「做的」不一致。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortPlan {
    pub new_port: u16,
    /// 当前生效的端口（读自 prop.xml，读不到就是默认 80）。
    pub current_port: u16,
    pub edits: Vec<PortEdit>,
    /// 本工具改不到、需要用户自己同步的地方。
    pub manual: Vec<String>,
    /// 不能执行的原因（服务在跑、端口非法…）。有值时界面禁用「应用」。
    pub blocked: Option<String>,
    /// 能改但值得提醒的事（新端口已被占用、8005 也被占）。
    pub warnings: Vec<String>,
}

impl PortPlan {
    /// 实际会写几个文件（0 表示「已经是这个端口了」）。
    pub fn write_count(&self) -> usize {
        self.edits.iter().filter(|e| e.needs_write()).count()
    }
}

/// 执行结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortApplied {
    pub written: Vec<String>,
    /// 备份文件（同目录 `*.ncforge-bak`，已存在则不覆盖，保住最早的原件）。
    pub backups: Vec<String>,
    /// 写完重新解析 prop.xml 得到的端口。
    pub verified_port: u16,
    /// 复核是否通过（读回来等于目标端口）。false 说明文件写进去了但解析不到，
    /// 属于必须让用户知道的情况（比如配置被别的进程锁着写了一半）。
    pub verified: bool,
}

/// 端口合法性：1~65535，且不与 Tomcat 的 shutdown 端口（`<servicePort>`）相同。
fn validate(port: u16, service_port: Option<u16>) -> Result<(), String> {
    if port == 0 {
        return Err("端口不能是 0".to_string());
    }
    if let Some(sp) = service_port {
        if sp == port {
            return Err(format!(
                "端口 {port} 与 Tomcat 的 shutdown 端口（<servicePort>{sp}</servicePort>）相同，\
                 中间件会起不来；请换一个"
            ));
        }
    }
    Ok(())
}

/// 生成方案（只读，不写任何文件）。
pub fn plan(home: &Path, new_port: u16) -> Result<PortPlan, String> {
    let endpoints = nc_home::read_endpoints(home);
    validate(new_port, endpoints.service_port)?;

    // prop.xml 只读一次：两份编辑要用的字节与「当前端口」都从这一份来，
    // 免得读到一半文件被 sysConfig.bat 改了，出现「预览说 80、实际 8080」。
    let prop_path = home.join(nc_home::SERVER_PROP.replace('/', std::path::MAIN_SEPARATOR_STR));
    let prop_bytes = std::fs::read(&prop_path).ok();
    let web_path = home.join(WEB_PROPS.replace('/', std::path::MAIN_SEPARATOR_STR));

    let edits = vec![
        http_edit(
            &prop_path,
            prop_bytes.as_deref(),
            new_port,
            endpoints.http_port,
        ),
        ejb_edit(&web_path, new_port),
    ];

    let mut plan = PortPlan {
        new_port,
        current_port: endpoints.http_port,
        edits,
        manual: vec![
            "客户端连接端口：Eclipse 里 JStarter 启动配置的 -Dnc.jstart.port（本工具改不到）"
                .to_string(),
            "生成客户端安装包时填的端口（bin/buildmisc.xml 的 ci.port，默认 80）".to_string(),
        ],
        blocked: None,
        warnings: Vec::new(),
    };

    if endpoints.from_config && endpoints.http_port == new_port {
        // 已经是这个端口：不当作错误，界面显示「无需修改」即可
        plan.blocked = Some(format!(
            "当前已经是端口 {new_port}，不用改；直接启动服务即可"
        ));
    } else if new_port < 1024 {
        plan.warnings.push(format!(
            "端口 {new_port} 是系统端口区间（<1024）。Windows 上不需要管理员权限，\
             但更容易被 IIS、SQL Server Reporting Services 这类服务占住"
        ));
    }
    if let Some(sp) = endpoints.service_port {
        plan.warnings.push(format!(
            "Tomcat 的 shutdown 端口是 {sp}；它若被别的进程占着，服务同样起不来"
        ));
    }
    // 值不是纯数字的项：界面照常列出来，但要说清「这一处不会动」——
    // 只说「已应用」而实际上留了个模板表达式，是最难查的那种不一致。
    for e in &plan.edits {
        if e.blocked_value() {
            plan.warnings.push(format!(
                "「{}」的值不是纯数字（可能是变量表达式），本工具不动它，需要你手工改成 {}",
                e.label, new_port
            ));
        }
    }
    Ok(plan)
}

/// `ierp/bin/prop.xml` 的 `<http><port>`。
///
/// `bytes` 由调用方读好传进来（一次读盘，方案里的两处编辑共用同一份快照）。
fn http_edit(path: &Path, bytes: Option<&[u8]>, new_port: u16, current: u16) -> PortEdit {
    let label = "中间件监听端口".to_string();
    let base = PortEdit {
        path: display(path),
        kind: EditKind::HttpPort,
        label,
        current: None,
        next: new_port,
        exists: false,
        before: None,
        after: None,
    };
    let Some(bytes) = bytes else {
        return base;
    };
    let before = http_port_line(bytes);
    let after = patch_http_port(bytes, new_port).and_then(|b| http_port_line(&b));
    PortEdit {
        current: before.as_ref().map(|_| current),
        exists: true,
        before,
        after,
        ..base
    }
}

/// `hotwebs/web/WEB-INF/classes/system.properties` 的 `system.ejb.port`。
fn ejb_edit(path: &Path, new_port: u16) -> PortEdit {
    let base = PortEdit {
        path: display(path),
        kind: EditKind::EjbPort,
        label: "web 端连接端口".to_string(),
        current: None,
        next: new_port,
        exists: false,
        before: None,
        after: None,
    };
    let Ok(bytes) = std::fs::read(path) else {
        return base;
    };
    let before = prop_line(&bytes, EJB_PORT_KEY);
    let current = before.as_deref().and_then(prop_value_u16);
    let after =
        patch_prop_port(&bytes, EJB_PORT_KEY, new_port).and_then(|b| prop_line(&b, EJB_PORT_KEY));
    PortEdit {
        current,
        exists: true,
        before,
        after,
        ..base
    }
}

fn display(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// 真正的写入。内部**重新生成方案**再写：预览到点「应用」之间文件可能被
/// `sysConfig.bat` 改过，照着旧方案写会把用户的改动盖掉。
///
/// 写入顺序刻意做成「全部算好 → 全部备份 → 才落笔」，任何一步失败都回滚已经写过的：
/// 两份配置必须一起变。只改 `prop.xml` 会得到「服务起在新端口、网页打不开」，
/// 只改 `system.properties` 会得到「网页找 8081、服务还在 80」——两种都比不改更难查。
pub fn apply(home: &Path, new_port: u16) -> Result<PortApplied, String> {
    let plan = plan(home, new_port)?;
    if let Some(why) = &plan.blocked {
        return Err(why.clone());
    }
    let todo: Vec<&PortEdit> = plan.edits.iter().filter(|e| e.needs_write()).collect();
    if todo.is_empty() {
        let stuck: Vec<&str> = plan
            .edits
            .iter()
            .filter(|e| e.blocked_value())
            .map(|e| e.label.as_str())
            .collect();
        return Err(if stuck.is_empty() {
            format!("没有需要改的文件（{new_port} 端口可能已经是当前值，或两份配置都找不到）")
        } else {
            format!(
                "{} 的值不是纯数字，本工具改不了；请手工改成 {new_port} 后再试",
                stuck.join("、")
            )
        });
    }

    // 1. 先把每一份的新内容算出来。算不出来就一份都别动。
    struct Prepared {
        path: PathBuf,
        bak: PathBuf,
        original: Vec<u8>,
        patched: Vec<u8>,
    }
    let mut prepared: Vec<Prepared> = Vec::with_capacity(todo.len());
    for edit in &todo {
        let path = PathBuf::from(&edit.path);
        let original = std::fs::read(&path).map_err(|e| format!("读不到 {}：{e}", edit.path))?;
        let patched = edit
            .kind
            .patch(&original, new_port)
            .ok_or_else(|| format!("{} 里没找到要改的那一项，可能被手工改过结构", edit.path))?;
        prepared.push(Prepared {
            bak: backup_path(&path),
            path,
            original,
            patched,
        });
    }

    // 2. 备份 + 写入；失败就把已经写过的用**刚读到的原始字节**还原
    //    （不依赖备份文件读得回来——备份本身也可能是失败的第一步）。
    let mut written: Vec<String> = Vec::new();
    let mut backups = Vec::new();
    let mut done: Vec<(&Path, &[u8])> = Vec::new();
    for item in &prepared {
        // 备份已存在就不覆盖——那一份才是「改动之前」的原件，连改两次时
        // 留着它比留着「第一次改之后」有用得多。
        if !item.bak.exists() {
            if let Err(e) = std::fs::copy(&item.path, &item.bak) {
                return Err(rollback(
                    &done,
                    format!("备份 {} 失败：{e}", item.path.display()),
                ));
            }
        }
        backups.push(display(&item.bak));

        // 直接覆盖写：文件只有几 KB，且已有备份。走「临时文件 + rename」在
        // Windows 上不能覆盖已存在的目标（rename 会 ERROR_ALREADY_EXISTS），
        // 要拆成 remove + rename 反而更不原子。
        if let Err(e) = std::fs::write(&item.path, &item.patched) {
            return Err(rollback(
                &done,
                format!("写入 {} 失败：{e}", item.path.display()),
            ));
        }
        done.push((&item.path, &item.original));
        written.push(display(&item.path));
    }

    let verified_port = nc_home::read_endpoints(home).http_port;
    Ok(PortApplied {
        verified: verified_port == new_port,
        verified_port,
        written,
        backups,
    })
}

/// 把已经写过的文件按原始字节还原，并把原因拼成一条能指导下一步的错误。
///
/// 回滚自身再失败时**不能**只说原错误：用户手里现在是一个双份配置不一致的目录，
/// 必须明确告诉他去哪个文件里找原件。
fn rollback(done: &[(&Path, &[u8])], cause: String) -> String {
    if done.is_empty() {
        return format!("{cause}；没有文件被修改");
    }
    let mut failed: Vec<String> = Vec::new();
    for (path, original) in done {
        if let Err(e) = std::fs::write(path, original) {
            failed.push(format!("{}（{e}）", path.display()));
        }
    }
    if failed.is_empty() {
        format!("{cause}；已回滚改动，两份配置仍是原来的端口")
    } else {
        format!(
            "{cause}；回滚失败：{}。请用同目录下的 .ncforge-bak 手工还原",
            failed.join("、")
        )
    }
}

/// 备份文件路径：`<原名>.ncforge-bak`。
///
/// 不用 `with_extension`：对没有扩展名的文件会拼出 `xxx..ncforge-bak`，
/// 而这里要的是「原文件名后面加后缀」，与有没有扩展名无关。
fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    path.with_file_name(format!("{name}.ncforge-bak"))
}

// ===== 字节级替换（纯函数，单测重点）=====

/// 把 `ierp/bin/prop.xml` 里 `<http>` 块内的 `<port>N</port>` 换成 `new_port`。
///
/// 找不到 `<http>` 块或块内没有合法的 `<port>` 时返回 `None`——宁可报错让用户
/// 去用 `sysConfig.bat`，也不要瞎猜一个数字改掉。
pub fn patch_http_port(bytes: &[u8], new_port: u16) -> Option<Vec<u8>> {
    let body_start = find_open_tag(bytes, b"http", 0)?;
    let body_end = find_bytes(bytes, b"</http>", body_start)?;
    let body = &bytes[body_start..body_end];
    let (num_start, num_end) = find_tag_value_range(body, b"port")?;
    Some(splice(
        bytes,
        body_start + num_start,
        body_start + num_end,
        new_port,
    ))
}

/// 把 properties 里 `key=端口` 的值换成 `new_port`。保留 `=` 两侧原有的空白。
///
/// 与 XML 那边同一条规矩：**只改纯数字**。值是 `${nc.port}` 这类表达式时返回 `None`，
/// 让人工处理——把模板悄悄换成一个固定数字，用户下次看配置会以为自己没改过。
pub fn patch_prop_port(bytes: &[u8], key: &str, new_port: u16) -> Option<Vec<u8>> {
    let (start, end) = find_prop_value_range(bytes, key.as_bytes())?;
    if !bytes[start..end].iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(splice(bytes, start, end, new_port))
}

/// 取出 prop.xml 里被改的那一行（`<port>80</port>`），预览用。
fn http_port_line(bytes: &[u8]) -> Option<String> {
    let body_start = find_open_tag(bytes, b"http", 0)?;
    let body_end = find_bytes(bytes, b"</http>", body_start)?;
    let body = &bytes[body_start..body_end];
    let (s, e) = find_tag_value_range(body, b"port")?;
    // 从 `<port>` 往前退到 `<`，往后延到 `</port>` 结尾，取整段
    let open = body[..s].iter().rposition(|b| *b == b'<')?;
    let close = find_bytes(body, b"</port>", e)? + b"</port>".len();
    Some(
        String::from_utf8_lossy(&body[open..close])
            .trim()
            .to_string(),
    )
}

/// 取出 properties 里 `key=` 的那一整行。
fn prop_line(bytes: &[u8], key: &str) -> Option<String> {
    let (start, end) = find_prop_value_range(bytes, key.as_bytes())?;
    let line_start = bytes[..start]
        .iter()
        .rposition(|b| *b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let line_end = bytes[end..]
        .iter()
        .position(|b| *b == b'\n' || *b == b'\r')
        .map(|i| end + i)
        .unwrap_or(bytes.len());
    Some(
        String::from_utf8_lossy(&bytes[line_start..line_end])
            .trim()
            .to_string(),
    )
}

/// `key=80` 里 `80` 的字节范围。跳过前导空白，取到行尾前的最后一个非空白字节。
fn find_prop_value_range(bytes: &[u8], key: &[u8]) -> Option<(usize, usize)> {
    let mut line_start = 0usize;
    while line_start < bytes.len() {
        let line_end = bytes[line_start..]
            .iter()
            .position(|b| *b == b'\n' || *b == b'\r')
            .map(|i| line_start + i)
            .unwrap_or(bytes.len());
        let line = &bytes[line_start..line_end];
        let trimmed = skip_ws(line, 0);
        // 注释行不是配置
        let is_comment = matches!(line.get(trimmed), Some(b'#') | Some(b'!'));
        if !is_comment && line[trimmed..].starts_with(key) {
            let after_key = trimmed + key.len();
            // key 后必须紧跟分隔符或空白，否则是 `system.ejb.port2=...`
            let ok = match line.get(after_key) {
                Some(b'=') | Some(b':') => true,
                Some(c) => c.is_ascii_whitespace(),
                None => false,
            };
            if !ok {
                line_start = line_end + 1;
                continue;
            }
            let sep = skip_ws(line, after_key);
            let value_at = if matches!(line.get(sep), Some(b'=') | Some(b':')) {
                skip_ws(line, sep + 1)
            } else {
                sep
            };
            let value_end = line
                .iter()
                .rposition(|b| !b.is_ascii_whitespace())
                .map(|i| i + 1)
                .unwrap_or(value_at);
            if value_at < value_end {
                return Some((line_start + value_at, line_start + value_end));
            }
        }
        line_start = line_end + 1;
    }
    None
}

/// 从 `from` 开始找 `<tag>` 或 `<tag ...>`，返回开标签 `>` 之后的位置。
fn find_open_tag(bytes: &[u8], tag: &[u8], from: usize) -> Option<usize> {
    let mut marker = Vec::with_capacity(tag.len() + 1);
    marker.push(b'<');
    marker.extend_from_slice(tag);
    let mut at = from;
    while let Some(i) = find_bytes(bytes, &marker, at) {
        // `i` 已经是相对整个 bytes 的绝对位置（find_bytes 内部把 from 加回去了），
        // 这里不能写成 `at + i + len`——那会把偏移加两遍。
        let after = i + marker.len();
        // `<http>` 与 `<https>` 前缀相同，必须看紧跟其后的字节
        match bytes.get(after) {
            Some(b'>') => return Some(after + 1),
            Some(c) if c.is_ascii_whitespace() => {
                return bytes[after..]
                    .iter()
                    .position(|b| *b == b'>')
                    .map(|p| after + p + 1)
            }
            _ => at = after,
        }
    }
    None
}

/// `<tag>值</tag>` 里「值」的字节范围（相对传入的切片）。
fn find_tag_value_range(body: &[u8], tag: &[u8]) -> Option<(usize, usize)> {
    let mut open = Vec::with_capacity(tag.len() + 2);
    open.push(b'<');
    open.extend_from_slice(tag);
    open.push(b'>');
    let mut close = Vec::with_capacity(tag.len() + 3);
    close.extend_from_slice(b"</");
    close.extend_from_slice(tag);
    close.push(b'>');

    let start = find_bytes(body, &open, 0)? + open.len();
    let end = find_bytes(body, &close, start)?;
    let (s, e) = trim_range(body, start, end);
    // 值必须是纯数字，否则这处不是我们要改的（比如已经被写成表达式）
    if s >= e || !body[s..e].iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((s, e))
}

fn trim_range(bytes: &[u8], start: usize, end: usize) -> (usize, usize) {
    let mut s = start;
    let mut e = end;
    while s < e && bytes[s].is_ascii_whitespace() {
        s += 1;
    }
    while e > s && bytes[e - 1].is_ascii_whitespace() {
        e -= 1;
    }
    (s, e)
}

fn skip_ws(bytes: &[u8], from: usize) -> usize {
    let mut i = from;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    i
}

fn find_bytes(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| from + i)
}

fn splice(bytes: &[u8], start: usize, end: usize, port: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 5);
    out.extend_from_slice(&bytes[..start]);
    out.extend_from_slice(port.to_string().as_bytes());
    out.extend_from_slice(&bytes[end..]);
    out
}

/// 从 properties 行的完整文本里取端口值，用于展示与判断「是否已相同」。
fn prop_value_u16(line: &str) -> Option<u16> {
    let (_, v) = line.split_once('=').or_else(|| line.split_once(':'))?;
    v.trim().parse::<u16>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PROP: &str = "<?xml version=\"1.0\" encoding='gb2312'?>\n\
\t<root>\n\t\t<domain>\n\t\t\t<server>\n\t\t\t\t<name>xuyserver</name>\n\
\t\t\t\t<servicePort>8005</servicePort>\n\t\t\t\t<http>\n\t\t\t\t\t<address>127.0.0.1</address>\n\
\t\t\t\t\t<port>80</port>\n\t\t\t\t</http>\n\t\t\t</server>\n\t\t</domain>\n</root>\n";

    fn tmp_home(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncforge-port-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("ierp").join("bin")).unwrap();
        fs::create_dir_all(
            d.join("hotwebs")
                .join("web")
                .join("WEB-INF")
                .join("classes"),
        )
        .unwrap();
        d
    }

    fn write_props(d: &Path, body: &str) {
        fs::write(d.join("ierp").join("bin").join("prop.xml"), body.as_bytes()).unwrap();
    }

    fn write_web(d: &Path, body: &str) {
        fs::write(
            d.join("hotwebs")
                .join("web")
                .join("WEB-INF")
                .join("classes")
                .join("system.properties"),
            body.as_bytes(),
        )
        .unwrap();
    }

    #[test]
    fn 改_http_块里的端口不动_shutdown_端口() {
        let out = patch_http_port(PROP.as_bytes(), 8081).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("<port>8081</port>"), "{s}");
        assert!(
            s.contains("<servicePort>8005</servicePort>"),
            "shutdown 端口不能被改：{s}"
        );
        assert!(
            s.contains("<address>127.0.0.1</address>"),
            "地址不能被改：{s}"
        );
    }

    #[test]
    fn https_块不会被当成_http_块() {
        // `<https>` 排在前面：先匹配到的 `<http` 后面是 `s`，必须跳过
        let s = "<root>\n<https>\n<port>443</port>\n</https>\n<http>\n<port>80</port>\n</http>\n</root>";
        let out = patch_http_port(s.as_bytes(), 8081).unwrap();
        let got = String::from_utf8(out).unwrap();
        assert!(
            got.contains("<port>443</port>"),
            "https 的端口不能动：{got}"
        );
        assert!(got.contains("<port>8081</port>"), "{got}");
    }

    #[test]
    fn 缺_http_块时拒绝而不是瞎猜() {
        let s = "<root>\n<server>\n<port>80</port>\n</server>\n</root>";
        assert_eq!(patch_http_port(s.as_bytes(), 8081), None);
    }

    #[test]
    fn 端口值不是数字时拒绝() {
        let s = "<http>\n<port>${nc.port}</port>\n</http>";
        assert_eq!(patch_http_port(s.as_bytes(), 8081), None);
    }

    #[test]
    fn 开标签带属性的_http_也能改() {
        let s = "<http servlet=\"true\">\n<port>80</port>\n</http>";
        let got = String::from_utf8(patch_http_port(s.as_bytes(), 9090).unwrap()).unwrap();
        assert!(got.contains("<port>9090</port>"), "{got}");
    }

    #[test]
    fn 改_properties_里的端口并保留注释与空白() {
        let s = "#系统配置\nsystem.ejb.host=localhost\nsystem.ejb.port=80\nsystem.dataSource=\n";
        let got =
            String::from_utf8(patch_prop_port(s.as_bytes(), EJB_PORT_KEY, 8081).unwrap()).unwrap();
        assert!(got.contains("system.ejb.port=8081"), "{got}");
        assert!(
            got.contains("system.ejb.host=localhost"),
            "别的键不能动：{got}"
        );
        assert!(got.contains("#系统配置"), "注释要原样保留：{got}");
    }

    #[test]
    fn properties_带空格的写法也能改() {
        let s = "system.ejb.port = 80  \n";
        let got =
            String::from_utf8(patch_prop_port(s.as_bytes(), EJB_PORT_KEY, 8081).unwrap()).unwrap();
        // 行尾的两个空格是格式，替换只动值本身
        assert_eq!(
            got,
            "system.ejb.port = 8081  
"
        );
    }

    #[test]
    fn 前缀相同的键不会被误改() {
        let s = "system.ejb.port2=9999\nsystem.ejb.port=80\n";
        let got =
            String::from_utf8(patch_prop_port(s.as_bytes(), EJB_PORT_KEY, 8081).unwrap()).unwrap();
        assert!(got.contains("system.ejb.port2=9999"), "{got}");
        assert!(got.contains("system.ejb.port=8081"), "{got}");
    }

    #[test]
    fn 注释掉的端口不当作配置() {
        let s = "#system.ejb.port=80\nsystem.ejb.port=81\n";
        let got =
            String::from_utf8(patch_prop_port(s.as_bytes(), EJB_PORT_KEY, 8081).unwrap()).unwrap();
        assert!(got.contains("#system.ejb.port=80"), "{got}");
        assert!(got.contains("system.ejb.port=8081"), "{got}");
    }

    #[test]
    fn 方案列出两处且读出当前端口() {
        let d = tmp_home("plan");
        write_props(&d, PROP);
        write_web(&d, "system.ejb.host=localhost\nsystem.ejb.port=80\n");
        let p = plan(&d, 8081).unwrap();
        assert_eq!(p.current_port, 80);
        assert_eq!(p.edits.len(), 2);
        assert_eq!(p.write_count(), 2);
        assert_eq!(p.edits[0].current, Some(80));
        assert_eq!(p.edits[1].current, Some(80));
        assert!(p.blocked.is_none(), "{:?}", p.blocked);
        assert!(!p.manual.is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn 端口没变时给出明确说明而不是报错() {
        let d = tmp_home("same");
        write_props(&d, PROP);
        let p = plan(&d, 80).unwrap();
        assert_eq!(p.write_count(), 0);
        assert!(p.blocked.unwrap().contains("已经是端口 80"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn 与_shutdown_端口相同时拒绝() {
        let d = tmp_home("conflict");
        write_props(&d, PROP);
        let e = plan(&d, 8005).unwrap_err();
        assert!(e.contains("8005"), "{e}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn 只改大小写之外的极端端口值() {
        let d = tmp_home("max");
        write_props(&d, PROP);
        let p = plan(&d, 65535).unwrap();
        assert_eq!(p.edits[0].after.as_deref(), Some("<port>65535</port>"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn 应用后能读回新端口并留备份() {
        let d = tmp_home("apply");
        write_props(&d, PROP);
        write_web(&d, "system.ejb.port=80\n");
        let r = apply(&d, 8081).unwrap();
        assert_eq!(r.written.len(), 2);
        assert_eq!(r.verified_port, 8081);
        assert!(r.verified);
        assert_eq!(r.backups.len(), 2);
        for b in &r.backups {
            assert!(Path::new(b).is_file(), "备份要真的存在：{b}");
        }
        // 再改一次：备份不能被覆盖成「第一次改之后」的结果
        let r2 = apply(&d, 9090).unwrap();
        assert_eq!(r2.verified_port, 9090);
        let bak = PathBuf::from(&r.backups[0]);
        let orig = fs::read_to_string(&bak).unwrap();
        assert!(orig.contains("<port>80</port>"), "备份仍是原始值：{orig}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn 缺_web_配置时仍能改中间件端口() {
        let d = tmp_home("nohotwebs");
        write_props(&d, PROP);
        let p = plan(&d, 8081).unwrap();
        assert_eq!(p.write_count(), 1, "只有 prop.xml 需要改");
        assert!(!p.edits[1].exists);
        let r = apply(&d, 8081).unwrap();
        assert!(r.verified);
        assert_eq!(r.written.len(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn 没有_nc_home_时报错而不是写坏文件() {
        let d = tmp_home("empty");
        let e = plan(&d, 8081).unwrap();
        assert_eq!(e.write_count(), 0);
        assert!(apply(&d, 8081).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    /// 值不是纯数字（模板表达式）时不写：悄悄把 `${nc.port}` 换成 8081，
    /// 用户下次打开配置会以为自己没改过。
    #[test]
    fn 值不是数字时不动它并给出提醒() {
        let d = tmp_home("templated");
        write_props(&d, PROP);
        write_web(&d, "system.ejb.port=${nc.port}\n");
        let p = plan(&d, 8081).unwrap();
        assert_eq!(p.write_count(), 1, "只有 prop.xml 该改");
        assert!(
            p.warnings.iter().any(|w| w.contains("不是纯数字")),
            "要提醒 web 端没动：{:?}",
            p.warnings
        );
        assert_eq!(p.edits[1].after, None);
        let r = apply(&d, 8081).unwrap();
        assert!(r.verified);
        let web = d
            .join("hotwebs")
            .join("web")
            .join("WEB-INF")
            .join("classes")
            .join("system.properties");
        assert_eq!(
            fs::read_to_string(&web).unwrap(),
            "system.ejb.port=${nc.port}\n",
            "模板表达式必须原样保留"
        );
        let _ = fs::remove_dir_all(&d);
    }

    /// 两份配置必须一起变。第二份写不进去时要**回滚第一份**——
    /// 否则就是「服务起在新端口、网页打不开」，正是这个模块要防的状态。
    #[test]
    fn 第二份写失败时回滚第一份() {
        let d = tmp_home("rollback");
        write_props(&d, PROP);
        let web = d
            .join("hotwebs")
            .join("web")
            .join("WEB-INF")
            .join("classes")
            .join("system.properties");
        write_web(&d, "system.ejb.port=80\n");

        // 把 web 端设成只读，模拟「被别的进程占着 / 权限不足」
        let readonly = |on: bool| {
            let mut p = fs::metadata(&web).unwrap().permissions();
            p.set_readonly(on);
            fs::set_permissions(&web, p).unwrap();
        };
        readonly(true);
        // 前置自检：有的文件系统/账户下只读拦不住写，那就没法测这条
        if fs::write(&web, b"x").is_ok() {
            readonly(false);
            let _ = fs::remove_dir_all(&d);
            return;
        }

        let err = apply(&d, 8081).unwrap_err();
        assert!(err.contains("已回滚"), "错误要说清回滚结果：{err}");
        assert!(
            fs::read_to_string(d.join("ierp").join("bin").join("prop.xml"))
                .unwrap()
                .contains("<port>80</port>"),
            "第一份必须还原成 80"
        );
        readonly(false);
        let _ = fs::remove_dir_all(&d);
    }

    /// 备份名按「原文件名 + 后缀」拼，与有没有扩展名无关。
    #[test]
    fn 备份名不依赖扩展名() {
        let d = tmp_home("bakname");
        write_props(&d, PROP);
        write_web(&d, "system.ejb.port=80\n");
        let r = apply(&d, 8081).unwrap();
        assert!(
            r.backups
                .iter()
                .any(|b| b.ends_with("prop.xml.ncforge-bak")),
            "{:?}",
            r.backups
        );
        assert!(
            r.backups
                .iter()
                .any(|b| b.ends_with("system.properties.ncforge-bak")),
            "{:?}",
            r.backups
        );
        let _ = fs::remove_dir_all(&d);
    }
}
