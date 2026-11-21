//! Phase 1 声明索引的持有、懒构建与跳转查询。
//!
//! 查询分两层：**成员级**（`fast_member`：`vo.getCode()` / `this.x` / 局部变量）
//! 先判，它说不归它管时才走**类型级**（`fast_definition`：`DeliveryVO` → 类声明）。
//! 顺序不能反 —— 反了会把 `getCode` 当成类名去全库搜。
//!
//! 与 `lang`（jdt.ls 会话）**没有生命周期关系**：jdt.ls 没起来（甚至没装）也能用，
//! 只有换工作区时才整体替换。索引落在 `{config_dir}/decl-index/<root 哈希>/types.idx`，
//! 由 `NcIndexer` 产出（`ecj-bridge/NcIndexer.java`，与编译桥同一个 `ncecj.jar`）。
//!
//! 三条刻意的取舍：
//! 1. **懒构建 + 不阻塞**：第一次查询时起后台线程建索引（源码侧 8~9 秒，含 jar 侧约 19 秒），
//!    本次直接返回空，前端退回内容搜索；建好后的下一次查询就是毫秒级。
//!    `lang_prepare` 打开工作区时就会先踢一次，所以正常情况下用户点下去时已经建好了。
//! 2. **jar 侧按需覆盖**：传 `--jars` 后 jar 里的类也能跳（目标用 `jdt://`，前端已有
//!    反编译标签页）。这多花约 10 秒，但省掉的是「跳到第三方接口时只能退回内容搜索」。
//! 3. **过期就重建，不猜**：复用判据是「同一份 jar 清单 **且** 源码没有比索引更新的东西」
//!    （`built_at_ms` 与工作区 mtime 比，见 `scan_sources`）。早先只比 jar 清单，
//!    结果是一份昨天的索引会**跳到昨天的行号** —— 错跳比跳不到更坏。
//!
//! 纯服务模块：不注册命令（命令层在 `commands::lang_fast_cmds`），不含前端类型。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::decl_index::{DeclIndex, IndexStats};
use crate::fast_definition;
use crate::fast_member;

/// 索引槽位，挂在 `AppState::fast_decl` 上。
#[derive(Default)]
pub struct Holder {
    loaded: Option<Arc<Loaded>>,
    /// 后台构建进行中。防同一时刻起两个 JVM。
    building: bool,
    last_error: Option<String>,
    last_build_ms: Option<u128>,
    /// 连续失败次数。用于指数退避：索引器 OOM / 桥缺失时，不能让**每次点击**都重起一个 20s 的 JVM。
    failures: u32,
    /// 退避到期时间；`None` 表示可以立刻再试。
    retry_at: Option<Instant>,
}

/// 已就绪的索引。
pub struct Loaded {
    pub index: DeclIndex,
    pub stats: IndexStats,
    /// 这份索引对应的工作区根。换工作区即作废。
    pub root: PathBuf,
    pub source: PathBuf,
}

/// 取当前工作区的索引；没有就**起一次后台构建并返回 `None`**（当次不阻塞）。
///
/// 两个调用点：`lang_prepare`（打开工作区先踢一脚，这样用户点下去时多半已建好）
/// 与 `lang_fast_definition`（兜底：没预热过的工作区，第一次点击触发构建）。
pub fn lookup_or_kick(
    app: &tauri::AppHandle,
    state: &Arc<crate::state::AppState>,
    root: &Path,
    nc_home: Option<String>,
) -> Option<Arc<Loaded>> {
    let mut h = state.fast_decl.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(l) = &h.loaded {
        if l.root == root {
            return Some(l.clone());
        }
        // 换了工作区：旧索引对不上新的 path 前缀，留着只会跳错文件
        h.loaded = None;
    }
    if h.building {
        return None;
    }
    // 失败退避：连续失败时别让每次 Ctrl+悬停都拉起一个 JVM。
    // 30s 起，翻倍，封顶 10 分钟 —— 装好 NC home / 重新打包桥之后最迟 10 分钟内自愈。
    if let Some(at) = h.retry_at {
        if Instant::now() < at {
            return None;
        }
    }
    h.building = true;
    drop(h);

    let app = app.clone();
    let state = state.clone();
    let root = root.to_path_buf();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let out = index_path(&state.config_dir, &root);
        let result = build(&app, &state.config_dir, &root, nc_home.as_deref(), &out)
            .and_then(|()| {
                // 轻量加载：只跳 jar 侧成员（145 万条字符串），源码侧成员照留 ——
                // 成员级跳转（`vo.getCode()`）要它们的声明行，见 `DeclIndex::load_meta`。
                DeclIndex::load_meta(&out).map_err(|e| {
                    // 头部合法但记录区坏了（断电 / 写盘中断 / 磁盘错误）：
                    // 留着它只会每次重试都失败（判据认为「不需重建」）。删掉索引与指纹，
                    // 下一次触发就走完整重建。
                    let _ = std::fs::remove_file(&out);
                    let _ = std::fs::remove_file(out.with_file_name("jars.done"));
                    format!("读索引 {}：{e}", out.display())
                })
            })
            .map(|(index, stats)| Loaded {
                index,
                stats,
                root: root.clone(),
                source: out,
            });
        let mut h = state.fast_decl.lock().unwrap_or_else(|e| e.into_inner());
        match result {
            Ok(l) => {
                h.loaded = Some(Arc::new(l));
                h.last_error = None;
                h.failures = 0;
                h.retry_at = None;
            }
            Err(e) => {
                h.failures = h.failures.saturating_add(1);
                let delay = Duration::from_secs(30u64 << h.failures.min(5)); // 60s,120s,…≤16min
                h.retry_at = Some(Instant::now() + delay.min(Duration::from_secs(600)));
                // 只记一次（每条失败记录一条，退避保证不会刷屏）
                log::warn!(
                    "声明索引构建失败（第 {} 次，{}s 后重试）：{e}",
                    h.failures,
                    delay.as_secs()
                );
                h.last_error = Some(e);
            }
        }
        h.last_build_ms = Some(started.elapsed().as_millis());
        h.building = false;
    });
    None
}

/// 索引文件路径：按工作区根哈希分目录，换工作区互不覆盖。
fn index_path(config_dir: &Path, root: &Path) -> PathBuf {
    let mut hs = DefaultHasher::new();
    root.to_string_lossy().to_lowercase().hash(&mut hs);
    config_dir
        .join("decl-index")
        .join(format!("{:016x}", hs.finish()))
        .join("types.idx")
}

/// 生成索引文件。
///
/// 复用判据是「**同一份 jar 清单**」。源码侧刻意不比对 mtime（stat 7000 个文件
/// 和重建差不多快），但 jar 清单必须比：装上二开组件后清单会变，沿用旧索引
/// 会让新组件里的类永远跳不到，而且没有任何提示。
fn build(
    app: &tauri::AppHandle,
    config_dir: &Path,
    root: &Path,
    nc_home: Option<&str>,
    out: &Path,
) -> Result<(), String> {
    let home = crate::nc_home::resolve(nc_home).map_err(|e| e.to_string())?;
    let jdtls = crate::commands::find_jdtls(app, config_dir)?;
    let plugins = jdtls.join("plugins");
    let bridge = jdtls
        .parent()
        .ok_or("jdtls 目录没有上级")?
        .join("ecj-bridge")
        .join("ncecj.jar");
    build_index(
        Path::new(&home.java),
        Path::new(&home.root),
        &bridge,
        &plugins,
        root,
        out,
    )
}

/// `build` 的可测内核：只认「java 在哪、索引器在哪、jar 清单从哪个 NC home 算」。
///
/// 抽出来是因为生产路径（4367 条清单 → 精选 → 写盘 → 记指纹）在 `AppHandle` 里跑不到，
/// 而它恰好是最容易错的一段（包名格式、清单指纹、Xmx、路径分隔符）。
/// 集成测试 `decl_index_live::生产口径能建出可用的索引` 直接调它跑真实全流程。
pub fn build_index(
    java: &Path,
    nc_root: &Path,
    bridge: &Path,
    plugins: &Path,
    root: &Path,
    out: &Path,
) -> Result<(), String> {
    if let Some(p) = out.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("建目录 {}：{e}", p.display()))?;
    }
    if !bridge.is_file() {
        return Err(format!(
            "缺索引器 {}，先跑 node scripts/build-bridge-jar.mjs ecj",
            bridge.display()
        ));
    }

    // jar 清单：直接用 NC home 的 Eclipse classpath 顺序（与编译/shadow 同一个函数），
    // 不去建 `ClassIndex`（那是 63s，比整个索引器还贵）。
    // 去重要保序（用 HashSet 而不是 BTreeSet）：同名类在多个 jar 里出现时，
    // 「谁先被索引」由 classpath 顺序决定，重排会让跳转目标漂移。
    let mut seen = std::collections::HashSet::new();
    let jars: Vec<PathBuf> = crate::nc_index::classpath_jars(nc_root)
        .into_iter()
        .filter(|p| seen.insert(p.to_string_lossy().to_lowercase()))
        .collect();
    let manifest = jars
        .iter()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>()
        .join("\n");
    let manifest_path = out.with_file_name("jars.done");
    if fresh(out, &manifest_path, &manifest, root) {
        return Ok(());
    }

    // 🔴 **不删旧索引**：先写到 `types.idx.tmp`，成功后再原子替换。
    //    早先是「先 remove 再建」—— 重建一失败（OOM / 桥被删）就把原本还能用的旧索引
    //    一起弄没了，用户从此连旧行号都跳不到。写临时文件还有个好处：构建期间
    //    另一个线程正在读的旧文件不会被截断。
    let tmp = out.with_file_name("types.idx.tmp");
    let _ = std::fs::remove_file(&tmp);

    let jars_path = out.with_file_name("jars.list");
    std::fs::write(&jars_path, &manifest)
        .map_err(|e| format!("写 jar 清单 {}：{e}", jars_path.display()))?;

    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);
    // Java 的 -cp 通配符：`dir/*` 表示目录下所有 jar。用正斜杠避免 Windows 反斜杠与通配符混淆。
    let cp = format!(
        "{};{}/*",
        bridge.to_string_lossy().replace('\\', "/"),
        plugins.to_string_lossy().replace('\\', "/")
    );
    let child = std::process::Command::new(java)
        .arg("-Dfile.encoding=UTF-8")
        .arg("-cp")
        .arg(&cp)
        // 20 万条类型记录在内存里攒齐后才落盘。生产口径（--no-jar-members）实际远低于此，
        // 3g 是构建期临时上限，进程退即还；留余量是因为全量成员模式要 124MB 级别。
        .arg("-Xmx3g")
        .arg("NcIndexer")
        .arg("--ws")
        .arg(root)
        .arg("--out")
        .arg(&tmp)
        .arg("--jars")
        .arg(&jars_path)
        // jar 侧成员（145 万条签名）不写：它们占文件体积 80%、也是 jar 阶段的主要 CPU，
        // 而行号恒 0（字节码行号对不上反编译视图）⇒ 成员级跳转用不上。
        // **源码侧成员照写**（带声明行），`vo.getCode()` 就靠它们。
        .arg("--no-jar-members")
        .arg("--threads")
        .arg(threads.to_string())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("起索引器失败（{}）：{e}", java.display()))?;
    if !child.status.success() {
        let _ = std::fs::remove_file(&tmp);
        let tail: String = String::from_utf8_lossy(&child.stderr)
            .lines()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(format!("索引器退出码 {:?}：{tail}", child.status.code()));
    }
    // 先替换索引，再写指纹。顺序反过来（先写标记）会出现「建索引失败但标记已落地」，
    // 下次启动会认定索引是最新的、永久不再重建。
    std::fs::rename(&tmp, out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换索引 {}：{e}", out.display())
    })?;
    std::fs::write(&manifest_path, &manifest)
        .map_err(|e| format!("写清单 {}：{e}", manifest_path.display()))?;
    Ok(())
}

/// 这份索引还能不能直接用：**jar 清单没变** 且 **源码没有比它更新的东西**。
///
/// 只看 jar 清单是不够的（第一版就是这么错的）：源码改一行，行号就漂了，而索引
/// 跨重启持久 ⇒ 第二天启动后的前 100 秒里，Ctrl+点击**全部落到旧行**。
/// 判据取「索引落盘时刻」与「工作区 mtime / 文件数」比，不需要额外存每个文件的指纹：
/// 编辑改文件 mtime，增删由 mtime 或数量兜底（Windows 上目录 mtime 惰性更新，见 `stale_reason`）。
fn fresh(out: &Path, manifest_path: &Path, manifest: &str, root: &Path) -> bool {
    if !out.is_file() {
        return false;
    }
    match std::fs::read_to_string(manifest_path) {
        Ok(s) if s == manifest => {}
        _ => return false,
    }
    let Ok(st) = DeclIndex::read_stats(out) else {
        return false;
    };
    // 0 = 旧格式（v1）或写坏：不知道什么时候建的，只能重建
    if st.built_at_ms == 0 {
        return false;
    }
    let scan = scan_sources(root, st.built_at_ms);
    match stale_reason(&scan, &st) {
        None => true,
        Some(why) => {
            log::info!("声明索引过期（{why}），后台重建");
            false
        }
    }
}

/// 过期判据与行号校正都在 `decl_drift`（「索引 vs 磁盘」的偏差处理），这里只做编排。
/// `pub use` 是因为集成测试与 `/status` 都按 `fast_decl::` 取这两样。
pub use crate::decl_drift::{
    fixed_line, fixed_member_line, scan_sources, stale_reason, SourceScan,
};

/// 索引状态快照，给设置页显示（`lang_fast_status`）。
///
/// 为什么要有它：索引构建失败**不会有任何用户可见症状** —— 只是跳转永远退回内容搜索。
/// 没有这一行，「装了新组件后跳不到」和「索引压根没建起来」在界面上长得一模一样。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `none` / `building` / `ready` / `failed`
    pub state: &'static str,
    pub types: usize,
    pub source_files: usize,
    pub jar_types: u64,
    pub built_at_ms: u64,
    /// `types.idx` 的字节数（0 = 没有）
    pub index_bytes: u64,
    /// 上次构建（含复用判定）耗时
    pub build_ms: Option<u64>,
    pub failures: u32,
    pub error: Option<String>,
}

/// 取当前工作区的索引状态。**只读**：不触发构建。
pub fn status(state: &Arc<crate::state::AppState>, root: &Path) -> Status {
    let h = state.fast_decl.lock().unwrap_or_else(|e| e.into_inner());
    let ready = h.loaded.as_ref().filter(|l| l.root == root);
    let stats = ready.map(|l| l.stats).unwrap_or_default();
    let index_bytes = ready
        .and_then(|l| std::fs::metadata(&l.source).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    let kind = if ready.is_some() {
        "ready"
    } else if h.building {
        "building"
    } else if h.last_error.is_some() {
        "failed"
    } else {
        "none"
    };
    Status {
        state: kind,
        types: stats.types,
        source_files: stats.source_files,
        jar_types: stats.jar_types,
        built_at_ms: stats.built_at_ms,
        index_bytes,
        build_ms: h.last_build_ms.map(|v| v as u64),
        failures: h.failures,
        error: h.last_error.clone(),
    }
}

/// 在索引里解析一次跳转，产出 LSP `Location[]`（与 `textDocument/definition` 同形状，
/// 前端现有转换逻辑可以直接吃）。
pub fn definition(
    loaded: &Loaded,
    file: &Path,
    line: u32,
    character: u32,
    workspace_root: &Path,
) -> Vec<Value> {
    let Ok(bytes) = std::fs::read(file) else {
        return Vec::new();
    };
    // 只用 lossy：NC 源码 87% 是 GBK，但**标识符全是 ASCII**，替换字符不影响取词。
    // 真要精确解码就得上 `encoding_reg`，那是给「显示/编辑」用的，这里不需要。
    let text = String::from_utf8_lossy(&bytes);
    let Some(offset) = offset_of(&text, line, character) else {
        return Vec::new();
    };
    let module = module_of(file, workspace_root);
    // 分层：成员级先判（`vo.getCode()` 里的 `getCode` 不该去查类型表），
    // 它明确说「不归我管」（裸的大写词）时才走类型级。
    let targets = match fast_member::resolve(&text, offset, &loaded.index, file, &module) {
        Some(v) => v,
        None => fast_definition::resolve(&text, offset, &loaded.index, &module, 5),
    };
    targets
        .into_iter()
        .map(|t| {
            let uri = if t.from_jar {
                jar_uri(&t.path, &t.name)
            } else {
                crate::lsp::path_to_uri(&t.path)
            };
            // 源码目标：用目标文件本身校正行号。
            // 索引的行号是「建索引那一刻」的，而会话内改动不做重扫（每查一次扫 3.7s 不划算），
            // 所以这里以磁盘为准 —— 跳到文件是对的、行错了一位，用户会以为工具在乱跳。
            //
            // 成员目标的 name 形如 `类型#成员`（见 `fast_member`）：类型级校正找的是
            // `class X`，套在成员行上永远找不到，得走成员自己的判据。
            let line = if t.from_jar {
                t.line
            } else if let Some((_, member)) = t.name.rsplit_once('#') {
                fixed_member_line(&t.path, member, t.line)
            } else {
                fixed_line(&t.path, &t.name, t.line)
            };
            json!({
                "uri": uri,
                "range": {
                    "start": { "line": line.saturating_sub(1), "character": t.character },
                    "end":   { "line": line.saturating_sub(1), "character": t.character },
                },
                // 非 LSP 字段：前端用来区分「源码」与「jar 内」，也方便排查
                "name": t.name,
                "fromJar": t.from_jar,
            })
        })
        .collect()
}

/// jar 内的类 → `jdt://contents/<jar 名>/<包内路径>.class`。
///
/// **复用 jdt.ls 的既有约定**而不是自造协议：`decompile::parse_jdt_uri` 只认这一种形状，
/// 前端 `openJdt` 也按它分流到反编译标签页。查询串（`?=<base64>`）jdt.ls 用来带
/// project/classpath 附件，我们不需要，`parse_jdt_uri` 本来就丢掉它。
///
/// 内部类保留 `$`：`p.Outer$Inner` → `p/Outer$Inner.class`，与 jar 里的条目名一致。
fn jar_uri(jar: &str, fqcn: &str) -> String {
    let name = Path::new(jar)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let entry = format!("{}.class", fqcn.replace('.', "/"));
    format!(
        "jdt://contents/{}/{}",
        encode_segment(&name),
        encode_segment(&entry)
    )
}

/// 只转义会破坏 URI 结构的字符。**不能整体百分号编码** —— 包路径里的 `/` 是分隔符，
/// 编成 `%2F` 后 `parse_jdt_uri` 解回来还是一整串，`split_once('/')` 就切不开 jar 名了。
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '%' => out.push_str("%25"),
            ' ' => out.push_str("%20"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            _ => out.push(c),
        }
    }
    out
}

/// 「行(1 基) + 字符列(0 基)」→ 全文字节偏移。
///
/// 按 `\n` 切而不是 `str::lines()`：后者会吞掉 `\r`，CRLF 文件里行首偏移会逐行漂 1 字节。
fn offset_of(text: &str, line: u32, character: u32) -> Option<usize> {
    if line == 0 {
        return None;
    }
    let mut start = 0usize;
    for (i, l) in text.split('\n').enumerate() {
        if i as u32 + 1 == line {
            let line_str = l;
            let byte_in_line = line_str
                .char_indices()
                .nth(character as usize)
                .map(|(b, _)| b)
                .unwrap_or(line_str.len());
            return Some((start + byte_in_line).min(text.len()));
        }
        start += l.len() + 1; // +1 是 '\n'
        if start > text.len() {
            return None;
        }
    }
    None
}

/// `<root>\<模块>\src\...` → 模块名。取不到就空串（排序时只是少了「同模块优先」）。
fn module_of(file: &Path, root: &Path) -> String {
    let Ok(rel) = file.strip_prefix(root) else {
        return String::new();
    };
    rel.components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 行列换算覆盖_crlf_与越界() {
        let text = "package a;\r\nclass A {\r\n  int x;\r\n}\r\n";
        // 第 2 行第 0 列 = "class A {"
        assert_eq!(
            offset_of(text, 2, 0).map(|o| &text[o..o + 5]),
            Some("class")
        );
        // 第 2 行第 6 列 = 'A'
        assert_eq!(offset_of(text, 2, 6).map(|o| &text[o..o + 1]), Some("A"));
        // 行号 0 与非存在行
        assert_eq!(offset_of(text, 0, 0), None);
        assert_eq!(offset_of(text, 99, 0), None);
    }

    #[test]
    fn 列超出该行长度时夹到行尾() {
        let text = "abc\ndef\n";
        let off = offset_of(text, 1, 99).expect("应夹到行尾");
        assert_eq!(off, 3, "第 1 行只有 3 个字符");
    }

    #[test]
    fn 模块名取工作区下第一段() {
        let root = Path::new("C:\\ws");
        assert_eq!(
            module_of(Path::new("C:\\ws\\ic\\src\\private\\a\\B.java"), root),
            "ic"
        );
        assert_eq!(module_of(Path::new("D:\\other\\a\\B.java"), root), "");
    }

    /// jar 目标的 URI 必须能被既有的反编译链路反向解析出同一个类。
    ///
    /// 这条钉的是「两边协议一致」：`decompile::parse_jdt_uri` + `pick_jar` +
    /// `run_cfr` 是全套现成实现，我们只是按它的约定拼字符串。
    #[test]
    fn jar_目标的_uri_能被反编译链路解析回来() {
        let uri = jar_uri(
            "D:/ncc/1909home/external/lib/pubuapbd_aassign.jar",
            "nc.itf.bd.aassign.IAAssignMaintainService",
        );
        assert_eq!(
            uri,
            "jdt://contents/pubuapbd_aassign.jar/nc/itf/bd/aassign/IAAssignMaintainService.class"
        );
        let c = crate::decompile::parse_jdt_uri(&uri).expect("既有解析器必须认这个形状");
        assert_eq!(c.jar_name, "pubuapbd_aassign.jar");
        assert_eq!(c.fqcn, "nc.itf.bd.aassign.IAAssignMaintainService");

        // 内部类保留 `$`，与 jar 条目名一致
        let inner = jar_uri("D:/ncc/lib/x.jar", "a.b.Outer$Inner");
        assert_eq!(inner, "jdt://contents/x.jar/a/b/Outer$Inner.class");
        assert_eq!(
            crate::decompile::parse_jdt_uri(&inner).unwrap().entry,
            "a/b/Outer$Inner.class"
        );

        // jar 名里的空格必须转义，否则 URI 不合法；解回来仍是原名
        let spaced = jar_uri("D:/ncc/lib/my lib.jar", "a.B");
        assert_eq!(spaced, "jdt://contents/my%20lib.jar/a/B.class");
        assert_eq!(
            crate::decompile::parse_jdt_uri(&spaced).unwrap().jar_name,
            "my lib.jar"
        );
        // 包路径的分隔符 `/` 不能被转义，否则解析器切不开 jar 名
        assert!(!spaced.contains("%2F"));
    }

    #[test]
    fn 索引路径按工作区隔离() {
        let a = index_path(Path::new("C:\\cfg"), Path::new("C:\\ws\\one"));
        let b = index_path(Path::new("C:\\cfg"), Path::new("C:\\ws\\two"));
        assert_ne!(a, b, "不同工作区不能共用一个 types.idx");
        assert!(a.ends_with("types.idx"));
        // 大小写不敏感：Windows 上 C:\WS 与 C:\ws 是同一个工作区
        let c = index_path(Path::new("C:\\cfg"), Path::new("C:\\WS\\ONE"));
        assert_eq!(a, c);
    }
}
