//! 资源包（resource packs）：把 jdtls / ecj / svnkit 这类大块静态资源从安装包里拿出去，
//! 改为按需下载到 `{config_dir}/resources/` 下。
//!
//! # 为什么外置
//!
//! v0.1.0 安装包 63.8MB，其中约 59MB 是几乎永不变的 jar 资源（jdtls 54MB + ecj
//! 6.7MB + svnkit 3MB），应用本体（nc-forge.exe，含前端）压缩后只有 5–6MB。每次
//! 自动更新都让用户重下这 59MB 不变内容，慢网用户（实测直连 GitHub ~20KB/s）要等
//! 50 分钟。外置后：安装包 ~8MB，资源按版本 + SHA-256 单独分发，内容不变就不重下。
//!
//! # 信任模型（与 updater 对齐，不更强也不更弱）
//!
//! - 清单 `resources.json` 与安装包都走 HTTPS，多源故障转移（Release 资产优先，
//!   Gitee raw 镜像次之，gh-pages 垫底——该站点当前未启用、实测 404，保留只为
//!   哪天启用了 Pages 就自动活；env `APP_RESOURCES_ENDPOINT` 可覆盖，语义是
//!   「只信 env 组」）。
//! - 完整性：清单里的 SHA-256 与解压前逐字节校验。**清单自身不签名**——这与
//!   updater.json 的现状一致（它靠 HTTPS + 多源，artifact 才做 minisign 验签）。
//!   若要给清单也加 minisign 签名，复用 updater 同一把 key 即可，属后续加固项。
//! - http 仅允许本机联调（127.0.0.1/localhost），其余一律 https。
//!
//! # 旧安装包用户
//!
//! 升级前资源在安装目录（resource_dir）里。新版本首次运行时**认领**它们
//! （state 记 `legacy: true`，不重下）；只有当清单版本变化或用户手动「重新下载」
//! 时才拉新版。认领的包版本不可知，这是已知取舍：资源版本锁定（jdtls 0.57.0、
//! ecj 3.17），变化频率以年计，设置页提供强制重下入口。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::retry::retry_with_backoff;

// ───────────────────────── 包定义 ─────────────────────────

pub const PACK_JDTLS: &str = "jdtls";
pub const PACK_ECJ: &str = "ecj";
pub const PACK_SVNKIT: &str = "svnkit";

/// 全部包 + 展示元信息。顺序即 UI 展示顺序（大的在前，先给用户体积预期）。
/// 清单里带的 title/notes 优先；缺失时回落这里，保证旧清单也能显示。
pub const ALL_PACKS: &[PackMeta] = &[
    PackMeta {
        id: PACK_JDTLS,
        title: "Java 语言服务（jdt.ls）",
        notes: "代码补全、跳转、诊断",
    },
    PackMeta {
        id: PACK_ECJ,
        title: "Java 编译器（ecj）",
        notes: "编译 NC 模块",
    },
    PackMeta {
        id: PACK_SVNKIT,
        title: "SVN 组件",
        notes: " diff / 更新 / 提交",
    },
];

pub struct PackMeta {
    pub id: &'static str,
    pub title: &'static str,
    pub notes: &'static str,
}

/// 清单缺 title/notes 或包 id 不在已知列表时的兜底。
const FALLBACK_META: PackMeta = PackMeta {
    id: "",
    title: "组件",
    notes: "",
};

pub fn pack_meta(id: &str) -> &'static PackMeta {
    ALL_PACKS.iter().find(|m| m.id == id).unwrap_or(&FALLBACK_META)
}

// ───────────────────────── 清单（resources.json）─────────────────────────

/// 清单里的一个包。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourcePack {
    pub id: String,
    /// 内容寻址的版本串（打包时取 zip 的 SHA-256 前 12 位）：内容变⇒版本变⇒客户端重下，
    /// 不依赖人工 bump，也不会出现「版本没动但内容换了」的静默过期。
    pub version: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub notes: String,
    /// 适用平台；`None` = 全平台。取值同 `std::env::consts::OS`（windows/macos/linux）。
    #[serde(default)]
    pub platforms: Option<Vec<String>>,
    pub size: u64,
    pub sha256: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourcesManifest {
    pub packs: Vec<ResourcePack>,
}

impl ResourcesManifest {
    /// 解析 + 基本校验。坏 manifest 必须在这里红，不能等下载时才对用户报错。
    pub fn parse(text: &str) -> Result<Self, String> {
        let m: Self = serde_json::from_str(text).map_err(|e| format!("resources.json 解析失败: {e}"))?;
        if m.packs.is_empty() {
            return Err("resources.json 里没有任何资源包".to_string());
        }
        for p in &m.packs {
            if p.id.is_empty() || p.version.is_empty() {
                return Err(format!("资源包缺少 id/version: {}", p.id));
            }
            if p.sha256.len() != 64 || !p.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(format!("资源包 {} 的 sha256 不是 64 位十六进制", p.id));
            }
            if p.size == 0 {
                return Err(format!("资源包 {} 的 size 为 0", p.id));
            }
            url::Url::parse(&p.url).map_err(|e| format!("资源包 {} 的 url 不合法: {e}", p.id))?;
        }
        Ok(m)
    }

    pub fn pack(&self, id: &str) -> Option<&ResourcePack> {
        self.packs.iter().find(|p| p.id == id)
    }

    /// 当前平台适用的包（platforms 为 None 或含本平台）。
    pub fn packs_for_current_platform(&self) -> Vec<&ResourcePack> {
        let os = std::env::consts::OS;
        self.packs
            .iter()
            .filter(|p| p.platforms.as_ref().map(|ps| ps.iter().any(|x| x == os)).unwrap_or(true))
            .collect()
    }
}

// ───────────────────────── 本地状态（resource-packs.json）─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PacksState {
    #[serde(default)]
    pub packs: BTreeMap<String, InstalledPack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPack {
    pub version: String,
    /// 从旧版安装包目录认领来的（版本不可知）。清单版本变化时不会自动更新它，
    /// 需要用户在设置里手动「重新下载组件」。
    #[serde(default)]
    pub legacy: bool,
    /// 磁盘上的实际字节数：下载成功 = 实收总长；legacy 认领 = 旧目录实测合计。
    /// 设置页「组件」卡展示用。`#[serde(default)]`：老状态文件没有这个字段时
    /// 读成 None（显示占位符），不阻断加载——最坏是设置页少显示一个大小。
    #[serde(default)]
    pub size: Option<u64>,
}

impl PacksState {
    /// 读状态。文件不存在 = 全新安装（空状态）；损坏 = 回落空状态并留警告
    /// （坏状态不该让整个资源链路瘫痪，最坏是多下一次包）。
    pub fn load(config_dir: &Path) -> Self {
        let path = state_path(config_dir);
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Self>(&text) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("资源包状态文件损坏，按未安装处理（{path:?}: {e}）");
                    Self::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(e) => {
                log::warn!("读取资源包状态失败，按未安装处理（{path:?}: {e}）");
                Self::default()
            }
        }
    }

    /// 写状态：临时文件 + rename（与 config.rs 同一套规则——半截状态比没有更糟）。
    pub fn save(&self, config_dir: &Path) -> Result<(), String> {
        let path = state_path(config_dir);
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(self).map_err(|e| format!("状态序列化失败: {e}"))?;
        std::fs::write(&tmp, text).map_err(|e| format!("写资源包状态失败: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("资源包状态落盘失败: {e}"))?;
        Ok(())
    }
}

// ───────────────────────── 路径 ─────────────────────────

pub fn state_path(config_dir: &Path) -> PathBuf {
    config_dir.join("resource-packs.json")
}

/// 外部资源根：`{config_dir}/resources`。
pub fn external_root(config_dir: &Path) -> PathBuf {
    config_dir.join("resources")
}

/// 某包某版本的目录：`{config_dir}/resources/{id}@{version}`。
pub fn pack_dir(config_dir: &Path, id: &str, version: &str) -> PathBuf {
    external_root(config_dir).join(format!("{id}@{version}"))
}

/// 当前生效的已安装目录（state 记录 + 目录真实存在，双重确认）。
/// legacy 记录返回 None——旧安装包里的资源由 finder 的原有候选负责。
pub fn active_dir(config_dir: &Path, id: &str) -> Option<PathBuf> {
    let st = PacksState::load(config_dir);
    let rec = st.packs.get(id)?;
    if rec.legacy {
        return None;
    }
    let dir = pack_dir(config_dir, id, &rec.version);
    dir.is_dir().then_some(dir)
}

/// 旧版安装包内的资源布局（bundle.resources 映射的落点，v0.1.0 及以前）。
pub fn legacy_dir(resource_dir: &Path, id: &str) -> PathBuf {
    resource_dir.join(id)
}

/// 旧安装包里这个包的资源是否还在（按各包的关键文件判断，不是只看目录——
/// 空目录 / 半吊子安装都算没有）。
pub fn legacy_present(resource_dir: &Path, id: &str) -> bool {
    let dir = legacy_dir(resource_dir, id);
    match id {
        PACK_JDTLS => dir.join("plugins").is_dir() && dir.join("config_win").is_dir(),
        PACK_ECJ => dir.join("ecj-3.17.jar").is_file(),
        PACK_SVNKIT => dir.join("svnkit.jar").is_file(),
        _ => dir.is_dir(),
    }
}

/// 旧安装包里这个包的资源总字节（认领时记进 state，设置页展示用）。
/// 目录不在 / 遍历出错返回 None——legacy 记录的大小只是参考值，不该阻断认领。
/// 用 DirEntry::file_type 而非 Path::is_dir：不跟随符号链接，避免成环目录扫不完。
fn legacy_dir_size(resource_dir: &Path, id: &str) -> Option<u64> {
    fn walk(dir: &Path, total: &mut u64) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for entry in rd.filter_map(|e| e.ok()) {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                walk(&entry.path(), total);
            } else if let Ok(md) = entry.metadata() {
                *total += md.len();
            }
        }
    }
    let dir = legacy_dir(resource_dir, id);
    if !dir.is_dir() {
        return None;
    }
    let mut total = 0u64;
    walk(&dir, &mut total);
    Some(total)
}

/// 解压/安装后冒烟：包内容是不是这个包该有的样子。
fn pack_probe_ok(dir: &Path, id: &str) -> bool {
    match id {
        PACK_JDTLS => dir.join("plugins").is_dir() && dir.join("config_win").is_dir(),
        PACK_ECJ => dir.join("ecj-3.17.jar").is_file(),
        PACK_SVNKIT => dir.join("svnkit.jar").is_file(),
        _ => dir.is_dir(),
    }
}

// ───────────────────────── 更新源端点 ─────────────────────────

/// 编译期内嵌 tauri.conf.json，运行时解析 `plugins.resourcePacks.endpoints`。
/// 不走 tauri 的插件配置机制：那是 updater 插件的私有读取路径，自己的模块直接读
/// 原文最直白，也避免「配置改了但 Rust 侧拿不到」的幽灵失败。
const TAURI_CONF: &str = include_str!("../tauri.conf.json");

/// 端点优先级：env `APP_RESOURCES_ENDPOINT`（逗号分隔多 URL，按顺序故障转移）>
/// tauri.conf.json 的 plugins.resourcePacks.endpoints。
/// env 存在时**只**用 env 组、不自动回退（与 update.rs 的覆盖语义一致：单一可预期）。
pub fn resource_endpoints() -> Result<Vec<url::Url>, String> {
    if let Ok(raw) = std::env::var("APP_RESOURCES_ENDPOINT") {
        if !raw.trim().is_empty() {
            let mut eps = Vec::new();
            for part in raw.split(',') {
                let t = part.trim();
                if t.is_empty() {
                    continue;
                }
                let u = url::Url::parse(t).map_err(|e| format!("资源源 \"{t}\" 不是合法 URL: {e}"))?;
                check_url_scheme(&u)?;
                eps.push(u);
            }
            if !eps.is_empty() {
                return Ok(eps);
            }
        }
    }
    let from_conf = endpoints_from_conf();
    if from_conf.is_empty() {
        return Err("tauri.conf.json 的 plugins.resourcePacks.endpoints 为空".to_string());
    }
    Ok(from_conf)
}

fn endpoints_from_conf() -> Vec<url::Url> {
    let Ok(conf) = serde_json::from_str::<serde_json::Value>(TAURI_CONF) else {
        log::error!("内嵌的 tauri.conf.json 解析失败（资源包端点为空）");
        return Vec::new();
    };
    let Some(arr) = conf
        .pointer("/plugins/resourcePacks/endpoints")
        .and_then(|v| v.as_array())
    else {
        log::error!("tauri.conf.json 缺少 plugins.resourcePacks.endpoints");
        return Vec::new();
    };
    arr.iter()
        .filter_map(|v| v.as_str())
        .filter_map(|s| match url::Url::parse(s) {
            Ok(u) => Some(u),
            Err(e) => {
                log::error!("资源源 URL 无效，已跳过: {s} ({e})");
                None
            }
        })
        .collect()
}

/// https 必须；http 只放行本机（本地联调 / 集成测试的 127.0.0.1 假源）。
fn check_url_scheme(u: &url::Url) -> Result<(), String> {
    match u.scheme() {
        "https" => Ok(()),
        "http" => {
            let loopback = u
                .host_str()
                .map(|h| h == "127.0.0.1" || h == "localhost" || h == "::1")
                .unwrap_or(false);
            if loopback {
                Ok(())
            } else {
                Err(format!("资源源必须是 https（{u}）；http 仅允许本机联调"))
            }
        }
        s => Err(format!("资源源协议不支持: {s}")),
    }
}

// ───────────────────────── 下载 / 校验 / 解压 ─────────────────────────

/// 单个 chunk 之间允许的最大间隔。慢网（20KB/s）下一块也就几秒；60s 没有新字节
/// 基本就是链路死了——与其让用户对着一个不动的进度条，不如断掉重试/换源。
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // 只卡「建连」。不设总超时：54MB 的包在慢网上合法地需要几十分钟，
        // 停滞检测（STALL_TIMEOUT）比总超时更准确地表达「坏了」。
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

/// 拉清单。小文件，给 30s 总超时足够（防「收下连接再不响应」的挂死）。
pub async fn fetch_manifest(client: &reqwest::Client, url: &url::Url) -> Result<ResourcesManifest, String> {
    let resp = client
        .get(url.clone())
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("请求资源清单失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("资源清单返回 HTTP {}", resp.status()));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取资源清单失败: {e}"))?;
    ResourcesManifest::parse(&text)
}

/// 下载一个包并校验 SHA-256。返回原始字节（后续原样解压）。
/// `on_progress(chunk_len, downloaded_total, total)` 每块回调一次。
pub async fn download_pack(
    client: &reqwest::Client,
    url: &url::Url,
    expected_sha256: &str,
    mut on_progress: impl FnMut(usize, u64, Option<u64>),
) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载返回 HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let mut stream = resp.bytes_stream();
    // 预分配上限 64MB：当前最大的 jdtls 约 54MB，留了增长余量。上限的用意是
    // 防「源声明一个超大 Content-Length（或损坏的长度字段）时一次性吃满内存」——
    // 超出后 Vec 自然增长，只是多几次 realloc，正确性与下载都不受影响。
    let mut buf: Vec<u8> = Vec::with_capacity(total.unwrap_or(8 << 20).min(64 << 20) as usize);
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    loop {
        let chunk = match tokio::time::timeout(STALL_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(c))) => c,
            Ok(Some(Err(e))) => return Err(format!("下载流中断: {e}")),
            Ok(None) => break,
            Err(_) => {
                return Err(format!(
                    "下载停滞超过 {} 秒，已中断（可重试或换源）",
                    STALL_TIMEOUT.as_secs()
                ))
            }
        };
        hasher.update(&chunk);
        buf.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;
        on_progress(chunk.len(), downloaded, total);
    }
    let got = hex_lower(&hasher.finalize());
    if got != expected_sha256.to_lowercase() {
        return Err(format!(
            "SHA-256 校验失败（期望 {}，实得 {}）——包可能被篡改或下载损坏，已阻止安装",
            expected_sha256, got
        ));
    }
    if let Some(t) = total {
        if t != downloaded {
            return Err(format!("下载不完整（声明 {t} 字节，实收 {downloaded} 字节）"));
        }
    }
    Ok(buf)
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// 安全解压 zip 到 `dest`（目录已存在）。返回解出的文件数。
///
/// 🔴 zip-slip 防护，两遍式：**第一遍全量校验条目名**（`enclosed_name()` 归一化——
/// 绝对路径、`..` 逃逸、带盘符/根前缀一律 None），任何一个不合法就整体拒绝；
/// 第二遍才落盘。绝不在半途发现恶意条目时已经把好条目写出去——调用方拿到的
/// 要么是完整解压，要么一个字节都没写。
///
/// 不用 `archive.extract()`：它按条目原样落盘（含符号链接语义）。这里逐条自己写，
/// 符号链接条目也只会落成普通文件（内容是链接目标文本），没有链接语义可利用。
pub fn extract_zip(bytes: &[u8], dest: &Path) -> Result<usize, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("zip 解析失败: {e}"))?;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("读取 zip 条目 {i} 失败: {e}"))?;
        if entry.enclosed_name().is_none() {
            return Err(format!(
                "拒绝解压：第 {i} 个条目的路径不合法（含 ../ 或绝对路径，疑似 zip-slip）"
            ));
        }
    }
    let mut count = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取 zip 条目 {i} 失败: {e}"))?;
        // 第一遍已保证全部合法，这里直接 expect 不再走错误分支
        let rel = entry.enclosed_name().expect("第一遍已校验条目名");
        let out = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("建目录失败 {out:?}: {e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败 {parent:?}: {e}"))?;
        }
        let mut f = std::fs::File::create(&out).map_err(|e| format!("建文件失败 {out:?}: {e}"))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("写文件失败 {out:?}: {e}"))?;
        count += 1;
    }
    Ok(count)
}

/// 原子安装一个包：临时目录解压 → 内容冒烟 → rename 到位。返回最终目录。
/// 幂等：目标版本目录已存在且探针通过就直接返回（换源重试的自然 Resume 点）。
pub fn install_pack(config_dir: &Path, id: &str, version: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let final_dir = pack_dir(config_dir, id, version);
    if final_dir.is_dir() && pack_probe_ok(&final_dir, id) {
        return Ok(final_dir);
    }
    std::fs::create_dir_all(external_root(config_dir))
        .map_err(|e| format!("建资源根目录失败: {e}"))?;
    let tmp = external_root(config_dir).join(format!(".tmp-{id}-{}", std::process::id()));
    if tmp.exists() {
        // 上一次崩溃/杀进程的残留。清掉再用来保证「临时目录里只有本次的内容」。
        std::fs::remove_dir_all(&tmp).ok();
    }
    std::fs::create_dir_all(&tmp).map_err(|e| format!("建临时目录失败: {e}"))?;

    let result = (|| -> Result<(), String> {
        let n = extract_zip(bytes, &tmp)?;
        if n == 0 {
            return Err("包内没有任何文件".to_string());
        }
        if !pack_probe_ok(&tmp, id) {
            return Err(format!("包内容不完整（{id} 的关键文件缺失），拒绝安装"));
        }
        Ok(())
    })();
    if let Err(e) = result {
        std::fs::remove_dir_all(&tmp).ok();
        return Err(e);
    }
    // rename 前最后确认目标状态：不存在最好；存在但探针不过（上次装了一半被杀）
    // 必须先清掉，否则 Windows 的 rename 目标已存在会直接失败。
    if final_dir.exists() {
        if pack_probe_ok(&final_dir, id) {
            std::fs::remove_dir_all(&tmp).ok();
            return Ok(final_dir);
        }
        std::fs::remove_dir_all(&final_dir).ok();
    }
    std::fs::rename(&tmp, &final_dir).map_err(|e| {
        std::fs::remove_dir_all(&tmp).ok();
        format!("安装 {id} 失败（{final_dir:?}: {e}）")
    })?;
    Ok(final_dir)
}

// ───────────────────────── 编排：ensure ─────────────────────────

/// ensure 过程的进度事件（命令层负责转成前端的 `resource:*` Tauri 事件）。
#[derive(Debug, Clone)]
pub enum PackEvent {
    Checking,
    /// 有包要下（id / title / notes / size）。前端据此弹初始化对话框。
    Missing(Vec<MissingPack>),
    /// 什么都不缺（含全部 legacy 认领）。
    Uptodate,
    Downloading { id: String },
    Progress {
        id: String,
        downloaded: u64,
        total: Option<u64>,
        bytes_per_sec: f64,
    },
    Installed { id: String, version: String },
}

#[derive(Debug, Clone)]
pub struct MissingPack {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub size: u64,
}

#[derive(Debug, Default)]
pub struct EnsureOutcome {
    /// 本次真正下载安装的 (id, version)
    pub installed: Vec<(String, String)>,
    /// 从旧安装包认领、未下载的包
    pub adopted_legacy: Vec<String>,
}

/// ensure 彻底失败（所有源都试过）时返回：已完成的部分 + 原因。
///
/// 为什么不是裸 String：已装好的包记在 state 里，用户点「重试」会自动跳过它们
/// （断点续传）。错误路径带上 outcome，前端才能说「3 个里已就绪 1 个」而不是
/// 「全部失败」——后者会让用户以为要从头再下 63MB。
#[derive(Debug)]
pub struct EnsureFailure {
    pub outcome: EnsureOutcome,
    pub message: String,
}

/// 把资源置备齐：拉清单 → 比对本地 → 缺的下载安装 → 更新状态。
///
/// `legacy_resource_dir`：旧版安装包的资源目录（认领检测用；dev 环境传 exe 旁目录即可）。
/// `force`：无视已有状态强制重下（设置页「重新下载组件」用）。
///
/// 端点顺序故障转移：某个源的清单拉不到就换下一个；某个包下载失败（重试 2 次后）
/// 也换下一个源从头继续——已装好的包在 state 里，换源后自动跳过，天然断点续传。
///
/// 失败（Err）时返回 `EnsureFailure`：携带已完成部分（见其文档）。
pub async fn ensure_packs(
    config_dir: &Path,
    legacy_resource_dir: Option<&Path>,
    force: bool,
    mut on_event: impl FnMut(PackEvent),
) -> Result<EnsureOutcome, EnsureFailure> {
    // 这两个错误发生在任何包之前，outcome 只能是空的
    let endpoints = resource_endpoints().map_err(|message| EnsureFailure {
        outcome: EnsureOutcome::default(),
        message,
    })?;
    let client = http_client().map_err(|message| EnsureFailure {
        outcome: EnsureOutcome::default(),
        message,
    })?;
    let mut outcome = EnsureOutcome::default();

    on_event(PackEvent::Checking);

    let mut last_err: Option<String> = None;
    for endpoint in &endpoints {
        // 清单：网络类错误退避重试 2 次；HTTP 4xx（源上没有这份清单）不重试——
        // 确定性结论，重试只是让用户多等一轮退避。
        let manifest = match retry_with_backoff(2, "拉取资源清单", |e: &String| !e.contains("HTTP 4"), || {
            fetch_manifest(&client, endpoint)
        })
        .await
        {
            Ok(m) => m,
            Err(e) => {
                log::warn!("资源源 {endpoint} 清单获取失败，换下一个源: {e}");
                last_err = Some(e);
                continue;
            }
        };

        // 逐包判定：已装且版本一致 → 跳过；旧安装包里有 → 认领（记 legacy，不下载）；
        // 其余进待下载列表。认领先落盘：哪怕后面下载失败，legacy 认领也不该丢。
        let mut state = PacksState::load(config_dir);
        let mut needed: Vec<MissingPack> = Vec::new();
        for pack in manifest.packs_for_current_platform() {
            let meta = pack_meta(&pack.id);
            let title = if pack.title.is_empty() {
                meta.title.to_string()
            } else {
                pack.title.clone()
            };
            let notes = if pack.notes.is_empty() {
                meta.notes.to_string()
            } else {
                pack.notes.clone()
            };
            if !force {
                let installed_same = state
                    .packs
                    .get(&pack.id)
                    .map(|rec| !rec.legacy && rec.version == pack.version && pack_dir(config_dir, &pack.id, &rec.version).is_dir())
                    .unwrap_or(false);
                if installed_same {
                    continue;
                }
                // 旧安装包资源认领：无记录，或记录本身就是 legacy（沿用）
                let legacy_record = match state.packs.get(&pack.id) {
                    None => true,
                    Some(rec) => rec.legacy,
                };
                if let Some(rd) = legacy_resource_dir {
                    if legacy_record && legacy_present(rd, &pack.id) {
                        state.packs.insert(
                            pack.id.clone(),
                            InstalledPack {
                                version: String::new(),
                                legacy: true,
                                size: legacy_dir_size(rd, &pack.id),
                            },
                        );
                        outcome.adopted_legacy.push(pack.id.clone());
                        continue;
                    }
                }
            }
            needed.push(MissingPack {
                id: pack.id.clone(),
                title,
                notes,
                size: pack.size,
            });
        }
        if !outcome.adopted_legacy.is_empty() {
            let _ = state.save(config_dir);
        }

        if needed.is_empty() {
            on_event(PackEvent::Uptodate);
            return Ok(outcome);
        }

        on_event(PackEvent::Missing(needed.clone()));

        // 下载安装。手写重试环而不用 retry_with_backoff：进度回调要闭包捕获
        // on_event（FnMut），塞进要求 Fn 的重试helper 会直接编译不过。
        let mut failed: Option<String> = None;
        'packs: for want in &needed {
            let Some(pack) = manifest.pack(&want.id) else {
                failed = Some(format!("清单里找不到 {}", want.id));
                break 'packs;
            };
            on_event(PackEvent::Downloading {
                id: pack.id.clone(),
            });

            let mut attempt = 0u32;
            // 清单 parse 时已校验过 url 合法性，这里再解析一次只为拿到 &Url 类型
            let pack_url = url::Url::parse(&pack.url).expect("清单 url 已在 parse 时校验");
            let bytes = loop {
                let mut win_start = std::time::Instant::now();
                let mut win_bytes: u64 = 0;
                let mut last_bps: f64 = 0.0;
                let ev_id = pack.id.clone();
                let r = download_pack(&client, &pack_url, &pack.sha256, |chunk_len, downloaded, total| {
                    // 下载速度：~250ms 窗口限流重算（与 update.rs 的进度口径一致，
                    // 快网速下 chunk 回调每秒几十次，逐次算瞬时速率会跳得难看）。
                    // 注意：这里刻意**不是** move 闭包——on_event 是 FnMut，
                    // move 会把它整个带进 download_pack 的参数，第二个包再用就是
                    // use-after-move。借用捕获即可，闭包生命周期不超出本次调用。
                    win_bytes += chunk_len as u64;
                    let elapsed = win_start.elapsed();
                    if elapsed.as_millis() >= 250 {
                        last_bps = win_bytes as f64 / elapsed.as_secs_f64();
                        win_start = std::time::Instant::now();
                        win_bytes = 0;
                    }
                    on_event(PackEvent::Progress {
                        id: ev_id.clone(),
                        downloaded,
                        total,
                        bytes_per_sec: last_bps,
                    });
                })
                .await;
                match r {
                    Ok(b) => break b,
                    Err(e) => {
                        attempt += 1;
                        if attempt > 2 {
                            failed = Some(format!("下载 {} 失败: {e}", pack.id));
                            break 'packs;
                        }
                        let jitter_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |d| (d.subsec_nanos() % 512) as u64);
                        log::warn!(
                            "[Resource] 下载 {} 失败（第 {attempt}/2 次），{}s 后重试: {e}",
                            pack.id,
                            1u64 << (attempt - 1),
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(
                            (1u64 << (attempt - 1)) * 1000 + jitter_ms,
                        ))
                        .await;
                    }
                }
            };

            if let Err(e) = install_pack(config_dir, &pack.id, &pack.version, &bytes) {
                failed = Some(e);
                break 'packs;
            }
            state.packs.insert(
                pack.id.clone(),
                InstalledPack {
                    version: pack.version.clone(),
                    legacy: false,
                    // 实收字节数（SHA-256 已校验过，与源声明不一致时以实收为准）
                    size: Some(bytes.len() as u64),
                },
            );
            if let Err(e) = state.save(config_dir) {
                failed = Some(e);
                break 'packs;
            }
            outcome
                .installed
                .push((pack.id.clone(), pack.version.clone()));
            on_event(PackEvent::Installed {
                id: pack.id.clone(),
                version: pack.version.clone(),
            });
        }

        if let Some(e) = failed {
            log::warn!("资源源 {endpoint} 安装失败，换下一个源: {e}");
            last_err = Some(e);
            continue;
        }
        return Ok(outcome);
    }

    Err(EnsureFailure {
        outcome,
        message: format!(
            "全部资源源均失败（已依次尝试）: {}",
            last_err.unwrap_or_else(|| "未知错误".to_string())
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncforge-rp-test-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // ─── 清单 ───

    fn sample_manifest_json() -> String {
        serde_json::json!({
            "packs": [
                {
                    "id": "ecj",
                    "version": "abc123def456",
                    "title": "Java 编译器",
                    "size": 100,
                    "sha256": "a".repeat(64),
                    "url": "https://example.com/ecj.zip"
                },
                {
                    "id": "jdtls",
                    "version": "fff000111222",
                    "platforms": ["windows"],
                    "size": 200,
                    "sha256": "b".repeat(64),
                    "url": "https://example.com/jdtls.zip"
                }
            ]
        })
        .to_string()
    }

    #[test]
    fn manifest_parses_and_validates() {
        let m = ResourcesManifest::parse(&sample_manifest_json()).unwrap();
        assert_eq!(m.packs.len(), 2);
        assert_eq!(m.pack("ecj").unwrap().version, "abc123def456");
        assert!(m.pack("nope").is_none());
    }

    #[test]
    fn manifest_rejects_bad_sha_and_empty() {
        let bad_sha = r#"{"packs":[{"id":"ecj","version":"v1","size":1,"sha256":"xyz","url":"https://e.com/a.zip"}]}"#;
        assert!(ResourcesManifest::parse(bad_sha).is_err());
        assert!(ResourcesManifest::parse(r#"{"packs":[]}"#).is_err());
        assert!(ResourcesManifest::parse("not json").is_err());
    }

    #[test]
    fn platform_filter_matches_current_os() {
        let m = ResourcesManifest::parse(&sample_manifest_json()).unwrap();
        let ids: Vec<&str> = m.packs_for_current_platform().iter().map(|p| p.id.as_str()).collect();
        // ecj 无 platforms 限定 ⇒ 任何平台都在；jdtls 仅 windows
        assert!(ids.contains(&"ecj"));
        assert_eq!(ids.contains(&"jdtls"), cfg!(windows));
    }

    // ─── 状态 ───

    #[test]
    fn state_roundtrip_and_active_dir() {
        let dir = temp_dir("state");
        let st = PacksState::load(&dir);
        assert!(st.packs.is_empty(), "不存在的状态文件 = 空状态");

        // 只写 state 不建目录 ⇒ active_dir 必须返回 None（双重确认）
        let mut st = PacksState::default();
        st.packs.insert(
            PACK_ECJ.to_string(),
            InstalledPack {
                version: "v1".into(),
                legacy: false,
                size: Some(1234),
            },
        );
        st.save(&dir).unwrap();
        // size（2026-10-29 审查 L1 新增）必须过序列化往返
        let reloaded = PacksState::load(&dir);
        assert_eq!(reloaded.packs.get(PACK_ECJ).unwrap().size, Some(1234));
        assert!(active_dir(&dir, PACK_ECJ).is_none(), "目录不存在不能算生效");

        // 建目录后才生效
        std::fs::create_dir_all(pack_dir(&dir, PACK_ECJ, "v1")).unwrap();
        assert_eq!(active_dir(&dir, PACK_ECJ), Some(pack_dir(&dir, PACK_ECJ, "v1")));

        // legacy 记录 ⇒ active_dir None（资源在旧安装目录，不在外部根）
        let mut st2 = PacksState::default();
        st2.packs.insert(
            PACK_ECJ.to_string(),
            InstalledPack {
                version: String::new(),
                legacy: true,
                size: None,
            },
        );
        st2.save(&dir).unwrap();
        assert!(active_dir(&dir, PACK_ECJ).is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn state_without_size_field_loads() {
        // 老状态文件（2026-10-29 之前的版本写的）没有 size 字段：
        // serde(default) 必须兜住，读成 None 而不是整个文件作废。
        let dir = temp_dir("nosize");
        std::fs::write(
            state_path(&dir),
            r#"{"packs":{"ecj":{"version":"v1","legacy":false}}}"#,
        )
        .unwrap();
        let st = PacksState::load(&dir);
        let rec = st.packs.get(PACK_ECJ).expect("老状态文件应正常加载");
        assert_eq!(rec.version, "v1");
        assert!(!rec.legacy);
        assert_eq!(rec.size, None, "缺 size 字段读成 None，不阻断加载");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn state_corrupt_file_falls_back_to_default() {
        let dir = temp_dir("corrupt");
        std::fs::write(state_path(&dir), "{ 坏 json").unwrap();
        assert!(PacksState::load(&dir).packs.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ─── 端点 ───

    #[test]
    fn conf_endpoints_parse_from_embedded_config() {
        // 直接解析内嵌的 tauri.conf.json：配置写错字节这里就红。
        let eps = endpoints_from_conf();
        assert!(
            eps.len() >= 3,
            "tauri.conf.json 的 plugins.resourcePacks.endpoints 应有至少 3 个源（Release / Gitee / gh-pages），实得 {}",
            eps.len()
        );
        assert!(eps.iter().all(|u| u.scheme() == "https"));
        // 顺序即优先级：Release 首选、Gitee 次之（国内加速），删一个这里就红——
        // 2026-10-29 审查发现过「Gitee 镜像推了但客户端读不到」的事故。
        assert!(
            eps[0].host_str() == Some("github.com"),
            "第一源应为 GitHub Release: {}",
            eps[0]
        );
        assert!(
            eps.iter().any(|u| u.host_str() == Some("gitee.com")),
            "endpoints 里应含 Gitee 镜像源（客户端唯一能读到 resources-gitee.json 的地方）: {:?}",
            eps
        );
    }

    #[test]
    fn http_only_allowed_for_loopback() {
        assert!(check_url_scheme(&url::Url::parse("https://example.com/a.json").unwrap()).is_ok());
        assert!(check_url_scheme(&url::Url::parse("http://127.0.0.1:1234/a.json").unwrap()).is_ok());
        assert!(check_url_scheme(&url::Url::parse("http://evil.com/a.json").unwrap()).is_err());
        assert!(check_url_scheme(&url::Url::parse("ftp://evil.com/a.json").unwrap()).is_err());
    }

    // ─── 解压安全 ───

    /// 造一个含恶意条目的 zip（../ 逃逸 + 绝对路径）。
    fn malicious_zip() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = Default::default();
            w.start_file("good.txt", opts).unwrap();
            std::io::Write::write_all(&mut w, b"ok").unwrap();
            // enclosed_name 对它是 None ⇒ 必须整个包被拒
            w.start_file("../escape.txt", opts).unwrap();
            std::io::Write::write_all(&mut w, b"evil").unwrap();
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn extract_rejects_zip_slip() {
        let dir = temp_dir("zipslip");
        let dest = dir.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let err = extract_zip(&malicious_zip(), &dest).unwrap_err();
        assert!(err.contains("zip-slip") || err.contains("路径不合法"), "错误信息应点名原因: {err}");
        // 恶意文件一个都不能落盘
        assert!(!dir.join("escape.txt").exists());
        assert!(!dest.join("good.txt").exists(), "整包拒绝，好的条目也不该部分落盘");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn extract_normal_zip_and_probe() {
        let dir = temp_dir("normal");
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = Default::default();
            w.add_directory("plugins/", opts).unwrap();
            w.start_file("plugins/a.jar", opts).unwrap();
            std::io::Write::write_all(&mut w, b"jar").unwrap();
            w.start_file("config_win/config.ini", opts).unwrap();
            std::io::Write::write_all(&mut w, b"ini").unwrap();
            w.finish().unwrap();
        }
        let dest = dir.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let n = extract_zip(&buf, &dest).unwrap();
        assert_eq!(n, 2);
        assert!(dest.join("plugins/a.jar").is_file());
        assert!(dest.join("config_win/config.ini").is_file());
        // jdtls 探针：plugins + config_win 都在才算完整
        assert!(pack_probe_ok(&dest, PACK_JDTLS));
        // ecj 探针：缺 ecj-3.17.jar ⇒ 不完整
        assert!(!pack_probe_ok(&dest, PACK_ECJ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_pack_is_atomic_and_idempotent() {
        let dir = temp_dir("install");
        let config_dir = dir.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();

        // ecj 包：只有一个 jar，探针能过
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = Default::default();
            w.start_file("ecj-3.17.jar", opts).unwrap();
            std::io::Write::write_all(&mut w, b"jar-bytes").unwrap();
            w.finish().unwrap();
        }

        let d1 = install_pack(&config_dir, PACK_ECJ, "v1", &buf).unwrap();
        assert_eq!(d1, pack_dir(&config_dir, PACK_ECJ, "v1"));
        assert!(d1.join("ecj-3.17.jar").is_file());
        // 临时目录已清走
        let leftovers: Vec<_> = std::fs::read_dir(external_root(&config_dir))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .filter(|n| n.to_string_lossy().starts_with(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "临时目录必须清掉: {leftovers:?}");

        // 幂等：再装一次返回同一目录，不报错
        let d2 = install_pack(&config_dir, PACK_ECJ, "v1", &buf).unwrap();
        assert_eq!(d2, d1);

        // 内容不对的包（探针失败）必须拒绝且不留目录
        let empty: Vec<u8> = Vec::new();
        assert!(install_pack(&config_dir, PACK_ECJ, "v2", &empty).is_err());
        assert!(!pack_dir(&config_dir, PACK_ECJ, "v2").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sha256_hex_helper() {
        // sha256("") 的前 8 位是 e3b0c442
        let h = Sha256::new();
        let out = hex_lower(&h.finalize());
        assert!(out.starts_with("e3b0c442"));
        assert_eq!(out.len(), 64);
    }

    // ─── ensure 编排：legacy 认领（2026-10-29 审查 L4 补的覆盖） ───

    /// 起一个只服务 `/resources.json` 的本地源（legacy 场景不该下载任何包；
    /// 真去下载只会拿到「连接被拒」——测试因此能分辨认领是否生效）。
    fn spawn_manifest_only_source(manifest: String) -> u16 {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定临时端口失败");
        let port = listener.local_addr().expect("读取临时端口失败").port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let Ok(mut stream) = stream else { break };
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut reader = BufReader::new(match stream.try_clone() {
                    Ok(s) => s,
                    Err(_) => continue,
                });
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) if line.trim().is_empty() => break,
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
                let body = manifest.clone().into_bytes();
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            }
        });
        port
    }

    #[tokio::test]
    async fn ensure_adopts_legacy_without_download() {
        let dir = temp_dir("legacy-adopt");
        let config_dir = dir.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();

        // 旧安装包布局：resource_dir/ecj/ecj-3.17.jar（探针能过）
        let legacy_root = dir.join("legacy-res");
        std::fs::create_dir_all(legacy_root.join(PACK_ECJ)).unwrap();
        std::fs::write(legacy_root.join(PACK_ECJ).join("ecj-3.17.jar"), b"legacy-jar-bytes").unwrap();
        let legacy_size = b"legacy-jar-bytes".len() as u64;

        // 清单里 ecj 的 url 指向 1 号端口（必被拒）：万一认领漏了走下下载，
        // 失败信息会很清楚，不会误判成通过。
        let manifest = format!(
            r#"{{"packs":[{{"id":"ecj","version":"cafe1234babe","title":"Java 编译器","size":1,"sha256":"{}","url":"http://127.0.0.1:1/packs/ecj.zip"}}]}}"#,
            "0".repeat(64)
        );
        let port = spawn_manifest_only_source(manifest);
        std::env::set_var(
            "APP_RESOURCES_ENDPOINT",
            format!("http://127.0.0.1:{port}/resources.json"),
        );

        let mut events = Vec::new();
        let outcome = ensure_packs(&config_dir, Some(&legacy_root), false, |ev| events.push(ev))
            .await
            .expect("有 legacy 可认领时应成功");
        std::env::remove_var("APP_RESOURCES_ENDPOINT");

        assert_eq!(outcome.adopted_legacy, vec![PACK_ECJ.to_string()]);
        assert!(outcome.installed.is_empty(), "认领不应伴随下载");

        // state：legacy 记录 + 旧目录实测大小（设置页展示用）
        let st = PacksState::load(&config_dir);
        let rec = st.packs.get(PACK_ECJ).expect("state 应记录认领");
        assert!(rec.legacy);
        assert_eq!(rec.version, "");
        assert_eq!(rec.size, Some(legacy_size));

        // 没有发生下载/安装：外部根里不应有任何版本目录
        let leaked = std::fs::read_dir(external_root(&config_dir))
            .map(|d| {
                d.filter_map(|e| e.ok())
                    .any(|e| e.file_name().to_string_lossy().starts_with("ecj@"))
            })
            .unwrap_or(false);
        assert!(!leaked, "认领路径不得下载安装");
        // legacy 记录的 active_dir 是 None（资源在旧目录，不在外部根）
        assert!(active_dir(&config_dir, PACK_ECJ).is_none());

        // 事件序列：checking → uptodate；不该出现 available（有包要下）
        let kinds: Vec<&str> = events
            .iter()
            .map(|e| match e {
                PackEvent::Checking => "checking",
                PackEvent::Missing(_) => "missing",
                PackEvent::Uptodate => "uptodate",
                _ => "other",
            })
            .collect();
        assert!(kinds.contains(&"uptodate"), "认领完成应发 uptodate: {kinds:?}");
        assert!(!kinds.contains(&"missing"), "有 legacy 可认领时不该报缺失: {kinds:?}");

        std::fs::remove_dir_all(&dir).ok();
    }
}
