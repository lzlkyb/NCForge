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
//! （state 记 `legacy: true`，不重下）。认领的包**永不自动更新**——清单版本变化
//! 也不会触发重下，只能由用户在设置页手动「重新下载组件」。这是已知取舍：
//! 资源版本锁定（jdtls 0.57.0、ecj 3.17），变化频率以年计，而自动重下意味着
//! 用户某天开机突然被下载 54MB。（早期注释写过「清单版本变化时拉新版」，
//! 与代码实际行为相反，以本条为准。）

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
    ALL_PACKS
        .iter()
        .find(|m| m.id == id)
        .unwrap_or(&FALLBACK_META)
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
        let m: Self =
            serde_json::from_str(text).map_err(|e| format!("resources.json 解析失败: {e}"))?;
        if m.packs.is_empty() {
            return Err("resources.json 里没有任何资源包".to_string());
        }
        for p in &m.packs {
            if p.id.is_empty() || p.version.is_empty() {
                return Err(format!("资源包缺少 id/version: {}", p.id));
            }
            // id/version 会被拼进安装目录名（`pack_dir`）：带路径分隔符或 `..`
            // 就是路径穿越，清单在解析期就该红，而不是等到写盘时才发现
            if !safe_component(&p.id) || !safe_component(&p.version) {
                return Err(format!(
                    "资源包 id/version 不合法（只允许字母数字与 . _ -，不能是 . 或 ..）: {}@{}",
                    p.id, p.version
                ));
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
            .filter(|p| {
                p.platforms
                    .as_ref()
                    .map(|ps| ps.iter().any(|x| x == os))
                    .unwrap_or(true)
            })
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
    /// tmp 名带 pid + 进程内原子序号：固定名时两个保存并发（ensure_packs 后台跑着，
    /// 设置页又触发一次）会互相抢临时文件——A 写一半被 B 覆盖再 rename，
    /// 落盘的就是半截状态。唯一 tmp 名让每次保存各写各的，rename 原子替换。
    pub fn save(&self, config_dir: &Path) -> Result<(), String> {
        let path = state_path(config_dir);
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = path.with_extension(format!("json.tmp.{}.{seq}", std::process::id()));
        let text =
            serde_json::to_string_pretty(self).map_err(|e| format!("状态序列化失败: {e}"))?;
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

/// 能安全用作单层目录名的字符串：非空、≤64 字节、不是 `.`/`..`、
/// 只含字母数字与 `._-`（版本号是 sha256 前 12 位十六进制，id 是固定短名，都满足）。
///
/// 关键在「不含任何路径分隔符」：它同时排除 `/`、`\`，也就排除了把
/// `{id}@{version}` 拼成可穿越路径的可能。
fn safe_component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// 某包某版本的目录：`{config_dir}/resources/{id}@{version}`。
///
/// 🔴 `id` / `version` 都是**外部输入**：`version` 直接抄自远端 `resources.json`
/// （清单自述不签名），`id` 同样来自清单。而 `install_pack` 会对这个路径做
/// `create_dir_all` / `rename` / `remove_dir_all`——只要拼接结果里带上一层 `..`，
/// 那就是「写/删任意目录」。
///
/// 实测（2026-10-29）：`version = "x/../../../evil"` 时，`format!` 得到
/// `resources/ecj@x/../../../evil`；`create_dir_all` 会先建出中间目录 `ecj@x`，
/// 再逐段回退，文件最终落在配置目录**之外**。所以这里必须挡，不能只靠
/// `ResourcesManifest::parse`——本地 `resource-packs.json` 里的 `version` 同样会被读进来。
///
/// 非法输入退化成固定占位名：不 panic（这不是用户可见的错误路径），也不会逃出
/// `resources/`。真正该报错的地方在 `ResourcesManifest::parse`，那里会直接拒绝坏清单。
pub fn pack_dir(config_dir: &Path, id: &str, version: &str) -> PathBuf {
    let id = if safe_component(id) { id } else { "invalid-id" };
    let version = if safe_component(version) {
        version
    } else {
        "invalid-version"
    };
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
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
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
                let u =
                    url::Url::parse(t).map_err(|e| format!("资源源 \"{t}\" 不是合法 URL: {e}"))?;
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
            Ok(u) => {
                // 与 env 路径同一把尺子：http 外网源静默放过 = 把整个信任模型
                // （HTTPS + 多源）掏空。conf 误配在这里就该红，不是等用户流量被劫持。
                if let Err(e) = check_url_scheme(&u) {
                    log::error!("资源源 URL 被拒绝，已跳过: {s} ({e})");
                    return None;
                }
                Some(u)
            }
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

/// 单个包的下载硬上限：清单声明 size 与 64MB 地板取大，再留 12.5% 余量。
///
/// 为什么必须限「累计字节」而不只是预分配容量：`Vec::with_capacity` 只是初始容量，
/// 循环里 `extend_from_slice` 对总量没有任何检查——源不给 Content-Length 时，
/// LAN 速度 60 秒即可推入数 GB，而 SHA-256 要全量收完才校验，炸弹已经进了内存。
/// （更彻底的解法是边下边写临时文件、只把哈希状态留在内存；当前包体 ≤54MB，
/// 上限把内存占用钉死在 ~72MB 内，先不做流式改造。）
pub fn download_cap(size: u64) -> u64 {
    const FLOOR: u64 = 64 << 20;
    let base = size.max(FLOOR);
    base + base / 8
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // 只卡「建连」。不设总超时：54MB 的包在慢网上合法地需要几十分钟，
        // 停滞检测（STALL_TIMEOUT）比总超时更准确地表达「坏了」。
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

/// 拉清单。小文件，给 30s 总超时足够（防「收下连接再不响应」的挂死）。
pub async fn fetch_manifest(
    client: &reqwest::Client,
    url: &url::Url,
) -> Result<ResourcesManifest, String> {
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
/// `max_bytes` 累计字节硬上限（见 `download_cap`），超限立即断流报错。
pub async fn download_pack(
    client: &reqwest::Client,
    url: &url::Url,
    expected_sha256: &str,
    max_bytes: u64,
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
        if downloaded > max_bytes {
            return Err(format!(
                "下载量超过上限（已收 {downloaded} 字节，上限 {max_bytes}）——源可能声明了错误的大小，或根本不是预期的包"
            ));
        }
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
            return Err(format!(
                "下载不完整（声明 {t} 字节，实收 {downloaded} 字节）"
            ));
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

/// 解压防御上限：累计未压缩字节与条目数。
///
/// zip-slip 防护管的是「写去哪」，这两个上限管的是「写多少」：资源包信任模型
/// 自述「清单自身不签名」，源一旦被投毒，54MB 压缩出数百 GB 的炸弹会在冒烟检查
/// 之前把磁盘写满。阈值按现有最大包（jdtls 解压后约 200MB）留了一个数量级余量。
const EXTRACT_MAX_TOTAL: u64 = 512 << 20;
const EXTRACT_MAX_ENTRIES: usize = 100_000;

/// 安全解压 zip 到 `dest`（目录已存在）。返回解出的文件数。
///
/// 🔴 zip-slip 防护，两遍式：**第一遍全量校验条目名**（`enclosed_name()` 归一化——
/// 绝对路径、`..` 逃逸、带盘符/根前缀一律 None），任何一个不合法就整体拒绝；
/// 第二遍才落盘。绝不在半途发现恶意条目时已经把好条目写出去——调用方拿到的
/// 要么是完整解压，要么一个字节都没写。
///
/// 解压炸弹防护（`EXTRACT_MAX_TOTAL` / `EXTRACT_MAX_ENTRIES`）同样两遍都查：
/// 第一遍按 zip 头声明的未压缩大小预检（炸弹最常见的形态，此时一个字节都没写），
/// 第二遍按实际写入字节复核对——头部大小可以撒谎，落盘字节不会。
///
/// 不用 `archive.extract()`：它按条目原样落盘（含符号链接语义）。这里逐条自己写，
/// 符号链接条目也只会落成普通文件（内容是链接目标文本），没有链接语义可利用。
pub fn extract_zip(bytes: &[u8], dest: &Path) -> Result<usize, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("zip 解析失败: {e}"))?;
    // 第一遍：条目名合法性 + 头部声明总量预检
    let mut declared_total: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目 {i} 失败: {e}"))?;
        if entry.enclosed_name().is_none() {
            return Err(format!(
                "拒绝解压：第 {i} 个条目的路径不合法（含 ../ 或绝对路径，疑似 zip-slip）"
            ));
        }
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > EXTRACT_MAX_TOTAL || i + 1 > EXTRACT_MAX_ENTRIES {
            return Err(format!(
                "拒绝解压：zip 声明解压后共 {} 字节 / {} 个条目，超过上限（{} 字节 / {} 条）——疑似解压炸弹",
                declared_total,
                i + 1,
                EXTRACT_MAX_TOTAL,
                EXTRACT_MAX_ENTRIES
            ));
        }
    }
    let mut count = 0usize;
    let mut written: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目 {i} 失败: {e}"))?;
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
        let n =
            std::io::copy(&mut entry, &mut f).map_err(|e| format!("写文件失败 {out:?}: {e}"))?;
        // 第二遍：按实际落盘字节核对（头部大小可撒谎，写入字节不会）。
        // 到这里已写了部分文件，由调用方（install_pack）清理临时目录。
        written += n;
        count += 1;
        if written > EXTRACT_MAX_TOTAL || count > EXTRACT_MAX_ENTRIES {
            return Err(format!(
                "拒绝解压：实际解压内容超过上限（已写 {written} 字节 / {count} 个文件）——疑似解压炸弹"
            ));
        }
    }
    Ok(count)
}

/// 原子安装一个包：临时目录解压 → 内容冒烟 → rename 到位。返回最终目录。
/// 幂等：目标版本目录已存在且探针通过就直接返回（换源重试的自然 Resume 点）。
pub fn install_pack(
    config_dir: &Path,
    id: &str,
    version: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
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
    Downloading {
        id: String,
    },
    Progress {
        id: String,
        downloaded: u64,
        total: Option<u64>,
        bytes_per_sec: f64,
    },
    Installed {
        id: String,
        version: String,
    },
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
/// 清单拉取的重试判定：网络类错误重试；404/410 是确定性结论（源上没有这份清单）
/// 不重试。408（请求超时）与 429（限流）相反——都该再试。
/// 以前用 `contains("HTTP 4")` 猜类别，408/429 被误判成不可重试，镜像站一限流
/// 就直接换源，白丢一次就近源的机会。
fn manifest_err_retryable(e: &str) -> bool {
    !(e.contains("HTTP 404") || e.contains("HTTP 410"))
}

/// 下载错误的「确定性」判定：这些错误对同一 URL 重试必然复现——SHA-256 不符
/// 说明字节就是那些字节，超上限说明源那头就是那么大。重试只是让用户多等一轮
/// 退避，直接换源（镜像上可能是好的）。
fn is_deterministic_download_error(e: &str) -> bool {
    e.starts_with("SHA-256 校验失败") || e.starts_with("下载量超过上限")
}

/// 本地是否已「全就绪」：三个包都有记录且资源真在磁盘上（安装目录或 legacy 认领）。
/// 用于离线短路（M8-5）：清单一个源都拉不到时，本地已齐就不该判失败。
fn locally_ready(
    config_dir: &Path,
    legacy_resource_dir: Option<&Path>,
    state: &PacksState,
) -> bool {
    ALL_PACKS.iter().all(|meta| {
        let Some(rec) = state.packs.get(meta.id) else {
            return false;
        };
        if rec.legacy {
            // legacy 认领：资源在旧安装目录里，按关键文件确认还在
            return legacy_resource_dir
                .map(|rd| legacy_present(rd, meta.id))
                .unwrap_or(false);
        }
        pack_dir(config_dir, meta.id, &rec.version).is_dir()
    })
}

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
    // config_dir 在 spawn_blocking 闭包里要用（'static），循环外克隆一份 owned
    let cfg_owned = config_dir.to_path_buf();
    for endpoint in &endpoints {
        // 清单：网络类错误退避重试 2 次；404/410（源上没有这份清单）不重试——
        // 确定性结论，重试只是让用户多等一轮退避。
        let manifest = match retry_with_backoff(
            2,
            "拉取资源清单",
            |e: &String| manifest_err_retryable(e),
            || fetch_manifest(&client, endpoint),
        )
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
                    .map(|rec| {
                        !rec.legacy
                            && rec.version == pack.version
                            && pack_dir(config_dir, &pack.id, &rec.version).is_dir()
                    })
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
                        // legacy_dir_size 要递归遍历整棵旧目录（jdtls 54MB 起），
                        // 属磁盘重活：进 spawn_blocking，不占 tokio worker。
                        let rd_owned = rd.to_path_buf();
                        let id_owned = pack.id.clone();
                        let size = tokio::task::spawn_blocking(move || {
                            legacy_dir_size(&rd_owned, &id_owned)
                        })
                        .await
                        .unwrap_or_else(|e| {
                            log::warn!("legacy 目录大小测算任务异常: {e}");
                            None
                        });
                        state.packs.insert(
                            pack.id.clone(),
                            InstalledPack {
                                version: String::new(),
                                legacy: true,
                                size,
                            },
                        );
                        // 换源后同一个 legacy 包会被再认领一次：去重，
                        // 否则「已就绪 N/3」虚高（3 个包能数出 4 次）。
                        if !outcome.adopted_legacy.contains(&pack.id) {
                            outcome.adopted_legacy.push(pack.id.clone());
                        }
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
            // 认领记录必须落盘：不落盘的话下次启动再认领一遍（幂等但浪费），
            // 且「已认领」的状态对设置页不可见。落盘失败要如实报错——
            // 以前 `let _ = state.save()` 直接吞掉，配置目录出问题会被瞒到下载阶段。
            let st = state.clone();
            let cfg = cfg_owned.clone();
            match tokio::task::spawn_blocking(move || st.save(&cfg)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    last_err = Some(e);
                    continue; // 换源没意义（本地磁盘问题），但保持与外层一致的控制流
                }
                Err(e) => {
                    last_err = Some(format!("认领状态落盘任务异常: {e}"));
                    continue;
                }
            }
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
                let r = download_pack(
                    &client,
                    &pack_url,
                    &pack.sha256,
                    download_cap(pack.size),
                    |chunk_len, downloaded, total| {
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
                    },
                )
                .await;
                match r {
                    Ok(b) => break b,
                    Err(e) => {
                        // 确定性错误（SHA-256 不符 / 超上限）对同一 URL 重试必然
                        // 复现：直接换源，不白等退避。
                        if is_deterministic_download_error(&e) {
                            log::warn!("[Resource] 下载 {} 遇到确定性错误，换源: {e}", pack.id);
                            failed = Some(format!("下载 {} 失败: {e}", pack.id));
                            break 'packs;
                        }
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

            // install_pack 要解压 54MB + 冒烟 + rename，是数秒量级的磁盘重活：
            // 进 spawn_blocking，不钉占 tokio worker（同 runtime 上的其它 async
            // 命令——状态轮询、日志流——会被连带延迟数秒到数十秒）。
            let cfg = cfg_owned.clone();
            let install_id = pack.id.clone();
            let install_ver = pack.version.clone();
            let bytes_len = bytes.len() as u64; // bytes 随后被移进闭包，长度先记下
            let installed = tokio::task::spawn_blocking(move || {
                install_pack(&cfg, &install_id, &install_ver, &bytes)
            })
            .await;
            let installed = match installed {
                Ok(r) => r,
                Err(e) => {
                    failed = Some(format!("安装 {} 的任务异常: {e}", pack.id));
                    break 'packs;
                }
            };
            if let Err(e) = installed {
                failed = Some(e);
                break 'packs;
            }
            state.packs.insert(
                pack.id.clone(),
                InstalledPack {
                    version: pack.version.clone(),
                    legacy: false,
                    // 实收字节数（SHA-256 已校验过，与源声明不一致时以实收为准）
                    size: Some(bytes_len),
                },
            );
            // 状态落盘同样是磁盘活：进 spawn_blocking。失败要中断换源——
            // 没记录的话下次启动会重下这个包（幂等但有代价）。
            let st = state.clone();
            let cfg = cfg_owned.clone();
            match tokio::task::spawn_blocking(move || st.save(&cfg)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    failed = Some(e);
                    break 'packs;
                }
                Err(e) => {
                    failed = Some(format!("资源包状态落盘任务异常: {e}"));
                    break 'packs;
                }
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

    // 离线短路：所有源的清单都拉不到时，如果本地三包都已就绪（安装目录或 legacy
    // 认领，资源文件真实在磁盘上、finder 回退链能找到），判可用而不是整体失败。
    // 「本地已就绪 + 暂时连不上源」语义上就是 uptodate——以前这里直接发 error，
    // 离线笔记本每次冷启动都触发数分钟后台网络重试，而资源其实一直是齐的。
    // force（设置页「重新下载组件」）不适用：那是明确要求联网拉新，必须报网络错。
    if !force && last_err.is_some() {
        let state = PacksState::load(config_dir);
        if locally_ready(config_dir, legacy_resource_dir, &state) {
            log::info!("[Resource] 清单源均不可达，但本地资源已就绪，按 uptodate 放行");
            on_event(PackEvent::Uptodate);
            return Ok(outcome);
        }
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

    /// 清单里的 id/version 会被拼进安装目录名：带 `..` 或分隔符必须在解析期就拒。
    /// （2026-10-29 实测过 `version = "x/../../../evil"` 能把文件写到配置目录之外。）
    #[test]
    fn manifest_rejects_path_traversal_in_id_or_version() {
        let sha = "a".repeat(64);
        for (id, ver) in [
            ("ecj", "x/../../../evil"),
            ("ecj", "../../evil"),
            ("..", "v1"),
            ("a/b", "v1"),
            (r"a\b", "v1"),
            ("ecj", ".."),
        ] {
            let json = format!(
                r#"{{"packs":[{{"id":"{id}","version":"{ver}","size":1,"sha256":"{sha}","url":"https://e.com/a.zip"}}]}}"#
            );
            assert!(
                ResourcesManifest::parse(&json).is_err(),
                "id={id:?} version={ver:?} 应被拒绝"
            );
        }
        // 正常的 hex 版本号与短 id 照常通过
        let ok = format!(
            r#"{{"packs":[{{"id":"jdtls","version":"abc123def456","size":1,"sha256":"{sha}","url":"https://e.com/a.zip"}}]}}"#
        );
        assert!(ResourcesManifest::parse(&ok).is_ok());
    }

    /// 即使坏版本号从本地 `resource-packs.json` 读进来（绕过 parse），
    /// `pack_dir` 也不能拼出可穿越的路径。
    #[test]
    fn pack_dir_never_escapes_resources() {
        let cfg = PathBuf::from("C:/cfg");
        let root = external_root(&cfg);
        for (id, ver) in [
            ("ecj", "x/../../../evil"),
            ("ecj", "../../evil"),
            ("..", "v1"),
            ("ecj", ".."),
            ("ecj", r"..\..\evil"),
        ] {
            let p = pack_dir(&cfg, id, ver);
            assert!(
                p.starts_with(&root),
                "id={id:?} version={ver:?} 拼出了 resources 之外的路径: {}",
                p.display()
            );
            assert!(
                !p.components()
                    .any(|c| matches!(c, std::path::Component::ParentDir)),
                "id={id:?} version={ver:?} 拼出了含 .. 的路径: {}",
                p.display()
            );
        }
        // 正常输入原样保留（不破坏现有目录命名）
        assert_eq!(
            pack_dir(&cfg, "ecj", "abc123def456"),
            root.join("ecj@abc123def456")
        );
    }

    #[test]
    fn platform_filter_matches_current_os() {
        let m = ResourcesManifest::parse(&sample_manifest_json()).unwrap();
        let ids: Vec<&str> = m
            .packs_for_current_platform()
            .iter()
            .map(|p| p.id.as_str())
            .collect();
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
        assert_eq!(
            active_dir(&dir, PACK_ECJ),
            Some(pack_dir(&dir, PACK_ECJ, "v1"))
        );

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
        assert!(
            check_url_scheme(&url::Url::parse("http://127.0.0.1:1234/a.json").unwrap()).is_ok()
        );
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
        assert!(
            err.contains("zip-slip") || err.contains("路径不合法"),
            "错误信息应点名原因: {err}"
        );
        // 恶意文件一个都不能落盘
        assert!(!dir.join("escape.txt").exists());
        assert!(
            !dest.join("good.txt").exists(),
            "整包拒绝，好的条目也不该部分落盘"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 解压炸弹（头部撒谎型）：内容 4 字节，中央目录里把未压缩大小改写成 600MB。
    /// 第一遍预检必须按**声明大小**整体拒绝，且一个字节都不落盘——
    /// zip-slip 防护管「写去哪」，这条管「写多少」。
    #[test]
    fn extract_rejects_declared_bomb_before_writing() {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = Default::default();
            w.start_file("bomb.txt", opts).unwrap();
            std::io::Write::write_all(&mut w, b"ok!!").unwrap();
            w.finish().unwrap();
        }
        // 中央目录文件头签名 PK\x01\x02，其未压缩大小字段在 +24（zip 2.6.1 的
        // entry.size() 读的就是中央目录这份，不是本地头）。
        let cd = buf
            .windows(4)
            .position(|w| w == [0x50, 0x4b, 0x01, 0x02])
            .expect("应有中央目录");
        let huge: u32 = 600 * 1024 * 1024;
        buf[cd + 24..cd + 28].copy_from_slice(&huge.to_le_bytes());

        let dir = temp_dir("bomb");
        let dest = dir.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let err = extract_zip(&buf, &dest).unwrap_err();
        assert!(err.contains("解压炸弹"), "错误信息应点名原因: {err}");
        assert!(!dest.join("bomb.txt").exists(), "预检拒绝时不该有任何落盘");
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
        std::fs::write(
            legacy_root.join(PACK_ECJ).join("ecj-3.17.jar"),
            b"legacy-jar-bytes",
        )
        .unwrap();
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
        assert!(
            kinds.contains(&"uptodate"),
            "认领完成应发 uptodate: {kinds:?}"
        );
        assert!(
            !kinds.contains(&"missing"),
            "有 legacy 可认领时不该报缺失: {kinds:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // ─── 下载硬上限（M8-2） ───

    #[test]
    fn download_cap_floors_at_64mb_and_adds_margin() {
        // 地板 64MB（当前最大包 jdtls 约 54MB，留增长余量）+ 12.5% 余量
        assert_eq!(download_cap(0), 72 << 20);
        assert_eq!(download_cap(10 << 20), 72 << 20); // 小于地板 ⇒ 按地板
        assert_eq!(download_cap(64 << 20), 72 << 20);
        // 超过地板按声明值 + 12.5%
        assert_eq!(download_cap(100 << 20), (100 << 20) + (100 << 20) / 8);
        assert_eq!(download_cap(800 << 20), 900 << 20);
    }

    // ─── 重试判定（M8-6：确定性错误不重试 / 408·429 要重试） ───

    #[test]
    fn manifest_err_retryable_separates_permanent_from_transient() {
        // 404/410：源上没有这份清单，确定性结论，不重试
        assert!(!manifest_err_retryable("资源清单返回 HTTP 404"));
        assert!(!manifest_err_retryable("资源清单返回 HTTP 410"));
        // 408 超时 / 429 限流：都该再试（以前被 contains("HTTP 4") 误杀）
        assert!(manifest_err_retryable("资源清单返回 HTTP 408"));
        assert!(manifest_err_retryable("资源清单返回 HTTP 429"));
        assert!(manifest_err_retryable("资源清单返回 HTTP 503"));
        // 网络类错误重试
        assert!(manifest_err_retryable("请求资源清单失败: connection reset"));
    }

    #[test]
    fn deterministic_download_errors_are_recognized() {
        // 同 URL 重下必然复现的两类：字节就是那些字节 / 源那头就是那么大
        assert!(is_deterministic_download_error(
            "SHA-256 校验失败（期望 aaa，实得 bbb）——包可能被篡改或下载损坏，已阻止安装"
        ));
        assert!(is_deterministic_download_error(
            "下载量超过上限（已收 999 字节，上限 72）——源可能声明了错误的大小"
        ));
        // 链路抖动相反：值得重试
        assert!(!is_deterministic_download_error(
            "下载流中断: connection reset"
        ));
        assert!(!is_deterministic_download_error("下载返回 HTTP 502"));
        assert!(!is_deterministic_download_error(
            "下载停滞超过 60 秒，已中断（可重试或换源）"
        ));
    }

    // ─── 离线短路（M8-5） ───

    #[test]
    fn locally_ready_requires_all_packs_on_disk() {
        let dir = temp_dir("ready");
        let config_dir = dir.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let legacy_root = dir.join("legacy");
        std::fs::create_dir_all(legacy_root.join(PACK_ECJ)).unwrap();
        std::fs::write(legacy_root.join(PACK_ECJ).join("ecj-3.17.jar"), b"x").unwrap();

        // 空状态：一个都不就绪
        let st = PacksState::default();
        assert!(!locally_ready(&config_dir, None, &st));

        // 只装 ecj：还不齐（jdtls / svnkit 缺）
        let mut st = PacksState::default();
        st.packs.insert(
            PACK_ECJ.to_string(),
            InstalledPack {
                version: "v1".into(),
                legacy: false,
                size: None,
            },
        );
        std::fs::create_dir_all(pack_dir(&config_dir, PACK_ECJ, "v1")).unwrap();
        assert!(!locally_ready(&config_dir, None, &st));

        // 三包齐（目录在即可——离线短路只确认资源找得到，探针在安装时已做过）
        for id in [PACK_JDTLS, PACK_SVNKIT] {
            st.packs.insert(
                id.to_string(),
                InstalledPack {
                    version: "v1".into(),
                    legacy: false,
                    size: None,
                },
            );
            std::fs::create_dir_all(pack_dir(&config_dir, id, "v1")).unwrap();
        }
        assert!(locally_ready(&config_dir, None, &st));

        // 目录被删 ⇒ 不再就绪
        std::fs::remove_dir_all(pack_dir(&config_dir, PACK_SVNKIT, "v1")).unwrap();
        assert!(!locally_ready(&config_dir, None, &st));

        // legacy 记录：看旧安装目录的关键文件在不在，与 finder 回退链一致。
        // locally_ready 是三包全齐判定，legacy 也要三个都在旧目录里。
        let mut st = PacksState::default();
        for id in [PACK_JDTLS, PACK_ECJ, PACK_SVNKIT] {
            let d = legacy_root.join(id);
            std::fs::create_dir_all(d.join("plugins")).unwrap();
            std::fs::create_dir_all(d.join("config_win")).unwrap();
            std::fs::write(d.join("ecj-3.17.jar"), b"x").unwrap();
            std::fs::write(d.join("svnkit.jar"), b"x").unwrap();
            st.packs.insert(
                id.to_string(),
                InstalledPack {
                    version: String::new(),
                    legacy: true,
                    size: None,
                },
            );
        }
        assert!(locally_ready(&config_dir, Some(&legacy_root), &st));
        assert!(
            !locally_ready(&config_dir, None, &st),
            "没有 legacy 目录可看时不能算就绪"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
