//! jar 内**源码注释**搜索命令：把 `src_notes` 的索引包成 IPC。
//!
//! 与 `jar_symbol_cmds` 同构（三态契约、进程内缓存、后台建），但简单一等：
//! 源码包枚举不需要 `ClassIndex` 冷扫——`modules/**/*_src.jar` 直接列目录就有。
//! 索引本身才是大头（二十多万个 `.java` 的注释），所以照样后台建。

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::nc_home;
use crate::src_notes::{self, SrcNoteIndex};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrcNoteHitOut {
    /// 源码包（`_src.jar`）的绝对路径。
    pub jar: String,
    /// 包内路径，如 `nc/pub/ba/update/BAPUpdateDB.java`。
    pub path: String,
    /// 注释起始行（1-based）。
    pub line: usize,
    /// 注释正文（去标记、多行拼一行）。
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrcNoteOut {
    pub items: Vec<SrcNoteHitOut>,
    /// 本次命中多少条注释（可能大于 `items.len()`，后者受 `limit` 截断）。
    ///
    /// 🔴 不是「索引里一共有多少条注释」——那个数有 30 万量级，拿它当命中数
    /// 会让只有 1 条命中也显示成「显示前 1」，用户以为结果被截断了。
    pub total: usize,
    /// 还有更多没列出来：`limit` 截断或扫描超预算，二者都算。
    pub truncated: bool,
    /// 索引还没建好（首次）。
    pub building: bool,
    /// 结果来自旧索引，源码包已变动、正在后台重建。
    pub stale: bool,
    /// 后台建索引失败（磁盘满、杀软占用索引文件等）。有它就不能再说「在建」。
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

/// 进程内已载入的那份：索引路径 + 索引 + 建它时的源码包清单。
///
/// 清单一起记住是为了 `stale` 判定不必每次搜索都重列 `modules` 目录。
type LoadedSlot = Option<(PathBuf, Arc<SrcNoteIndex>, Vec<PathBuf>)>;

static LOADED: OnceLock<Mutex<LoadedSlot>> = OnceLock::new();
static BUILDING: AtomicBool = AtomicBool::new(false);

fn loaded_slot() -> &'static Mutex<LoadedSlot> {
    LOADED.get_or_init(|| Mutex::new(None))
}

fn cached(path: &Path) -> Option<(Arc<SrcNoteIndex>, Vec<PathBuf>)> {
    let guard = loaded_slot().lock().ok()?;
    guard
        .as_ref()
        .filter(|(held, _, _)| held == path)
        .map(|(_, index, jars)| (index.clone(), jars.clone()))
}

fn remember(path: PathBuf, index: Arc<SrcNoteIndex>, jars: Vec<PathBuf>) {
    if let Ok(mut guard) = loaded_slot().lock() {
        *guard = Some((path.clone(), index, jars));
    }
    // 🔴 必须一起作废 stale 节流缓存：重建刚落盘的那份与旧指纹对得上，但 TTL 内
    // 复用的还是重建前那句「已过期」——用户会一直看到「索引已过期」的提示。
    if let Some(slot) = STALE_CACHE.get() {
        let mut guard = match slot.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if guard.as_ref().is_some_and(|(held, _, _)| *held == path) {
            *guard = None;
        }
    }
}

/// NC home 与索引缓存目录。home 解析失败时整个功能不可用（没有源码包可搜）。
async fn resolve_paths(state: &Arc<AppState>) -> Result<(PathBuf, PathBuf), String> {
    let home_cfg = state.config.read().await.nc_home.clone();
    let home = nc_home::resolve(home_cfg.as_deref())?;
    let root = PathBuf::from(home.root);
    let cache = src_notes::cache_dir_for(&state.config_dir, &root.to_string_lossy());
    Ok((root, cache))
}

/// 后台建索引的在飞标记。RAII：panic 也要释放。
///
/// 否则一旦 build 里 panic（`extract_notes` 的越界就读走到过这条），标志永久卡在
/// true，之后每次 `spawn_build` 第一行就返回，功能永远停在「索引正在后台建立」，
/// 用户只能重启应用。
struct BuildingGuard;
impl Drop for BuildingGuard {
    fn drop(&mut self) {
        BUILDING.store(false, Ordering::SeqCst);
    }
}

/// 源码包清单的进程内缓存。
///
/// `source_jars` 要遍历整个 `modules` 树（实测 2775 个包 ≈ 1.9s），而点开一条命中
/// 真正要做的只是 zip 直读（毫秒级）——不能每次点开都付枚举的代价。
///
/// 按 home 记住最近一份，换 home 才重枚举。组件装卸造成的清单变化由搜索路径的
/// `stale()`（比包数 + size/mtime）发现并触发重建，重建时会重新枚举刷新这里。
static SRC_JARS: OnceLock<Mutex<Option<JarList>>> = OnceLock::new();

/// 记住的源码包清单：哪个 home 枚举出来的、清单本身。
type JarList = (PathBuf, Vec<PathBuf>);

fn source_jars_cached(home: &Path) -> Vec<PathBuf> {
    let slot = SRC_JARS.get_or_init(|| Mutex::new(None));
    let mut guard = match slot.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some((held, jars)) = guard.as_ref() {
        if held == home {
            return jars.clone();
        }
    }
    let jars = crate::java_comments::source_jars(home);
    *guard = Some((home.to_path_buf(), jars.clone()));
    jars
}

/// `stale()` 的节流版：按索引路径记住上次结论，TTL 内直接复用。
///
/// `stale()` 要对全部源码包逐个 stat（实测 2775 个 ≈ 112ms），而搜索本身只要 1.3ms
/// ——连续搜索时 99% 的时间都花在判过期上，且这 112ms 还是在 async 线程上同步阻塞的。
/// jar 被替换（打补丁）最晚 TTL 后的那次搜索必然发现，语义不丢。
const STALE_TTL: Duration = Duration::from_secs(2);
static STALE_CACHE: OnceLock<Mutex<Option<(PathBuf, Instant, bool)>>> = OnceLock::new();

fn stale_throttled(index: &SrcNoteIndex, jars: &[PathBuf], out: &Path) -> bool {
    let slot = STALE_CACHE.get_or_init(|| Mutex::new(None));
    let now = Instant::now();
    {
        let guard = match slot.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some((held, at, verdict)) = guard.as_ref() {
            if held == out && now.duration_since(*at) < STALE_TTL {
                return *verdict;
            }
        }
    }
    // stat 不持锁：两个搜索同时过期时各判一次，比互相阻塞好
    let verdict = index.stale(jars);
    if let Ok(mut guard) = slot.lock() {
        *guard = Some((out.to_path_buf(), now, verdict));
    }
    verdict
}

/// 后台建一次。建完直接载入进程内缓存。
fn spawn_build(home: PathBuf, out: PathBuf) {
    if BUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 闭包第一行：任何提前返回 / panic 都会经过 Drop，标志不会卡死
        let _guard = BuildingGuard;
        let _budget = crate::prewarm_budget::acquire();
        let started = Instant::now();
        let jars = source_jars_cached(&home);
        match src_notes::build(&jars, &out, &|_, _| {}, &|| false) {
            Ok(()) => {
                set_last_build_error(None);
                if let Some(fresh) = SrcNoteIndex::load(&out) {
                    remember(out.clone(), Arc::new(fresh), jars.clone());
                }
                log::info!(
                    "源码注释索引后台建成，{} ms（{} 个源码包）",
                    started.elapsed().as_millis(),
                    jars.len()
                );
            }
            Err(e) => {
                // 建失败不能静默：界面要靠它说「建失败 + 怎么办」，
                // 否则用户永远看着「正在后台建立」
                set_last_build_error(Some(e.clone()));
                log::error!("源码注释索引后台建成失败：{e}");
            }
        }
    });
}

/// 最近一次后台建索引的失败原因。`None` = 没失败过（或后来建成了）。
static LAST_BUILD_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn last_build_error() -> Option<String> {
    LAST_BUILD_ERROR
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|g| g.clone())
}

fn set_last_build_error(e: Option<String>) {
    let slot = LAST_BUILD_ERROR.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = e;
    }
}

/// 打开工作区后预热：第一次搜 jar 内注释不该让用户等一分钟。
pub fn spawn_prewarm_src_notes(state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let Ok((home, cache)) = resolve_paths(&state).await else {
            return;
        };
        let out = cache.join("notes.bin");
        // 枚举源码包（~1.9s）、读索引文件、stat 全部包都是阻塞 IO：离开 async 线程
        let _ = tauri::async_runtime::spawn_blocking(move || prewarm_blocking(home, out)).await;
    });
}

fn prewarm_blocking(home: PathBuf, out: PathBuf) {
    let jars = source_jars_cached(&home);
    // 磁盘上已有一份且与当前源码包对得上：只载入，不重建
    if let Some(existing) = SrcNoteIndex::load(&out) {
        if !existing.stale(&jars) {
            remember(out.clone(), Arc::new(existing), jars);
            return;
        }
    }
    spawn_build(home, out);
}

/// 「没有可用索引」时的返回：建失败过就说失败，否则说还在建。
fn building_or_error(started: Instant) -> SrcNoteOut {
    match last_build_error() {
        Some(e) => SrcNoteOut {
            items: Vec::new(),
            total: 0,
            truncated: false,
            building: false,
            stale: false,
            error: Some(e),
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        None => SrcNoteOut {
            items: Vec::new(),
            total: 0,
            truncated: false,
            building: true,
            stale: false,
            error: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
    }
}

/// 同步部分：取索引 / 判过期 / 扫注释。
///
/// 🔴 必须整个搬出 async 线程：读索引文件是几十 MB 顺序读，判过期要 stat 几千个
/// 源码包，扫描本身有 500ms 预算——任一项都能把 tokio worker 占住，让别的命令
/// （包括 UI 上的其他 IPC）一起卡。
fn search_blocking(home: PathBuf, out: PathBuf, q: String, limit: usize) -> SrcNoteOut {
    let started = Instant::now();
    // 取索引：进程内 → 磁盘（上次会话建的）→ 后台建并回 building
    let (index, jars) = match cached(&out) {
        Some(pair) => pair,
        None => match SrcNoteIndex::load(&out) {
            Some(fresh) => {
                let jars = source_jars_cached(&home);
                let fresh = Arc::new(fresh);
                remember(out.clone(), fresh.clone(), jars.clone());
                (fresh, jars)
            }
            None => {
                spawn_build(home, out);
                return building_or_error(started);
            }
        },
    };

    let stale = stale_throttled(&index, &jars, &out);
    if stale {
        spawn_build(home, out);
    }
    let (hits, total, truncated) = index.search(&q, limit);
    SrcNoteOut {
        items: hits
            .into_iter()
            .map(|h| SrcNoteHitOut {
                jar: h.jar,
                path: h.path,
                line: h.line,
                text: h.text,
            })
            .collect(),
        total,
        truncated,
        building: false,
        stale,
        error: None,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

#[tauri::command]
pub async fn search_src_notes(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    limit: Option<usize>,
) -> Result<SrcNoteOut, String> {
    let q = query.trim().to_string();
    let limit = limit.unwrap_or(40).clamp(1, 100);
    if q.is_empty() {
        return Ok(SrcNoteOut {
            items: Vec::new(),
            total: 0,
            truncated: false,
            building: false,
            stale: false,
            error: None,
            elapsed_ms: 0,
        });
    }
    let (home, cache) = resolve_paths(&state).await?;
    let out = cache.join("notes.bin");
    tauri::async_runtime::spawn_blocking(move || search_blocking(home, out, q, limit))
        .await
        .map_err(|e| format!("搜索任务异常：{e}"))
}

/// 直接读 `_src.jar` 里的 `.java` 原文。
///
/// 为什么不能复用反编译那条路：`_src.jar` 被 `is_runtime_archive` 有意排除在
/// classpath 外（源码不是字节码），jdt.ls 与 CFR 的 jar 候选里都没有它；而包内
/// 全部 STORED（实测压缩比 1.000），读出来就是原始字节——比反编译更真也更快
/// （不起 JVM）。所以点开 jar 内注释走这条直路，jdt.ls / CFR 只是兜底。
fn read_src_text(nc_home: &Path, uri: &str) -> Result<String, String> {
    let class = crate::decompile::parse_jdt_uri(uri)
        .ok_or_else(|| "这个地址不是 jar 内的类，无法读取源码".to_string())?;
    if !class.jar_name.to_lowercase().ends_with("_src.jar") {
        return Err(format!("{} 不是源码包（_src.jar）", class.jar_name));
    }
    // `nc/foo/Bar.class` → `nc/foo/Bar.java`；只剥尾部，目录名不会误伤
    let entry = format!("{}.java", class.entry.trim_end_matches(".class"));
    // 🔴 走缓存：枚举一遍 2775 个源码包要 ~1.9s，点开命中不能每次都付
    let jars = source_jars_cached(nc_home);
    let jar = crate::decompile::pick_jar(&class.jar_name, &jars).ok_or_else(|| {
        format!(
            "在 NC 安装目录里没找到源码包 {}，它可能来自已卸载的组件",
            class.jar_name
        )
    })?;
    let file = File::open(&jar).map_err(|e| format!("打不开 {}：{e}", jar.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("{} 不是有效的 jar：{e}", jar.display()))?;
    let mut member = archive
        .by_name(&entry)
        .map_err(|_| format!("{} 里没有 {}", jar.display(), entry))?;
    let mut buf = Vec::new();
    member
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取 {entry} 失败：{e}"))?;
    // 与建索引进同一个解码器：GBK 源码解出来和索引里存的一致
    Ok(crate::workspace::decode_lossy(&buf))
}

/// 读源码包里的 `.java` 原文（带注释）。前端点开「jar 内注释」命中时先走这里。
#[tauri::command]
pub async fn read_src_file(
    state: tauri::State<'_, Arc<AppState>>,
    uri: String,
) -> Result<String, String> {
    let home_cfg = state.config.read().await.nc_home.clone();
    let home = nc_home::resolve(home_cfg.as_deref())?;
    // 读盘是阻塞 I/O：离开 async 线程
    tauri::async_runtime::spawn_blocking(move || read_src_text(Path::new(&home.root), &uri))
        .await
        .map_err(|e| format!("读取任务异常：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn 读源码包原文_按文件名忽略大小写_注释原样带回() {
        let tmp = crate::test_support::tmp("srcnote-read");
        // 真 src jar 的样子：STORED，条目是 .java（压缩比实测 1.000）
        let jar = tmp.join("modules/pub/pubgl_src.jar");
        std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
        let mut z = zip::ZipWriter::new(File::create(&jar).unwrap());
        z.start_file(
            "nc/bs/gl/GlBO.java",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        z.write_all(
            "package nc.bs.gl;\n// 61升级63，节点编码从8001变为8004\npublic class GlBO {}\n"
                .as_bytes(),
        )
        .unwrap();
        z.finish().unwrap();

        // URI 里 jar 名大小写与磁盘不同：pick_jar 按文件名忽略大小写
        let text = read_src_text(&tmp, "jdt://contents/PubGL_src.jar/nc/bs/gl/GlBO.class").unwrap();
        assert!(text.contains("61升级63，节点编码从8001变为8004"));
        assert!(text.contains("public class GlBO {}"));
    }

    #[test]
    fn 非源码包与缺失条目都明确报错() {
        let tmp = crate::test_support::tmp("srcnote-read-neg");
        let err = read_src_text(&tmp, "jdt://contents/pubgl.jar/nc/bs/gl/GlBO.class").unwrap_err();
        assert!(err.contains("不是源码包"), "{err}");
        let err = read_src_text(&tmp, "jdt://contents/nope_src.jar/nc/X.class").unwrap_err();
        assert!(err.contains("没找到源码包"), "{err}");
    }

    #[test]
    fn 缓存目录按_nc_home_分开() {
        let cfg = Path::new("C:/cfg");
        let a = src_notes::cache_dir_for(cfg, "D:/NC65/nc65home");
        let b = src_notes::cache_dir_for(cfg, "D:/NC65/nc65home");
        let c = src_notes::cache_dir_for(cfg, "D:/NC65/1909home");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with(cfg));
        assert!(!a.ends_with("notes.bin"));
    }

    #[test]
    fn 源码包清单按_home_缓存_换_home_才重枚举() {
        // 点开命中不能每次付 ~1.9s 的枚举代价；但换 NC home 必须重新枚举，
        // 否则会拿旧 home 的清单去 pick_jar。
        let a = crate::test_support::tmp("srcnote-jars-a");
        let b = crate::test_support::tmp("srcnote-jars-b");
        for (root, name) in [(&a, "aa-1_src.jar"), (&b, "bb-1_src.jar")] {
            let lib = root.join("modules/m/lib");
            std::fs::create_dir_all(&lib).unwrap();
            std::fs::write(lib.join(name), b"x").unwrap();
        }
        let first = source_jars_cached(&a);
        assert_eq!(first.len(), 1, "{first:?}");
        // 同一 home 再取：命中进程内缓存（内容一致）
        assert_eq!(source_jars_cached(&a), first);
        // 换 home：重新枚举，拿到的是新 home 的包
        let second = source_jars_cached(&b);
        assert_eq!(second.len(), 1);
        assert_ne!(second, first);
        assert!(second[0].ends_with("bb-1_src.jar"), "{second:?}");
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn stale_节流按索引路径分开_同路径复用结论() {
        // 2775 个包逐个 stat ≈ 112ms，而搜索本身 1.3ms：节流就是为此。
        // 这里只验证「按索引路径记住结论、不串味」——TTL 内的复用由常量保证。
        let (out, jar) = {
            let root = crate::test_support::tmp("srcnote-throttle");
            let jar = root.join("a_src.jar");
            std::fs::write(&jar, b"x").unwrap();
            let mut sink = src_notes::Sink::new();
            sink.feed(0, "A.java", "// 凭证\nclass A {}".as_bytes());
            let out = root.join("notes.bin");
            std::fs::write(&out, sink.finish(std::slice::from_ref(&jar)).unwrap()).unwrap();
            (out, jar)
        };
        let idx = src_notes::SrcNoteIndex::load(&out).expect("载入");
        assert!(!stale_throttled(&idx, std::slice::from_ref(&jar), &out));
        // 另一个索引路径：不受上一条的节流影响，重新真判（空清单与 1 个包不符）
        let other = out.with_extension("other");
        assert!(stale_throttled(&idx, &[], &other));
        // 回到原路径：TTL 内复用「不过期」的结论
        assert!(!stale_throttled(&idx, std::slice::from_ref(&jar), &out));
        let _ = std::fs::remove_dir_all(out.parent().unwrap());
    }
}
