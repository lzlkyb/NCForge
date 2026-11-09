//! 从 DataGrip / PL/SQL Developer 的配置里读连接（只读结构，口令一律不要）。
//!
//! 两家都不向外导出可用的口令：DataGrip 的设置导出本来就不含密码，PL/SQL Developer
//! 的登录历史是加密串。反向解密既不可靠、也不该做——所以这里只产出「连接串 + 用户名」，
//! 口令留给首次连接时既有的口令提示补上。
//!
//! 本模块不碰 IPC、不落盘：解析是纯函数，扫描只读本机已知路径，单测直接喂字符串。
//! 命令层（`commands/db_conn_cmds.rs`）负责把结果与已有连接比对、写进配置。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config::DbConnConfig;
use crate::db_conns;

/// 一次导入扫描的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScan {
    /// 读了哪些文件 / 哪个入口（界面显示「来源」）。
    pub source: String,
    pub items: Vec<Candidate>,
    /// 整批提示（读不到用户名、跳过了非 Oracle、口令不会导入等）。
    pub warnings: Vec<String>,
}

/// 一条可导入的连接。`duplicate` / `near` 由 [`mark_existing`] 对着现有连接填。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// 界面勾选用；同一批扫描内唯一。
    pub key: String,
    pub name: String,
    pub url: String,
    pub user: String,
    /// `datagrip` / `plsql`：决定写进 note 的来源说明。
    pub tool: String,
    /// 来自哪个文件 / 哪个节点，界面用 title 显示。
    pub origin: String,
    /// 这一条自身的提示（SID 写法、多地址只取第一个、缺用户名等）。
    pub warning: Option<String>,
    /// 连接列表里已有同一个库 + 同一个用户。
    pub duplicate: bool,
    /// 同一个库但写法不同 / 用户不同，选择时提示但不禁用。
    pub near: Option<String>,
}

/// 前端点「添加」时交回来的一条（只带必要字段，避免整份扫描结果过桥）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWant {
    pub name: String,
    pub url: String,
    pub user: String,
    pub tool: String,
}

/// 规范化后的 Oracle 目标。存成结构化字段而不是原串：判断「同一个库」时
/// `//h:1521/svc` 与 `h:1521:svc` 不能因为写法不同就被当成两条。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleTarget {
    pub host: String,
    pub port: u16,
    pub service: String,
    /// true = SID 写法（`@host:port:sid`）；false = 服务名写法（`@//host:port/service`）。
    pub sid: bool,
}

impl OracleTarget {
    pub fn url(&self) -> String {
        if self.sid {
            format!(
                "jdbc:oracle:thin:@{}:{}:{}",
                self.host, self.port, self.service
            )
        } else {
            format!(
                "jdbc:oracle:thin:@//{}:{}/{}",
                self.host, self.port, self.service
            )
        }
    }

    /// 严格同一目标（连写法也要一致）。
    fn ident(&self) -> String {
        format!(
            "{}:{}:{}/{}",
            self.host.to_ascii_lowercase(),
            self.port,
            self.service.to_ascii_lowercase(),
            if self.sid { "sid" } else { "svc" }
        )
    }

    /// 同一个库（主机 / 端口 / 名字相同），忽略 SID 与服务名写法的差别。
    fn endpoint(&self) -> String {
        format!(
            "{}:{}:{}",
            self.host.to_ascii_lowercase(),
            self.port,
            self.service.to_ascii_lowercase()
        )
    }
}

/// 解析 JDBC / TNS 风格的 Oracle 连接串，产出可规范化回写的目标。
///
/// 认这些写法（DataGrip 与手写配置里都会出现）：
/// - `jdbc:oracle:thin:@//host:1521/service`
/// - `jdbc:oracle:thin:@host:1521:SID`
/// - `jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=…)(CONNECT_DATA=…))`
/// - 内嵌凭据 `jdbc:oracle:thin:user/pwd@…`（口令只用来判断「有没有」，绝不回写）
pub fn parse_oracle_target(raw: &str) -> Result<OracleTarget, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("连接串是空的".to_string());
    }
    let lower = text.to_ascii_lowercase();
    let rest = if lower.starts_with("jdbc:oracle:thin:@") {
        &text["jdbc:oracle:thin:@".len()..]
    } else if lower.starts_with("jdbc:oracle:thin:") {
        &text["jdbc:oracle:thin:".len()..]
    } else if lower.starts_with("jdbc:") {
        return Err("不是 Oracle JDBC 连接串".to_string());
    } else {
        text
    };
    // 查询参数（`?useSSL=false` 之类）不属于目标。
    let rest = rest.split('?').next().unwrap_or(rest).trim();
    // 内嵌凭据：取最后一个 `@` 之后的部分（密码里即使有 `@` 也不会切错到前面）。
    let rest = match rest.rfind('@') {
        Some(at) => rest[at + 1..].trim(),
        None => rest,
    };
    let rest = rest.strip_prefix("//").unwrap_or(rest).trim();
    if rest.is_empty() {
        return Err("连接串缺少主机与服务名".to_string());
    }
    if rest.starts_with('(') {
        return parse_description(rest);
    }
    if let Some(slash) = rest.find('/') {
        let (host_port, service) = (&rest[..slash], &rest[slash + 1..]);
        let (host, port) = split_host_port(host_port)?;
        return build_target(host.to_string(), port, service.to_string(), false);
    }
    let parts: Vec<&str> = rest.split(':').collect();
    match parts.len() {
        3 => build_target(
            parts[0].to_string(),
            parse_port(parts[1])?,
            parts[2].to_string(),
            true,
        ),
        2 => Err("连接串缺少服务名 / SID（形如 host:1521:ORCL）".to_string()),
        1 => Err(format!(
            "「{rest}」是 TNS 别名，需要 tnsnames.ora 才能解析；请用「PL/SQL Developer」一栏的扫描，或手动填写"
        )),
        _ => Err("连接串里的主机部分无法识别".to_string()),
    }
}

fn parse_description(text: &str) -> Result<OracleTarget, String> {
    let host = value_of(text, "HOST").ok_or_else(|| "连接描述里没有 HOST".to_string())?;
    let port = match value_of(text, "PORT") {
        Some(p) => parse_port(&p)?,
        None => 1521,
    };
    let service = value_of(text, "SERVICE_NAME");
    let sid = value_of(text, "SID");
    let (service, is_sid) = match (service, sid) {
        (Some(s), _) => (s, false),
        (None, Some(s)) => (s, true),
        _ => return Err("连接描述里没有 SERVICE_NAME / SID".to_string()),
    };
    build_target(host, port, service, is_sid)
}

/// 连接串里有没有内嵌凭据：`thin:user/pwd@…` 与 `thin:@…` 的区别。
pub fn embedded_credentials(raw: &str) -> bool {
    let text = raw.trim();
    let lower = text.to_ascii_lowercase();
    let rest = if lower.starts_with("jdbc:oracle:thin:") {
        &text["jdbc:oracle:thin:".len()..]
    } else {
        text
    };
    !rest.trim_start().starts_with('@') && rest.contains('@')
}

fn split_host_port(s: &str) -> Result<(&str, u16), String> {
    match s.split_once(':') {
        Some((host, port)) => Ok((host.trim(), parse_port(port.trim())?)),
        None => Ok((s.trim(), 1521)),
    }
}

fn parse_port(s: &str) -> Result<u16, String> {
    let p: u16 = s.parse().map_err(|_| format!("端口「{s}」不是数字"))?;
    if p == 0 {
        return Err("端口不能是 0".to_string());
    }
    Ok(p)
}

fn build_target(
    host: String,
    port: u16,
    service: String,
    sid: bool,
) -> Result<OracleTarget, String> {
    let host = host.trim().to_string();
    let service = service.trim().to_string();
    if !valid_host(&host) {
        return Err(format!("主机名「{host}」不合法"));
    }
    if !valid_name(&service) {
        return Err(format!("服务名 / SID「{service}」不合法"));
    }
    Ok(OracleTarget {
        host,
        port,
        service,
        sid,
    })
}

fn valid_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// 服务名 / SID / TNS 别名共用的字符集。Oracle 里常见 `$` `#`，NC 的服务名里也有点。
fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '$' | '#'))
}

/// 在 `(KEY = value)` 形式的描述串里找值（忽略大小写，容忍空白）。
fn value_of(text: &str, key: &str) -> Option<String> {
    let pos = *key_positions(text, key).first()?;
    let end = text[pos..].find(')')? + pos;
    let v = text[pos..end].trim().trim_matches('"').trim();
    (!v.is_empty()).then(|| v.to_string())
}

fn count_key(text: &str, key: &str) -> usize {
    key_positions(text, key).len()
}

/// 返回每个 `(KEY =` 里 `=` 之后的位置。
fn key_positions(text: &str, key: &str) -> Vec<usize> {
    let b = text.as_bytes();
    let k = key.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'(' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j + k.len() < b.len() && b[j..j + k.len()].eq_ignore_ascii_case(k) {
            let mut e = j + k.len();
            while e < b.len() && b[e].is_ascii_whitespace() {
                e += 1;
            }
            if e < b.len() && b[e] == b'=' {
                out.push(e + 1);
            }
        }
        i += 1;
    }
    out
}

// ─── DataGrip ───────────────────────────────────────────────────────────────

/// settings.zip 的总大小上限：设置导出里绝大多数是图标和词典，数据源只占很小一块。
pub const MAX_ZIP_BYTES: usize = 32 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ZIP_UNPACKED: u64 = 32 * 1024 * 1024;

/// 解析 DataGrip 导出 / 项目里的 `dataSources.xml`。
pub fn scan_datagrip(main: &str, local: Option<&str>, origin: &str) -> ImportScan {
    let (mut items, mut warnings) = datagrip_candidates(main, local, origin);
    if items.iter().any(|c| c.user.is_empty()) {
        warnings.push(
            "有的数据源没读到用户名（DataGrip 把用户名放在 dataSources.local.xml 或本机钥匙串）：\
             导入后在连接设置里补上"
                .to_string(),
        );
    }
    number_keys(&mut items);
    ImportScan {
        source: match local {
            Some(_) => format!("{origin} + dataSources.local.xml"),
            None => origin.to_string(),
        },
        items,
        warnings,
    }
}

/// 解析 DataGrip 的 `settings.zip`（只读白名单里的两个数据源文件）。
pub fn scan_datagrip_zip(bytes: &[u8]) -> Result<ImportScan, String> {
    use std::io::Read;

    if bytes.len() > MAX_ZIP_BYTES {
        return Err(format!(
            "settings.zip 超过 {}MB，请只导出 Database 组件（global data sources）后再试",
            MAX_ZIP_BYTES / 1024 / 1024
        ));
    }
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("不是有效的 zip：{e}"))?;
    let mut mains: Vec<(String, String)> = Vec::new();
    let mut locals: Vec<String> = Vec::new();
    let mut warnings = Vec::new();
    let mut unpacked: u64 = 0;
    for i in 0..zip.len() {
        let entry = zip
            .by_index(i)
            .map_err(|e| format!("读 zip 第 {i} 个条目失败：{e}"))?;
        let name = entry.name().replace('\\', "/");
        let base = name.rsplit('/').next().unwrap_or("");
        if base != "dataSources.xml" && base != "dataSources.local.xml" {
            continue;
        }
        if entry.size() > MAX_ZIP_ENTRY_BYTES {
            warnings.push(format!("{name} 解压后超过 8MB，已跳过"));
            continue;
        }
        unpacked += entry.size();
        if unpacked > MAX_ZIP_UNPACKED {
            return Err("settings.zip 里的数据源文件总大小超过 32MB".to_string());
        }
        let mut buf = Vec::new();
        entry
            .take(MAX_ZIP_ENTRY_BYTES + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("读 {name} 失败：{e}"))?;
        if buf.len() as u64 > MAX_ZIP_ENTRY_BYTES {
            warnings.push(format!("{name} 解压后超过 8MB，已跳过"));
            continue;
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        if base == "dataSources.xml" {
            mains.push((name, text));
        } else {
            locals.push(text);
        }
    }
    if mains.is_empty() {
        return Ok(ImportScan {
            source: "settings.zip".to_string(),
            items: Vec::new(),
            warnings: vec![
                "settings.zip 里没有全局数据源。导出时要勾选「Database: drivers / settings / \
                 global data sources」里的 global data sources"
                    .to_string(),
            ],
        });
    }
    let local = locals.join("\n");
    let mut items = Vec::new();
    for (name, text) in mains {
        let (mut found, mut w) = datagrip_candidates(
            &text,
            (!local.trim().is_empty()).then_some(local.as_str()),
            &format!("settings.zip · {name}"),
        );
        items.append(&mut found);
        warnings.append(&mut w);
    }
    dedup(&mut items);
    number_keys(&mut items);
    if items.iter().any(|c| c.user.is_empty()) {
        warnings.push("有的数据源没读到用户名：导入后在连接设置里补上".to_string());
    }
    Ok(ImportScan {
        source: "settings.zip".to_string(),
        items,
        warnings,
    })
}

fn datagrip_candidates(
    main: &str,
    local: Option<&str>,
    origin: &str,
) -> (Vec<Candidate>, Vec<String>) {
    let (by_uuid, by_name) = local.map(parse_dg_users).unwrap_or_default();
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    let mut non_oracle = 0usize;
    for block in blocks(main, "data-source") {
        let head = head_of(block);
        let name_attr = attr(head, "name").unwrap_or_default();
        let Some(url) = tag_text(block, "jdbc-url") else {
            continue;
        };
        let driver = tag_text(block, "driver-ref").unwrap_or_default();
        if !driver.eq_ignore_ascii_case("oracle")
            && !url.to_ascii_lowercase().starts_with("jdbc:oracle:")
        {
            non_oracle += 1;
            continue;
        }
        let user = tag_text(block, "user-name")
            .or_else(|| {
                attr(head, "uuid").and_then(|u| by_uuid.get(&u.to_ascii_lowercase()).cloned())
            })
            .or_else(|| {
                (!name_attr.trim().is_empty())
                    .then(|| by_name.get(&name_attr.to_ascii_lowercase()).cloned())
                    .flatten()
            })
            .unwrap_or_default();
        match parse_oracle_target(&url) {
            Ok(target) => {
                let mut warning = None;
                if embedded_credentials(&url) {
                    warning = Some("连接串里带的口令不会导入：首次连接时输一次".to_string());
                }
                if count_key(&url, "ADDRESS") > 1 {
                    warning = Some("连接串里有多个地址，只导入了第一个".to_string());
                }
                let display = if name_attr.trim().is_empty() {
                    target.service.clone()
                } else {
                    name_attr.trim().to_string()
                };
                items.push(Candidate {
                    key: String::new(),
                    name: display,
                    url: target.url(),
                    user,
                    tool: "datagrip".to_string(),
                    origin: origin.to_string(),
                    warning,
                    duplicate: false,
                    near: None,
                });
            }
            Err(e) => {
                let label = if name_attr.trim().is_empty() {
                    url.trim().to_string()
                } else {
                    name_attr.trim().to_string()
                };
                warnings.push(format!("跳过 DataGrip 数据源「{label}」：{e}"));
            }
        }
    }
    if non_oracle > 0 {
        warnings.push(format!("跳过了 {non_oracle} 个非 Oracle 数据源"));
    }
    (items, warnings)
}

/// 从 `dataSources.local.xml` 读 uuid / 名字两套索引（uuid 优先）。
fn parse_dg_users(local: &str) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut by_uuid = HashMap::new();
    let mut by_name = HashMap::new();
    for block in blocks(local, "data-source") {
        let head = head_of(block);
        let Some(user) = tag_text(block, "user-name") else {
            continue;
        };
        if let Some(uuid) = attr(head, "uuid") {
            by_uuid.insert(uuid.to_ascii_lowercase(), user.clone());
        }
        if let Some(name) = attr(head, "name") {
            by_name.insert(name.to_ascii_lowercase(), user);
        }
    }
    (by_uuid, by_name)
}

/// 取 XML 里所有 `<tag …>…</tag>` 片段（不处理嵌套，本文档里也不需要）。
fn blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(found) = xml[pos..].find(&open) {
        let start = pos + found;
        let after = start + open.len();
        // 必须是完整的标签名：`<data-sources>` 不能当成 `<data-source>`。
        let boundary = matches!(
            xml.as_bytes().get(after).copied(),
            Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n') | Some(b'>') | Some(b'/')
        );
        if !boundary {
            pos = after;
            continue;
        }
        let Some(close_at) = xml[start..].find(&close) else {
            break;
        };
        let end = start + close_at + close.len();
        out.push(&xml[start..end]);
        pos = end;
    }
    out
}

fn head_of(block: &str) -> &str {
    match block.find('>') {
        Some(i) => &block[..i],
        None => block,
    }
}

/// 读 XML 属性。要求键前面是空白或 `<`，避免把 `driver-name` 当成 `name`。
fn attr(head: &str, key: &str) -> Option<String> {
    let b = head.as_bytes();
    let k = key.as_bytes();
    let mut i = 0;
    while let Some(found) = head[i..].find(key) {
        let pos = i + found;
        let before_ok = pos == 0
            || matches!(
                b.get(pos.wrapping_sub(1)).copied(),
                Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n') | Some(b'<')
            );
        let after = pos + k.len();
        if before_ok {
            let mut j = after;
            while j < b.len() && matches!(b[j], b' ' | b'\t') {
                j += 1;
            }
            if j < b.len() && b[j] == b'=' {
                j += 1;
                while j < b.len() && matches!(b[j], b' ' | b'\t') {
                    j += 1;
                }
                if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
                    let quote = b[j] as char;
                    let start = j + 1;
                    if let Some(end) = head[start..].find(quote) {
                        return Some(head[start..start + end].to_string());
                    }
                }
            }
        }
        i = after;
    }
    None
}

fn tag_text(block: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&close)? + start;
    let v = block[start..end].trim();
    (!v.is_empty()).then(|| v.to_string())
}

// ─── tnsnames.ora ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct TnsEntry {
    pub alias: String,
    pub target: OracleTarget,
    pub warning: Option<String>,
}

/// 解析 `tnsnames.ora`。只认单个 TCP ADDRESS；TCPS / IPC 与多地址 RAC 会明确告警。
pub fn parse_tnsnames(text: &str) -> (Vec<TnsEntry>, Vec<String>) {
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    for (names, body) in split_tns_entries(text) {
        let alias = names[0].clone();
        if alias.eq_ignore_ascii_case("ifile") {
            warnings.push(format!(
                "tnsnames.ora 里有 IFILE 引用，未展开：{}",
                body.trim()
            ));
            continue;
        }
        if let Some(proto) = value_of(&body, "PROTOCOL") {
            if !proto.eq_ignore_ascii_case("TCP") {
                warnings.push(format!(
                    "TNS 别名 {alias} 用的是 {proto}（不是 TCP），暂不支持"
                ));
                continue;
            }
        }
        let Some(host) = value_of(&body, "HOST") else {
            warnings.push(format!("TNS 别名 {alias} 没有 HOST，已跳过"));
            continue;
        };
        let port = match value_of(&body, "PORT") {
            Some(p) => match parse_port(&p) {
                Ok(p) => p,
                Err(e) => {
                    warnings.push(format!("TNS 别名 {alias}：{e}"));
                    continue;
                }
            },
            None => 1521,
        };
        let service = value_of(&body, "SERVICE_NAME");
        let sid = value_of(&body, "SID");
        let (service, is_sid) = match (service, sid) {
            (Some(s), _) => (s, false),
            (None, Some(s)) => (s, true),
            _ => {
                warnings.push(format!("TNS 别名 {alias} 没有 SERVICE_NAME / SID，已跳过"));
                continue;
            }
        };
        let target = match build_target(host, port, service, is_sid) {
            Ok(t) => t,
            Err(e) => {
                warnings.push(format!("TNS 别名 {alias}：{e}"));
                continue;
            }
        };
        let mut warning = None;
        if names.len() > 1 {
            warning = Some(format!("同一目标还有别名：{}", names[1..].join("、")));
        }
        if count_key(&body, "ADDRESS") > 1 {
            warning = Some("有多个地址（RAC / 多监听），只导入了第一个".to_string());
        }
        entries.push(TnsEntry {
            alias,
            target,
            warning,
        });
    }
    (entries, warnings)
}

/// 把一个或多个 `别名 = (DESCRIPTION …)` 切成完整条目。
///
/// 逐行累加并在括号深度回到 0 时才收口：别名行只出现在深度 0，所以不会把
/// CONNECT_DATA 里的内容误当成新条目。
fn split_tns_entries(text: &str) -> Vec<(Vec<String>, String)> {
    let cleaned: String = text
        .lines()
        .map(|l| match l.find('#') {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = Vec::new();
    let mut current: Option<(Vec<String>, String)> = None;
    let mut depth = 0i32;
    for line in cleaned.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if depth <= 0 {
            if let Some((names, rhs)) = alias_line(t) {
                if let Some((n, b)) = current.take() {
                    if !b.trim().is_empty() {
                        out.push((n, b));
                    }
                }
                depth = paren_delta(t);
                current = Some((names, rhs.to_string()));
                continue;
            }
        }
        if let Some((_, body)) = current.as_mut() {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(t);
            depth += paren_delta(t);
        }
    }
    if let Some((n, b)) = current.take() {
        if !b.trim().is_empty() {
            out.push((n, b));
        }
    }
    out
}

fn alias_line(line: &str) -> Option<(Vec<String>, &str)> {
    let eq = line.find('=')?;
    let lhs = line[..eq].trim();
    let rhs = line[eq + 1..].trim();
    if lhs.is_empty() {
        return None;
    }
    let mut names = Vec::new();
    for part in lhs.split(',') {
        let n = part.trim();
        if !valid_name(n) {
            return None;
        }
        names.push(n.to_string());
    }
    Some((names, rhs))
}

fn paren_delta(s: &str) -> i32 {
    let mut d = 0;
    let mut quoted = false;
    for c in s.chars() {
        if c == '\'' {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        match c {
            '(' => d += 1,
            ')' => d -= 1,
            _ => {}
        }
    }
    d
}

// ─── PL/SQL Developer ──────────────────────────────────────────────────────

const MAX_TEXT_FILE: u64 = 4 * 1024 * 1024;
const MAX_SCAN_FILES: usize = 64;

/// 从 `user.prefs` 里抽固定用户（`user/password@db`，口令段丢弃）。
///
/// 只看名字里带 `fixed` 的段：LogonHistory 的条目是加密串，硬解既不可靠也不该做。
/// 固定用户即使存成了密文，这里也只会因为解析不出合法用户名而自然跳过。
pub fn parse_fixed_users(text: &str) -> Vec<(String, String)> {
    let mut section = String::new();
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            if let Some(end) = line.find(']') {
                section = line[1..end]
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .collect::<String>()
                    .to_ascii_lowercase();
            }
            continue;
        }
        if !section.starts_with("fixed") {
            continue;
        }
        let Some(eq) = line.find('=') else {
            continue;
        };
        if let Some((user, db)) = parse_identity(line[eq + 1..].trim()) {
            out.push((user, db));
        }
    }
    out
}

fn parse_identity(value: &str) -> Option<(String, String)> {
    let at = value.rfind('@')?;
    let left = value[..at].trim();
    let db = value[at + 1..].trim();
    if db.is_empty() || db.len() > 512 || db.chars().any(char::is_whitespace) {
        return None;
    }
    let user = match left.find('/') {
        Some(i) => &left[..i],
        None => left,
    };
    let user = user.trim();
    if !valid_user(user) {
        return None;
    }
    Some((user.to_string(), db.to_string()))
}

fn valid_user(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '#'))
}

/// user.prefs 里记录的 Oracle Home / OCI 路径（用来找真正的 `tnsnames.ora`）。
pub fn prefs_oracle_dirs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        let Some(eq) = line.find('=') else {
            continue;
        };
        let key = line[..eq].trim().to_ascii_lowercase();
        let val = line[eq + 1..].trim().trim_matches('"');
        if val.is_empty() {
            continue;
        }
        let is_oracle_path = key.contains("oraclehome")
            || key == "oci"
            || key.contains("ocilibrary")
            || key.contains("oraclient");
        if is_oracle_path && !out.iter().any(|x: &String| x.eq_ignore_ascii_case(val)) {
            out.push(val.to_string());
        }
    }
    out
}

/// 扫描（或解析前端手选的文件）PL/SQL Developer 的配置。
///
/// `scan_local` 为真时还会看 `%APPDATA%` / `%PROGRAMFILES%` 下的 PL/SQL Developer
/// 首选项目录，以及 `TNS_ADMIN` / `ORACLE_HOME` 指向的 `tnsnames.ora`。
pub fn scan_plsql(
    scan_local: bool,
    prefs: Option<String>,
    prefs_name: Option<String>,
    tns: Option<String>,
    tns_name: Option<String>,
) -> Result<ImportScan, String> {
    let mut prefs_files: Vec<(String, String)> = Vec::new();
    let mut tns_files: Vec<(String, String)> = Vec::new();
    if let Some(text) = prefs {
        prefs_files.push((file_label(prefs_name, "user.prefs"), text));
    }
    if let Some(text) = tns {
        tns_files.push((file_label(tns_name, "tnsnames.ora"), text));
    }
    let mut warnings = Vec::new();
    if scan_local {
        for (path, text) in discover_prefs(&mut warnings) {
            if !prefs_files.iter().any(|(n, _)| n == &path) {
                prefs_files.push((path, text));
            }
        }
        for (path, text) in discover_tns(&prefs_files, &mut warnings) {
            if !tns_files.iter().any(|(n, _)| n == &path) {
                tns_files.push((path, text));
            }
        }
    }
    if prefs_files.is_empty() && tns_files.is_empty() {
        return Err(
            "没找到 PL/SQL Developer 的配置（user.prefs / tnsnames.ora）。\
             可以点「选择文件…」手动指定，或先在该工具里登录一次再扫描"
                .to_string(),
        );
    }
    let mut scan = build_plsql_scan(&prefs_files, &tns_files, warnings);
    let mut source = prefs_files
        .iter()
        .map(|(n, _)| n.clone())
        .chain(tns_files.iter().map(|(n, _)| n.clone()))
        .collect::<Vec<_>>()
        .join("；");
    if source.len() > 400 {
        source.truncate(400);
        source.push('…');
    }
    scan.source = source;
    Ok(scan)
}

fn file_label(name: Option<String>, fallback: &str) -> String {
    name.filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn build_plsql_scan(
    prefs_files: &[(String, String)],
    tns_files: &[(String, String)],
    mut warnings: Vec<String>,
) -> ImportScan {
    let mut aliases: BTreeMap<String, TnsEntry> = BTreeMap::new();
    let mut alias_origin: BTreeMap<String, String> = BTreeMap::new();
    for (origin, text) in tns_files {
        let (entries, mut w) = parse_tnsnames(text);
        warnings.append(&mut w);
        for e in entries {
            let key = e.alias.to_ascii_lowercase();
            aliases.entry(key.clone()).or_insert(e);
            alias_origin.entry(key).or_insert_with(|| origin.clone());
        }
    }
    let mut items = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    for (origin, text) in prefs_files {
        for (user, db) in parse_fixed_users(text) {
            let alias_key = db.to_ascii_lowercase();
            let (target, warning, display) = match aliases.get(&alias_key) {
                Some(e) => {
                    used.insert(alias_key);
                    (e.target.clone(), e.warning.clone(), e.alias.clone())
                }
                None => match parse_oracle_target(&db) {
                    Ok(t) => (t, None, db.clone()),
                    Err(e) => {
                        warnings.push(format!("{origin} 里的固定用户 {user}@{db} 无法解析：{e}"));
                        continue;
                    }
                },
            };
            items.push(Candidate {
                key: String::new(),
                name: display,
                url: target.url(),
                user,
                tool: "plsql".to_string(),
                origin: origin.clone(),
                warning,
                duplicate: false,
                near: None,
            });
        }
    }
    for (key, e) in &aliases {
        if used.contains(key) {
            continue;
        }
        items.push(Candidate {
            key: String::new(),
            name: e.alias.clone(),
            url: e.target.url(),
            user: String::new(),
            tool: "plsql".to_string(),
            origin: alias_origin.get(key).cloned().unwrap_or_default(),
            warning: e
                .warning
                .clone()
                .or_else(|| Some("没有用户名：导入后在连接设置里补上".to_string())),
            duplicate: false,
            near: None,
        });
    }
    dedup(&mut items);
    number_keys(&mut items);
    warnings.push(
        "不会导入口令（PL/SQL Developer 的历史口令是加密的）：首次连接时输一次，\
         勾「记住」后本机加密保存"
            .to_string(),
    );
    ImportScan {
        source: String::new(),
        items,
        warnings,
    }
}

fn discover_prefs(warnings: &mut Vec<String>) -> Vec<(String, String)> {
    let mut roots = Vec::new();
    for key in ["APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
        if let Ok(v) = std::env::var(key) {
            roots.push(PathBuf::from(v));
        }
    }
    let mut out = Vec::new();
    for root in roots {
        let Ok(rd) = std::fs::read_dir(&root) else {
            continue;
        };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.starts_with("plsql developer") {
                continue;
            }
            let pref = ent.path().join("Preferences");
            let Ok(users) = std::fs::read_dir(&pref) else {
                continue;
            };
            for u in users.flatten() {
                let candidate = u.path().join("user.prefs");
                if let Some(text) = read_text(&candidate, warnings) {
                    out.push((candidate.display().to_string(), text));
                    if out.len() >= MAX_SCAN_FILES {
                        return out;
                    }
                }
            }
        }
    }
    out
}

fn discover_tns(
    prefs_files: &[(String, String)],
    warnings: &mut Vec<String>,
) -> Vec<(String, String)> {
    let mut dirs = Vec::new();
    for key in ["TNS_ADMIN", "ORACLE_HOME"] {
        if let Ok(v) = std::env::var(key) {
            dirs.push(PathBuf::from(v));
        }
    }
    for (_, text) in prefs_files {
        for d in prefs_oracle_dirs(text) {
            dirs.push(PathBuf::from(d));
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for d in dirs {
        let d = if d.is_file() {
            d.parent().map(PathBuf::from).unwrap_or(d)
        } else {
            d
        };
        for candidate in [
            d.join("tnsnames.ora"),
            d.join("network").join("admin").join("tnsnames.ora"),
        ] {
            let key = candidate.to_string_lossy().to_ascii_lowercase();
            if !seen.insert(key) {
                continue;
            }
            if let Some(text) = read_text(&candidate, warnings) {
                out.push((candidate.display().to_string(), text));
                if out.len() >= MAX_SCAN_FILES {
                    return out;
                }
            }
        }
    }
    out
}

fn read_text(path: &std::path::Path, warnings: &mut Vec<String>) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_TEXT_FILE {
        warnings.push(format!("{} 超过 4MB，已跳过", path.display()));
        return None;
    }
    match std::fs::read(path) {
        Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) => {
            warnings.push(format!("读 {} 失败：{e}", path.display()));
            None
        }
    }
}

// ─── 与现有连接比对 / 落成配置 ─────────────────────────────────────────────

/// 标出已存在的连接，以及「同一个库但写法 / 用户不同」的近似重复。
pub fn mark_existing(items: &mut [Candidate], existing: &[(String, String, String)]) {
    for c in items.iter_mut() {
        let new_target = parse_oracle_target(&c.url).ok();
        for (url, user, name) in existing {
            let same_user = user.trim().eq_ignore_ascii_case(c.user.trim());
            match (parse_oracle_target(url), new_target.as_ref()) {
                (Ok(a), Some(b)) => {
                    if same_user && a.ident() == b.ident() {
                        c.duplicate = true;
                        break;
                    }
                    if c.near.is_none() && a.endpoint() == b.endpoint() {
                        c.near = Some(if same_user {
                            format!("已有同一数据库的连接「{name}」（SID / 服务名写法不同）")
                        } else {
                            format!("已有同一数据库的连接「{name}」，用户不同")
                        });
                    }
                }
                _ => {
                    if same_user && db_conns::same_target(url, user, &c.url, &c.user) {
                        c.duplicate = true;
                        break;
                    }
                }
            }
        }
    }
}

/// 把选中的一条落成连接配置。**不写口令**；`source` 保持 `manual`，
/// 来源只记在 `note` 里——`source` 的取值会影响两套引擎的口令解析路径，不能乱加。
pub fn make_conn(
    want: &ImportWant,
    env: &str,
    existing: &[DbConnConfig],
) -> Result<DbConnConfig, String> {
    let target = parse_oracle_target(&want.url)?;
    let url = target.url();
    let user = want.user.trim().to_string();
    if already(existing, &url, &user) {
        return Err("这个库和用户已经在连接列表里了".to_string());
    }
    let tool = match want.tool.as_str() {
        "datagrip" => "DataGrip",
        "plsql" => "PL/SQL Developer",
        other => return Err(format!("未知的导入来源：{other}")),
    };
    let name = if want.name.trim().is_empty() {
        target.service.clone()
    } else {
        want.name.trim().to_string()
    };
    Ok(DbConnConfig {
        id: db_conns::new_id(),
        name,
        env: db_conns::normalize_env(env),
        source: "manual".to_string(),
        url,
        user,
        prop_ds: None,
        password_dpapi: None,
        auto_commit: false,
        engine: "rust".to_string(),
        note: format!("从 {tool} 导入"),
        default_schema: String::new(),
    })
}

fn already(existing: &[DbConnConfig], url: &str, user: &str) -> bool {
    existing.iter().any(|c| {
        if !c.user.trim().eq_ignore_ascii_case(user) {
            return false;
        }
        match (parse_oracle_target(&c.url), parse_oracle_target(url)) {
            (Ok(a), Ok(b)) => a.ident() == b.ident(),
            _ => db_conns::same_target(&c.url, &c.user, url, user),
        }
    })
}

fn dedup(items: &mut Vec<Candidate>) {
    let mut seen = HashSet::new();
    items.retain(|c| {
        seen.insert(format!(
            "{}|{}|{}",
            c.tool,
            c.url.to_ascii_lowercase(),
            c.user.to_ascii_lowercase()
        ))
    });
}

fn number_keys(items: &mut [Candidate]) {
    for (i, c) in items.iter_mut().enumerate() {
        c.key = format!("{}:{i}", c.tool);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DG_MAIN: &str = r#"<component name="DataSourceManagerImpl">
  <data-source source="LOCAL" name="测试库" uuid="1111">
    <driver-ref>oracle</driver-ref>
    <jdbc-url>jdbc:oracle:thin:@//10.200.23.50:1521/aier0910</jdbc-url>
  </data-source>
  <data-source source="LOCAL" name="mysql" uuid="2222">
    <driver-ref>mysql</driver-ref>
    <jdbc-url>jdbc:mysql://h:3306/db</jdbc-url>
  </data-source>
</component>"#;

    const DG_LOCAL: &str = r#"<component name="dataSourceStorageLocal">
  <data-source name="测试库" uuid="1111"><user-name>aier633</user-name></data-source>
</component>"#;

    const TNS: &str = r#"
# test
AIER =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = 10.200.23.50)(PORT = 1521))
    (CONNECT_DATA = (SERVER = DEDICATED)(SERVICE_NAME = aier0910))
  )
OLD = (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h2)(PORT=1522))(CONNECT_DATA=(SID=ORCL)))
RAC1, RAC2 = (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h3)(PORT=1521))(ADDRESS=(PROTOCOL=TCP)(HOST=h4)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=svc)))
"#;

    #[test]
    fn oracle_连接串认三种写法() {
        let t = parse_oracle_target("jdbc:oracle:thin:@//10.1.2.3:1521/AIER").unwrap();
        assert_eq!(t.url(), "jdbc:oracle:thin:@//10.1.2.3:1521/AIER");
        assert!(!t.sid);

        let t = parse_oracle_target("jdbc:oracle:thin:@10.1.2.3:1522:ORCL").unwrap();
        assert_eq!(t.url(), "jdbc:oracle:thin:@10.1.2.3:1522:ORCL");
        assert!(t.sid);

        let t = parse_oracle_target(
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)\
             (PORT=1523))(CONNECT_DATA=(SERVICE_NAME=svc)))",
        )
        .unwrap();
        assert_eq!(
            (t.host.as_str(), t.port, t.service.as_str()),
            ("db", 1523, "svc")
        );
        assert!(!t.sid);

        let t = parse_oracle_target("jdbc:oracle:thin:@//h/aier0910").unwrap();
        assert_eq!(t.port, 1521, "没写端口按 1521");
    }

    #[test]
    fn oracle_连接串里的口令与查询参数被丢掉() {
        let raw = "jdbc:oracle:thin:scott/tiger@//h:1521/svc?useSSL=false";
        let t = parse_oracle_target(raw).unwrap();
        assert_eq!(t.url(), "jdbc:oracle:thin:@//h:1521/svc");
        assert!(embedded_credentials(raw));
        assert!(!embedded_credentials("jdbc:oracle:thin:@//h:1521/svc"));
    }

    #[test]
    fn oracle_别名与非_oracle_要报错() {
        assert!(parse_oracle_target("jdbc:oracle:thin:@mydb").is_err());
        assert!(parse_oracle_target("jdbc:mysql://h/db").is_err());
        assert!(parse_oracle_target("jdbc:oracle:thin:@//h:1521/").is_err());
    }

    #[test]
    fn datagrip_按_uuid_配用户名并跳过非_oracle() {
        let scan = scan_datagrip(DG_MAIN, Some(DG_LOCAL), "dataSources.xml");
        assert_eq!(scan.items.len(), 1);
        assert_eq!(scan.items[0].name, "测试库");
        assert_eq!(scan.items[0].user, "aier633");
        assert_eq!(
            scan.items[0].url,
            "jdbc:oracle:thin:@//10.200.23.50:1521/aier0910"
        );
        assert!(scan.warnings.iter().any(|w| w.contains("非 Oracle")));
    }

    #[test]
    fn datagrip_没本地文件时提示缺用户名() {
        let scan = scan_datagrip(DG_MAIN, None, "dataSources.xml");
        assert_eq!(scan.items.len(), 1);
        assert!(scan.items[0].user.is_empty());
        assert!(scan.warnings.iter().any(|w| w.contains("没读到用户名")));
    }

    #[test]
    fn datagrip_内嵌口令只警告不回写() {
        let xml = r#"<component><data-source name="x" uuid="9">
            <driver-ref>oracle</driver-ref>
            <jdbc-url>jdbc:oracle:thin:scott/tiger@//h:1521/svc</jdbc-url>
        </data-source></component>"#;
        let scan = scan_datagrip(xml, None, "x.xml");
        assert_eq!(scan.items.len(), 1);
        assert!(!scan.items[0].url.contains("tiger"), "口令不能进连接串");
        assert!(scan.items[0]
            .warning
            .as_deref()
            .unwrap_or("")
            .contains("口令"));
    }

    #[test]
    fn settings_zip_只读数据源文件() {
        use std::io::{Cursor, Write};
        use zip::write::SimpleFileOptions;

        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opt = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        w.start_file("options/dataSources.xml", opt).unwrap();
        w.write_all(DG_MAIN.as_bytes()).unwrap();
        w.start_file("options/dataSources.local.xml", opt).unwrap();
        w.write_all(DG_LOCAL.as_bytes()).unwrap();
        w.start_file("options/other.xml", opt).unwrap();
        w.write_all(
            b"<data-source name=\"x\"><jdbc-url>jdbc:oracle:thin:@//h:1521/x</jdbc-url></data-source>",
        )
        .unwrap();
        let bytes = w.finish().unwrap().into_inner();

        let scan = scan_datagrip_zip(&bytes).unwrap();
        assert_eq!(scan.items.len(), 1, "白名单外的条目不该被读");
        assert_eq!(scan.items[0].user, "aier633");
    }

    #[test]
    fn settings_zip_没有数据源要说清楚() {
        use std::io::{Cursor, Write};
        use zip::write::SimpleFileOptions;

        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opt = SimpleFileOptions::default();
        w.start_file("options/other.xml", opt).unwrap();
        w.write_all(b"x").unwrap();
        let bytes = w.finish().unwrap().into_inner();
        let scan = scan_datagrip_zip(&bytes).unwrap();
        assert!(scan.items.is_empty());
        assert!(scan.warnings[0].contains("global data sources"));
    }

    #[test]
    fn tns_认服务名_sid_与多别名() {
        let (entries, warnings) = parse_tnsnames(TNS);
        assert_eq!(entries.len(), 3, "AIER / OLD / RAC1");
        let aier = entries.iter().find(|e| e.alias == "AIER").unwrap();
        assert_eq!(
            aier.target.url(),
            "jdbc:oracle:thin:@//10.200.23.50:1521/aier0910"
        );
        let old = entries.iter().find(|e| e.alias == "OLD").unwrap();
        assert!(old.target.sid);
        assert_eq!(old.target.url(), "jdbc:oracle:thin:@h2:1522:ORCL");
        let rac = entries.iter().find(|e| e.alias == "RAC1").unwrap();
        assert!(rac.warning.as_deref().unwrap_or("").contains("多个地址"));
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn tns_非_tcp_要跳过并说明() {
        let (entries, warnings) = parse_tnsnames(
            "SECURE = (DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=h)(PORT=2484))(CONNECT_DATA=(SERVICE_NAME=s)))",
        );
        assert!(entries.is_empty());
        assert!(warnings.iter().any(|w| w.contains("TCPS")));
    }

    #[test]
    fn fixed_users_只收明文形状() {
        let text = "[Fixed Users]\n1=aier633/secret@AIER\n2=scott/tiger@h:1521:ORCL\n\
                    [LogonHistory]\n1=something-encrypted@blob/x\n";
        let users = parse_fixed_users(text);
        assert_eq!(users.len(), 2);
        assert_eq!(users[0], ("aier633".to_string(), "AIER".to_string()));
    }

    #[test]
    fn plsql_扫描把固定用户对到_tns_别名() {
        let prefs = "[Fixed Users]\n1=aier633/secret@AIER\n";
        let scan = scan_plsql(
            false,
            Some(prefs.to_string()),
            Some("user.prefs".to_string()),
            Some(TNS.to_string()),
            Some("tnsnames.ora".to_string()),
        )
        .unwrap();
        let matched = scan
            .items
            .iter()
            .find(|c| c.user == "aier633")
            .expect("固定用户要解析出来");
        assert_eq!(matched.name, "AIER");
        assert_eq!(
            matched.url,
            "jdbc:oracle:thin:@//10.200.23.50:1521/aier0910"
        );
        assert!(
            !scan.items.iter().any(|c| c.url.contains("secret")),
            "口令不能进连接串"
        );
        assert!(scan.warnings.iter().any(|w| w.contains("不会导入口令")));
    }

    #[test]
    fn 已有连接按规范化目标判重与提示近似() {
        let mut items = vec![Candidate {
            key: String::new(),
            name: "a".into(),
            url: "jdbc:oracle:thin:@//h:1521/svc".into(),
            user: "u".into(),
            tool: "datagrip".into(),
            origin: String::new(),
            warning: None,
            duplicate: false,
            near: None,
        }];
        let existing = vec![(
            "jdbc:oracle:thin:@h:1521:svc".to_string(),
            "u".to_string(),
            "旧连接".to_string(),
        )];
        mark_existing(&mut items, &existing);
        assert!(!items[0].duplicate, "SID / 服务名写法不同不算同一条");
        assert!(items[0].near.as_deref().unwrap_or("").contains("旧连接"));

        let existing = vec![(
            "jdbc:oracle:thin:@//H:1521/SVC".to_string(),
            "U".to_string(),
            "旧连接".to_string(),
        )];
        mark_existing(&mut items, &existing);
        assert!(items[0].duplicate, "大小写不同仍算同一条");
    }

    #[test]
    fn 落配置时不带口令且来源记在_note() {
        let want = ImportWant {
            name: " AIER ".into(),
            url: "jdbc:oracle:thin:@//h:1521/svc".into(),
            user: " u ".into(),
            tool: "datagrip".into(),
        };
        let c = make_conn(&want, "PROD", &[]).unwrap();
        assert_eq!(c.name, "AIER");
        assert_eq!(c.user, "u");
        assert_eq!(c.env, "prod");
        assert_eq!(c.source, "manual");
        assert_eq!(c.engine, "rust");
        assert_eq!(c.note, "从 DataGrip 导入");
        assert!(c.password_dpapi.is_none());
        assert!(make_conn(&want, "dev", std::slice::from_ref(&c)).is_err());
    }
}
