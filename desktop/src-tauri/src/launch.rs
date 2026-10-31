//! 把 NC home + 工程目录拼成一条能直接交给 java 的启动命令。
//!
//! 三件事：算 classpath、写 pathing jar、拼 VM 参数。
//!
//! **为什么要 pathing jar**：NC 的中间件 classpath 有 4400+ 个 jar（`modules/*/lib` 就 2590 个），
//! 拼成字符串约 300KB，远超 Windows 命令行 32767 字符上限，`-cp "a;b;c..."` 这条路走不通。
//! 于是把所有条目写进一个只有 `META-INF/MANIFEST.MF` 的空 jar 的 `Class-Path` 里，
//! 命令行只传 `-cp <pathing.jar>`。这也是 Eclipse 与 Maven 的惯用解法。
//!
//! **顺序**：工程里的模块 `classes` 必须排最前。M0 验证过 Eclipse 开发态就是这么做，
//! 改完源码不用出补丁、重启就能生效；排到 NC home 后面对应模块的 jar 之后，改的类就会被 jar 里的旧版本盖掉。
//!
//! 纯逻辑模块，不含 tauri 类型（原因见 workspace.rs 头注释）。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::nc_index::{module_layers, LayerKind};
use crate::server::ServerSpec;

/// 中间件主类（开发态直启，不走 `bin/startup.bat` 的 NCStarter）。
pub const MIDDLEWARE_MAIN_CLASS: &str = "ufmiddle.start.tomcat.StartDirectServer";

// 客户端（`nc.starter.test.JStarter`）的启动要素暂时不在这里拼。
// 原先有一份 `default_client_vm_args(server, port)`：没人调用，而它的文档与示例都写着
// 「连本机 80 端口」——等以后真接客户端启动时，照抄就是「中间件改到 8081、客户端连 80」。
// 要接的时候从 `nc_home::read_endpoints` 取端口（`-Dnc.jstart.port`），别写字面量。

/// classpath 条目的两种身份：收目录下的 jar，或把目录本身当类/资源根。
#[derive(Clone, Copy)]
enum CpKind {
    /// 收这个目录下的一层 jar（官方 `lib` 段）
    Jars,
    /// 这个目录自己就是类/资源根（官方 `classes` / `resources` 段）
    Dir,
}

/// NC home 下参与 classpath 的条目，**顺序即官方 bootstrap 的段序**（不可随意重排）。
///
/// 对应 `BootstrapClassLoader:32` 的 8 段：middleware(1) → ant/lib(2) → framework(3)
/// → external(4) → NCHOME 根(5) → ejb(6) → modules(7) → langlib(8)。展开成我们收的目录之后：
///
/// | 本表条目 | 官方位置 | 为什么在这个位置 |
/// |---|---|---|
/// | `middleware` | 段 1 | `StartDirectServer` 与 Tomcat 本体，必须最先被找到 |
/// | `framework` | 段 3 | 框架 jar，早于 external 与 `lib/` |
/// | `external/classes` | 段 4 的 classes 层 | 二开类覆盖目录，**早于 NCHOME 根、早于所有 modules** |
/// | `external/lib` | 段 4 的 lib 层 | 589 个二开 jar |
/// | `resources` | 段 5 第 ⑬ 层 | 能压过 `lib/*.jar` 里的同名类（热修复），但压不过 `middleware` |
/// | `lib` | 段 5 第 ⑮ 层 | 因此必须排在 `resources` **之后**，否则上一条的覆盖失效 |
///
/// 曾经的顺序是 `["middleware","lib","framework","external/lib"]`（只有 jar、没有类目录）：
/// `lib` 抢在 `framework` 与 `external` 前面，`external/classes`（33 个二开类）与
/// `resources/`（20 个 framework 热修复类）根本不在 classpath 里。
/// 实证与边界见 `docs/NCForge-NC启动与类加载机制-实证-20261031.md` §5 E4/E5。
const HOME_CP: [(&str, CpKind); 6] = [
    ("middleware", CpKind::Jars),
    ("framework", CpKind::Jars),
    ("external/classes", CpKind::Dir),
    ("external/lib", CpKind::Jars),
    ("resources", CpKind::Dir),
    ("lib", CpKind::Jars),
];

/// `hotwebs/` 下的子目录就是可挂载的 webapp。
const HOTWEBS_DIR: &str = "hotwebs";

/// 扫不到 `hotwebs/` 时用的名单（等于改动前写死的那 5 个）。
///
/// **不能传空串**：`develop` 模式下 `uap.hotwebs` 是白名单，空串会被解析成空集合
/// ⇒ 所有 hotwebs 全部跳过，服务「启动成功」但一个前端页面都打不开。
const FALLBACK_HOTWEBS: [&str; 5] = ["nccloud", "uapws", "lfw", "portal", "fs"];

/// manifest 单行字节上限（JAR 规范）。中文路径一个字 3 字节，很容易超，所以必须按字节切。
const MANIFEST_LINE_LIMIT: usize = 72;

/// 中间件堆上限默认值（MB）。
///
/// 为什么不是 Eclipse 那套 `-Xmx1024m`：开发态要同时装 245 个模块、7230 条 classpath，
/// 1G 堆跑单据转换会频繁 Full GC，极端情况直接 OOM，表现是「服务起来了但一点就转圈」。
/// 为什么也不照抄 `ierp/bin/prop.xml` 的 `<jvmArgs>`：真实值是 `-Xmx81920m`（80G 生产服
/// 的值），抄到 16G 的笔记本上 JVM 起不来（要么拒绝启动，要么把机器换页换死）。
/// 4G 是「够开发、又不会把同事机器吃光」的折中，用户可以在服务页自己改。
pub const DEFAULT_HEAP_MB: u32 = 4096;

/// 堆上限的可接受范围。下限 512M 以下连模块都加载不完（还没到业务代码就 OOM），
/// 上限 64G 只是防手滑多打几个零，不是真建议值。
pub const HEAP_MIN_MB: u32 = 512;
pub const HEAP_MAX_MB: u32 = 65536;

/// 把配置里的堆上限折成真正会写进命令行的值。
///
/// 配置可能被手工编辑过（写 0、写 1000000），这里统一收口：`None` → 默认 4G，
/// 越界 → 夹到边界。**不在读取时改配置**（用户能看到自己填的数被调整），
/// 只在拼启动参数时收口，并把生效值一并回给界面显示。
pub fn effective_heap_mb(configured: Option<u32>) -> u32 {
    configured.map_or(DEFAULT_HEAP_MB, |mb| mb.clamp(HEAP_MIN_MB, HEAP_MAX_MB))
}

/// 命令层守卫：校验界面传来的堆上限。越界返回**可读错误**，不夹边。
///
/// 和 `effective_heap_mb` 的分工：那个夹边是给「手改坏了 config.json」兜底的
/// （服务还是要能起来）；这个报错是给「用户在界面上填了 70000」的——
/// 静默夹到 65536 会让界面显示的值和用户输入对不上，比报错难查得多。
/// `None` 合法：等于「恢复默认」。
pub fn validate_heap_mb(mb: Option<u32>) -> Result<(), String> {
    if let Some(mb) = mb {
        if !(HEAP_MIN_MB..=HEAP_MAX_MB).contains(&mb) {
            return Err(format!(
                "堆上限要在 {HEAP_MIN_MB}~{HEAP_MAX_MB} MB 之间（现在填的是 {mb}）。4G = 4096，一般开发够用"
            ));
        }
    }
    Ok(())
}

/// 该挂载哪些 hotwebs：`hotwebs/` 下**每个子目录都算**，按名字排序。
///
/// 为什么不是写死名单：`develop` 模式下 `uap.hotwebs` 是**白名单**，没列进去的 webapp
/// 会被 `log.warn("ignore hotwebs webapp " + name)` 静默跳过——服务照样显示启动成功，
/// 只是那个前端 404。原先写死 `nccloud,uapws,lfw,portal,fs`，本机 18 个目录里有 13 个
/// 被静默丢弃，其中 `iwebap` 是 NCC 主前端、`eyeapp` 是业务前端（实证 §4.3）。
///
/// 不按 `WEB-INF` 过滤：`eyeapp`（纯静态）、`bqchart`、`help` 都没有 `WEB-INF`，
/// 但 Tomcat 对没有 `WEB-INF` 的目录照样按静态 webapp 部署——按 `WEB-INF` 筛会正好把
/// 业务前端筛掉，等于换个方式复现同一个 bug。
///
/// 目录不存在或为空时回落 `FALLBACK_HOTWEBS`：宁可少挂也不要挂空，空集合等于全不挂。
pub fn hotwebs_names(home: &Path) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(home.join(HOTWEBS_DIR)) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    if names.is_empty() {
        return FALLBACK_HOTWEBS.iter().map(|s| s.to_string()).collect();
    }
    names
}

/// 中间件 VM 参数（`heap_mb` 为堆上限，调用方传 `effective_heap_mb(配置值)`）。
///
/// 只有一个入口、一个必填的 `heap_mb`：留一个「默认值版本」的重载，迟早会有人
/// 在启动路径上调它，于是「预览显示 8G、真起的是 4G」。
///
/// `-Dnc.server.location` / `-DEJBConfigDir` / `-DExtServiceConfigDir` 三个必须是
/// 绝对路径，且工作目录也得是 NC home——中间件会用相对路径去开 `ejbXMLs` 与日志。
pub fn middleware_vm_args(home: &Path, heap_mb: u32) -> Vec<String> {
    let h = home.to_string_lossy();
    // 服务名必须与 prop.xml 一致：我们跳过 `Main` 直接起 `StartDirectServer`，
    // 没人替我们补 `-Dnc.server.name`（实证 §5 E3），缺了就退回默认 `server`。
    let server_name = crate::nc_home::read_server_name(home)
        .unwrap_or_else(|| crate::nc_home::DEFAULT_SERVER_NAME.to_string());
    vec![
        "-Dnc.runMode=develop".into(),
        format!("-Dnc.server.location={h}"),
        format!("-Dnc.server.name={server_name}"),
        format!("-DEJBConfigDir={h}\\ejbXMLs"),
        format!("-DExtServiceConfigDir={h}\\ejbXMLs"),
        // 堆上限：默认 4G，可在服务页改（理由见 DEFAULT_HEAP_MB）
        format!("-Xmx{heap_mb}m"),
        // 元空间跟着堆走：4G 堆配 768M 元空间，245 个模块的类头足够；
        // 堆调得很大时元空间不用跟着涨，那部分不归堆管。
        "-XX:MetaspaceSize=512m".into(),
        "-XX:MaxMetaspaceSize=768m".into(),
        // 栈 2m：NC 的递归调用（尤其在单据转换里）用默认 512k 会 StackOverflow
        "-Xss2m".into(),
        // 白名单语义，必须覆盖 hotwebs/ 下全部子目录（理由见 hotwebs_names）
        format!("-Duap.hotwebs={}", hotwebs_names(home).join(",")),
        "-Djava.net.preferIPv4Stack=true".into(),
        "-DforceUseRedis=true".into(),
        // 别让 JVM 去读机器上别的 java 配置，行为才可复现
        "-Dfile.encoding=GBK".into(),
    ]
}

/// 拼中间件的 classpath（顺序即加载优先级）。
///
/// `project_classes` 是工程里各模块的源码输出目录（如 `newar\modules\gl\classes`），
/// 会被放在最前面。
pub fn middleware_classpath(home: &Path, project_classes: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // 1. 工程自己的 classes：改完立刻生效
    out.extend(project_classes.iter().filter(|p| p.is_dir()).cloned());

    // 2. NC home 的公共条目，段序见 HOME_CP
    for (rel, kind) in HOME_CP {
        let dir = home.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        match kind {
            CpKind::Jars => collect_archives(&dir, &mut out),
            // 类目录只在自己存在时入列：缺目录说明这套安装没用到该覆盖通道，
            // 塞一个不存在的路径只会让 classpath 变脏（JVM 会静默忽略，但清单会骗人）
            CpKind::Dir => {
                if dir.is_dir() {
                    out.push(dir);
                }
            }
        }
    }

    // 3. 各业务模块的 lib（模块名排序，保证两次启动顺序一致）
    let modules = home.join("modules");
    let mut names: Vec<String> = match std::fs::read_dir(&modules) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort_by_key(|n| n.to_uppercase());
    for name in names {
        for (rel, kind) in module_layers() {
            if kind != LayerKind::Jars {
                continue;
            }
            let dir = modules
                .join(&name)
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            collect_archives(&dir, &mut out);
        }
    }

    out
}

/// 工程与 NC home 里所有「已编译的类目录」，按 classpath 优先级排列。
///
/// 规则在 `crate::eclipse_cp`：读工程 `.classpath`，主工程 outputs → 声明的依赖闭包
/// （`exported="true"` 才传递）→ NC home 兜底；没有 `.classpath` 的老工程回落到
/// 「模块 classes → out/* → bin → 兄弟目录」这套启发式。
///
/// 这里曾经自己扫目录（只认 `<模块>/classes` 与 `out/<模块>`、兄弟无条件全收、字典序），
/// 实测出三个后果：`pm/bin` 的 339 个 class 从没进过类路径、未声明的兄弟工程
/// 按目录名字母序插队、`newar` 的 18 个同名类压过 `pm`。细节见
/// `docs/NCForge-多工程关联与启动链路-方案设计-20261031.md` §2–§3。
///
/// **编译、启动、语言服务必须共用这一份规则**：三处对不上就会出「编译通过了、重启
/// 后改的类不生效」——旧 class 从 jar 或另一个工程目录里加载了，靠日志几乎查不出来。
pub fn project_class_dirs(
    project_root: &Path,
    nc_home: &Path,
    overrides: &[crate::eclipse_cp::LinkedOverride],
) -> Vec<PathBuf> {
    crate::eclipse_cp::class_roots_with(project_root, nc_home, overrides)
}

/// 拼出中间件的完整启动要素（写好 pathing jar，返回可直接起进程的 `ServerSpec`）。
///
/// `work_dir` 只用来放 pathing jar：**不要写进 NC home**。安装目录是同事共用的，
/// 往里塞 `*.jar` 既可能被 `middleware/*.jar` 的扫描收进去，也可能被当成脏文件清掉。
///
/// `heap_mb` 是堆上限（调用方传 `effective_heap_mb(配置值)`），不传默认值——
/// 参数留在调用点，启动与「命令行预览」两条路径才不会各拼一套参数。
pub fn middleware_spec(
    nc_home: &Path,
    java: &Path,
    project_root: &Path,
    work_dir: &Path,
    heap_mb: u32,
    overrides: &[crate::eclipse_cp::LinkedOverride],
) -> Result<(ServerSpec, usize), String> {
    middleware_spec_inner(
        nc_home,
        java,
        project_root,
        work_dir,
        heap_mb,
        overrides,
        true,
    )
}

/// 只算清单、**不写** pathing jar 的版本，给「命令行」预览用。
///
/// 预览曾经和启动走同一条写 jar 的路径，而两条路径用的临时文件名是同一个
/// （`middleware-cp.jar.tmp`）：启动准备期（约 0.6 秒）点一下「命令行」，两个
/// spawn_blocking 交错写同一个 tmp，rename 出来的是混合垃圾，JVM 只会报
/// 「找不到或无法加载主类」这种查不下去的错。预览因此改为复用上次启动已经写好的
/// jar（调用方负责判断文件在不在、以及启动中不许看）。
pub fn middleware_spec_preview(
    nc_home: &Path,
    java: &Path,
    project_root: &Path,
    work_dir: &Path,
    heap_mb: u32,
    overrides: &[crate::eclipse_cp::LinkedOverride],
) -> Result<(ServerSpec, usize), String> {
    middleware_spec_inner(
        nc_home,
        java,
        project_root,
        work_dir,
        heap_mb,
        overrides,
        false,
    )
}

fn middleware_spec_inner(
    nc_home: &Path,
    java: &Path,
    project_root: &Path,
    work_dir: &Path,
    heap_mb: u32,
    overrides: &[crate::eclipse_cp::LinkedOverride],
    write_jar: bool,
) -> Result<(ServerSpec, usize), String> {
    if !java.is_file() {
        return Err(format!("找不到 NC 自带的 java：{}", java.display()));
    }
    let classes = project_class_dirs(project_root, nc_home, overrides);
    let entries = middleware_classpath(nc_home, &classes);
    if entries.is_empty() {
        return Err(format!(
            "在 {} 下没找到任何 jar：这不是能启动服务的 NC 安装目录",
            nc_home.display()
        ));
    }
    // `develop` 模式下 `Bootstrap.start()` 用「classpath 里第一个目录条目」往上两级推
    // `projectdir`，而这段代码**没有 try-catch**：classpath 全是 jar 时 `getResource("/")`
    // 返回 null ⇒ NPE ⇒ 外层 catch 打出 `start tomcat error` 后 `System.exit(-1)`，
    // Tomcat 根本没起（实证 §4.2）。宁可在这里说清原因，也不要让用户对着
    // 「start tomcat error」猜是不是缺了哪个 jar。
    if !entries.iter().any(|p| p.is_dir()) {
        return Err(format!(
            "类路径里一个目录条目都没有（{} 下全是 jar）：develop 模式会因 projectdir \
             解析失败直接退出，日志里只有一句 start tomcat error。\
             先编译一次工程（或至少让某个模块产出 classes），再启动服务。",
            nc_home.display()
        ));
    }
    // 每次启动重写清单：用户可能在两次启动之间装了补丁、加了模块
    let classpath_jar = work_dir.join("middleware-cp.jar");
    if write_jar {
        write_pathing_jar(&classpath_jar, &entries)?;
    }
    let spec = ServerSpec {
        java: java.to_path_buf(),
        main_class: MIDDLEWARE_MAIN_CLASS.to_string(),
        vm_args: middleware_vm_args(nc_home, heap_mb),
        classpath_jar,
        work_dir: nc_home.to_path_buf(),
        program_args: Vec::new(),
    };
    Ok((spec, entries.len()))
}

/// 收集目录下的一层 jar/zip（不递归）。按名字排序，与 Eclipse 的目录列举顺序对齐。
fn collect_archives(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut found: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_archive(p))
        .collect();
    found.sort_by_key(|p| p.to_string_lossy().to_uppercase());
    out.extend(found);
}

fn is_archive(p: &Path) -> bool {
    // `_src.jar` / `_doc.jar` 里没有 class，进类路径只是噪声（官方 JarFilter 也排除它们）
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name.ends_with("_src.jar") || name.ends_with("_doc.jar") {
        return false;
    }
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jar") || e.eq_ignore_ascii_case("zip"))
}

/// 写 pathing jar：一个只有 `META-INF/MANIFEST.MF` 的 zip，`Class-Path` 列出全部条目。
///
/// 先写临时文件再改名：万一中途失败，不会留下半个 jar 让下次启动读到坏清单。
pub fn write_pathing_jar(path: &Path, entries: &[PathBuf]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {e}"))?;
    }
    let tmp = path.with_extension("jar.tmp");
    let _ = std::fs::remove_file(&tmp);

    let manifest = class_path_manifest(entries);
    let build = || -> Result<(), String> {
        let file = File::create(&tmp).map_err(|e| format!("创建 pathing jar 失败: {e}"))?;
        let mut zip = ZipWriter::new(file);
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored) // 一个清单文件，压缩没意义
            .unix_permissions(0o644);
        zip.start_file("META-INF/MANIFEST.MF", opts)
            .map_err(|e| format!("写 manifest 条目失败: {e}"))?;
        zip.write_all(manifest.as_bytes())
            .map_err(|e| format!("写 manifest 内容失败: {e}"))?;
        zip.finish()
            .map_err(|e| format!("收尾 pathing jar 失败: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("替换 pathing jar 失败: {e}"))
    };
    if let Err(e) = build() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// 生成 `Class-Path` 清单行（含续行）。
///
/// 规则：每行不超过 72 字节，续行以**一个空格**开头，解析时去掉该空格直接拼接。
/// 条目用 `file:` URL，路径里的空格与非 ASCII 字符做百分号编码——NC 装在西文盘符下时
/// 中文路径很常见（用户的工程目录常带中文）。
pub fn class_path_manifest(entries: &[PathBuf]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::from("Class-Path:");

    for entry in entries {
        let text = format!(" {}", to_file_url(entry));
        for ch in text.chars() {
            if current.len() + ch.len_utf8() > MANIFEST_LINE_LIMIT {
                lines.push(std::mem::take(&mut current));
                // 续行的开头空格是「本行是续行」的标记，不是内容
                current.push(' ');
            }
            current.push(ch);
        }
    }
    lines.push(current);

    let mut out = String::new();
    out.push_str("Manifest-Version: 1.0\r\n");
    // 显式声明主版本，避免某些工具把 manifest 当成 0.x 处理
    out.push_str("Created-By: NCForge\r\n");
    out.push_str(&lines.join("\r\n"));
    out.push_str("\r\n\r\n");
    out
}

/// 本地路径转 `file:` URL。只编码会破坏 URL 或 manifest 的字符。
fn to_file_url(p: &Path) -> String {
    // 防御性再剥一次：调用方可能传的是 canonicalize 直接出来的 verbatim 路径
    let p = crate::nc_home::strip_verbatim(p);
    let is_dir = p.is_dir();
    let s = p.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file:/");
    for ch in s.chars() {
        match ch {
            '%' => out.push_str("%25"),
            ' ' => out.push_str("%20"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            c if c.is_ascii() => out.push(c),
            c => {
                // 非 ASCII 按 UTF-8 字节逐个编码
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    // 目录必须带尾斜杠：JAR 规范靠这个斜杠区分「目录条目」和「jar 条目」，
    // 漏掉它，整条 classpath 里的目录全部失效，报错是「找不到或无法加载主类」。
    if is_dir && !out.ends_with('/') {
        out.push('/');
    }
    out
}

/// 把清单写到一个临时目录里方便人肉核对（开发期排查用，不参与启动）。
#[allow(dead_code)]
pub fn dump_manifest(path: &Path, entries: &[PathBuf]) -> Result<(), String> {
    let mut f = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("写清单失败: {e}"))?;
    f.write_all(class_path_manifest(entries).as_bytes())
        .map_err(|e| format!("写清单失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 临时目录**外面再套一层**：`legacy_roots` 会把「工程根」的兄弟目录当成工作区分组
    /// （`<兄弟>/<模块>/classes`），若把工程根直接建在 `%TEMP%` 下，同一个测试二进制里
    /// 并行跑的其它用例建出来的目录就会被算进 classpath，断言随执行顺序时红时绿。
    fn temp_dir(tag: &str) -> PathBuf {
        let mut shell = std::env::temp_dir();
        shell.push(format!("ncforge-launch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&shell);
        let d = shell.join("root");
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn cleanup(d: &Path) {
        let _ = fs::remove_dir_all(d);
        // 连外面的隔离层一起删，别在 %TEMP% 里堆空目录
        if d.file_name().is_some_and(|n| n == "root") {
            if let Some(shell) = d.parent() {
                let _ = fs::remove_dir_all(shell);
            }
        }
    }

    #[test]
    fn 工程_classes_排在_nc_home_之前() {
        let home = temp_dir("order-home");
        fs::create_dir_all(home.join("middleware")).unwrap();
        fs::write(home.join("middleware").join("mw.jar"), b"x").unwrap();
        let proj = temp_dir("order-proj");
        fs::create_dir_all(&proj).unwrap();

        let cp = middleware_classpath(&home, std::slice::from_ref(&proj));
        assert_eq!(cp.first().unwrap(), &proj, "工程 classes 必须排第一");
        assert!(cp.iter().any(|p| p.ends_with("mw.jar")));
        cleanup(&home);
        cleanup(&proj);
    }

    #[test]
    fn 不存在的工程_classes_被跳过() {
        let home = temp_dir("skip-home");
        let ghost = home.join("no-such-dir");
        let cp = middleware_classpath(&home, std::slice::from_ref(&ghost));
        assert!(!cp.contains(&ghost), "不存在的目录不该进 classpath");
        cleanup(&home);
    }

    #[test]
    fn manifest_每行不超过_72_字节() {
        let entries: Vec<PathBuf> = (0..40)
            .map(|i| PathBuf::from(format!("D:/ncc/1909home/modules/m{i}/lib/some-jar-{i}.jar")))
            .collect();
        let m = class_path_manifest(&entries);
        for line in m.split("\r\n") {
            assert!(
                line.len() <= MANIFEST_LINE_LIMIT,
                "超长行（{} 字节）: {line}",
                line.len()
            );
        }
    }

    #[test]
    fn 续行拼回去等于原始条目序列() {
        let entries: Vec<PathBuf> = (0..12)
            .map(|i| PathBuf::from(format!("D:/ncc/1909home/modules/gl/lib/lib-{i}.jar")))
            .collect();
        let m = class_path_manifest(&entries);

        // 按 manifest 规范还原：以空格开头的行去掉首空格后与上一行拼接；
        // 空行表示主 section 结束，后面不再有 Class-Path
        let mut logical = String::new();
        for line in m.split("\r\n") {
            if line.is_empty() {
                break;
            }
            if let Some(rest) = line.strip_prefix(' ') {
                logical.push_str(rest);
            } else {
                logical = line.to_string();
            }
        }
        let urls: Vec<&str> = logical
            .strip_prefix("Class-Path:")
            .unwrap()
            .split(' ')
            .filter(|s| !s.is_empty())
            .collect();
        assert_eq!(urls.len(), entries.len(), "条目数对不上");
        assert_eq!(urls[0], to_file_url(&entries[0]));
        assert_eq!(urls.last().unwrap(), &to_file_url(entries.last().unwrap()));
    }

    #[test]
    fn 中文与空格路径做百分号编码() {
        let u = to_file_url(Path::new(r"D:\我的 工程\a.jar"));
        assert!(u.starts_with("file:/D:/"), "{u}");
        assert!(!u.contains(' '), "空格必须编码: {u}");
        assert!(u.contains("%E6%88%91"), "中文要按 UTF-8 编码: {u}");
        assert!(u.ends_with("a.jar"));
    }

    #[test]
    fn pathing_jar_能被当_zip_读出来且含清单() {
        let d = temp_dir("jar");
        let jar = d.join("cp.jar");
        let entries = vec![PathBuf::from("D:/ncc/1909home/lib/a.jar")];
        write_pathing_jar(&jar, &entries).unwrap();

        let f = File::open(&jar).unwrap();
        let mut z = zip::ZipArchive::new(f).unwrap();
        let mut s = String::new();
        use std::io::Read;
        z.by_name("META-INF/MANIFEST.MF")
            .unwrap()
            .read_to_string(&mut s)
            .unwrap();
        assert!(s.contains("Class-Path:"));
        assert!(s.contains("a.jar"));
        cleanup(&d);
    }

    #[test]
    fn 重复写同一个_pathing_jar_不会残留_tmp() {
        let d = temp_dir("rewrite");
        let jar = d.join("cp.jar");
        write_pathing_jar(&jar, &[PathBuf::from("D:/a.jar")]).unwrap();
        write_pathing_jar(&jar, &[PathBuf::from("D:/b.jar")]).unwrap();
        let leftovers: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不该留 .tmp 残骸");
        cleanup(&d);
    }

    #[test]
    fn verbatim_路径不会把问号编码进_url() {
        let m = class_path_manifest(&[PathBuf::from(r"\\?\D:\ncc\lib\a.jar")]);
        assert!(!m.contains("%3F"), "问号被编码了，Java 会找不到 jar:\n{m}");
        assert!(m.contains("file:/D:/ncc/lib/a.jar"), "{m}");
    }

    #[test]
    fn 目录条目必须以斜杠结尾() {
        // 造一个真目录：to_file_url 靠 is_dir() 判断要不要补斜杠
        let d = temp_dir("dir-entry");
        let url = to_file_url(&d);
        assert!(
            url.ends_with('/'),
            "目录条目不补斜杠，JVM 会当 jar 打开失败：{url}"
        );
        // 文件不补：否则 JVM 会把它当目录去里面找类
        let f = d.join("a.jar");
        std::fs::write(&f, b"x").unwrap();
        assert!(!to_file_url(&f).ends_with('/'), "jar 条目不该带斜杠");
        cleanup(&d);
    }

    #[test]
    fn 中间件_vm_参数里带绝对路径() {
        let args = middleware_vm_args(Path::new(r"D:\ncc\1909home"), DEFAULT_HEAP_MB);
        assert!(args
            .iter()
            .any(|a| a == r"-Dnc.server.location=D:\ncc\1909home"));
        assert!(args.iter().any(|a| a.starts_with("-DEJBConfigDir=")));
        // 默认堆 4G：1G 跑不动 245 个模块，80G（prop.xml 的生产值）在开发机上起不来
        assert!(
            args.iter().any(|a| a == "-Xmx4096m"),
            "默认堆上限应为 4G：{args:?}"
        );
    }

    #[test]
    fn 堆上限按配置改且只出现一次() {
        let args = middleware_vm_args(Path::new(r"D:\ncc\1909home"), 8192);
        let xmx: Vec<&String> = args.iter().filter(|a| a.starts_with("-Xmx")).collect();
        assert_eq!(
            xmx.len(),
            1,
            "堆参数只能有一个，否则 JVM 以后出现的为准：{args:?}"
        );
        assert_eq!(xmx[0], "-Xmx8192m");
    }

    #[test]
    fn 堆上限默认与越界都被收口() {
        assert_eq!(effective_heap_mb(None), DEFAULT_HEAP_MB);
        assert_eq!(effective_heap_mb(Some(6144)), 6144);
        // 太小：512 以下连模块都加载不完，夹到下限而不是原样交给 JVM（会直接起不来）
        assert_eq!(effective_heap_mb(Some(0)), HEAP_MIN_MB);
        assert_eq!(effective_heap_mb(Some(100)), HEAP_MIN_MB);
        // 太大：手滑多敲几个零时夹到上限
        assert_eq!(effective_heap_mb(Some(u32::MAX)), HEAP_MAX_MB);
    }

    /// 命令层守卫与收口是两回事：守卫对「界面上填的越界值」必须报错，
    /// 收口只兜「手改坏的配置文件」。混在一起就会出现「填 70000 变成 65536」。
    #[test]
    fn 堆上限守卫_越界报错且说清边界() {
        // None = 恢复默认，合法
        assert!(validate_heap_mb(None).is_ok());
        assert!(validate_heap_mb(Some(512)).is_ok(), "下限本身合法");
        assert!(validate_heap_mb(Some(65536)).is_ok(), "上限本身合法");
        assert!(validate_heap_mb(Some(4096)).is_ok());
        // 40000（约 39G）在区间内：上限 64G 只是防手滑多打几个零，不是建议值
        assert!(validate_heap_mb(Some(40000)).is_ok(), "区间内的值不该被拒");

        for bad in [0u32, 100, 511, 65537, 70000, u32::MAX] {
            let e = validate_heap_mb(Some(bad)).unwrap_err();
            assert!(
                e.contains("512") && e.contains("65536"),
                "错误要说清边界：{e}"
            );
            assert!(e.contains(&bad.to_string()), "错误要回显用户填的数：{e}");
        }
    }

    /// 工程 class 目录的顺序决定了「改完代码重启到底生效没」：工程自己的 classes
    /// 必须在最前，排在 jar 之后就会被 jar 里的旧类盖掉。
    #[test]
    fn 工程_class_目录按_模块_out_分组_nc_home_排列() {
        // 造：base/ws/{newar(工程), pm/phm}、base/home/modules/gl/classes
        let base = temp_dir("cls-order");
        let ws = base.join("ws");
        let proj = ws.join("newar");
        fs::create_dir_all(proj.join("gl").join("classes")).unwrap();
        fs::create_dir_all(proj.join("out").join("ic")).unwrap();
        fs::create_dir_all(ws.join("pm").join("phm").join("classes")).unwrap();
        let home = base.join("home");
        fs::create_dir_all(home.join("modules").join("gl").join("classes")).unwrap();

        let dirs = project_class_dirs(&proj, &home, &[]);
        assert_eq!(
            dirs[0],
            proj.join("gl").join("classes"),
            "工程模块 classes 必须第一"
        );
        assert_eq!(
            dirs[1],
            proj.join("out").join("ic"),
            "out/<模块> 排在模块 classes 之后"
        );
        assert_eq!(
            dirs[2],
            ws.join("pm").join("phm").join("classes"),
            "同工作区其他分组排第三"
        );
        assert_eq!(
            dirs[3],
            home.join("modules").join("gl").join("classes"),
            "NC home 的模块 classes 排最后"
        );
        cleanup(&base);
    }

    #[test]
    fn hotwebs_按目录实扫而不是写死名单() {
        let home = temp_dir("hotwebs");
        for name in ["eyeapp", "iwebap", "nccloud"] {
            fs::create_dir_all(home.join("hotwebs").join(name)).unwrap();
        }
        // 不是目录的同名文件不算 webapp
        fs::write(home.join("hotwebs").join("readme.txt"), b"x").unwrap();

        let names = hotwebs_names(&home);
        assert_eq!(
            names,
            vec!["eyeapp", "iwebap", "nccloud"],
            "hotwebs/ 下每个子目录都要挂载，iwebap 与 eyeapp 曾因写死白名单被静默丢弃"
        );
        cleanup(&home);
    }

    #[test]
    fn hotwebs_目录缺失时回落默认名单而不是空串() {
        let home = temp_dir("hotwebs-none");
        let names = hotwebs_names(&home);
        assert_eq!(names, FALLBACK_HOTWEBS.to_vec());
        // 空串在白名单语义下等于「全不挂」，比少挂几个更糟
        assert!(!names.is_empty(), "绝不能返回空集合");
        cleanup(&home);
    }

    #[test]
    fn 服务名取自_prop_xml_的_domain_server() {
        let home = temp_dir("prop-name");
        let dir = home.join("ierp").join("bin");
        fs::create_dir_all(&dir).unwrap();
        // 骨架照真实 prop.xml：`<server>` 块外还有同名 `<name>`（service 段的服务组件名），
        // 全文件找 `<name>` 会拿到 StartTomcat
        fs::write(
            dir.join("prop.xml"),
            b"<root><domain><server><javaHome>$JAVA_HOME</javaHome>\
              <name>xuyserver</name><http><port>80</port></http></server></domain>\
              <internalServiceArray><name>StartTomcat</name></internalServiceArray></root>",
        )
        .unwrap();

        let args = middleware_vm_args(&home, DEFAULT_HEAP_MB);
        assert!(
            args.iter().any(|a| a == "-Dnc.server.name=xuyserver"),
            "要从 prop.xml 的 <server><name> 取服务名：{args:?}"
        );
        cleanup(&home);
    }

    #[test]
    fn prop_xml_缺失时服务名回落_server() {
        let home = temp_dir("prop-none");
        let args = middleware_vm_args(&home, DEFAULT_HEAP_MB);
        let want = format!("-Dnc.server.name={}", crate::nc_home::DEFAULT_SERVER_NAME);
        assert!(
            args.contains(&want),
            "读不到配置时要显式给默认名，与 ServiceManagerDaemon 的缺省一致：{args:?}"
        );
        cleanup(&home);
    }

    #[test]
    fn vm_参数里的_hotwebs_是实扫结果() {
        let home = temp_dir("vm-hotwebs");
        fs::create_dir_all(home.join("hotwebs").join("uapws")).unwrap();
        fs::create_dir_all(home.join("hotwebs").join("iwebap")).unwrap();
        let args = middleware_vm_args(&home, DEFAULT_HEAP_MB);
        assert!(
            args.iter().any(|a| a == "-Duap.hotwebs=iwebap,uapws"),
            "{args:?}"
        );
        cleanup(&home);
    }

    /// `external/classes`（二开覆盖类）与 `resources`（framework 热修复类）以前根本不进
    /// classpath；后者还必须早于 `lib/*.jar` 才有覆盖效果——顺序错了等于没加。
    #[test]
    fn external_classes_与_resources_进类路径且早于_lib() {
        let home = temp_dir("home-cp");
        fs::create_dir_all(home.join("middleware")).unwrap();
        fs::write(home.join("middleware").join("mw.jar"), b"x").unwrap();
        fs::create_dir_all(home.join("lib")).unwrap();
        fs::write(home.join("lib").join("fwserver.jar"), b"x").unwrap();
        fs::create_dir_all(home.join("external").join("classes")).unwrap();
        fs::create_dir_all(home.join("resources")).unwrap();
        fs::create_dir_all(home.join("framework")).unwrap();
        fs::write(home.join("framework").join("fw.jar"), b"x").unwrap();

        let cp = middleware_classpath(&home, &[]);
        let pos = |needle: &str| {
            cp.iter()
                .position(|p| p.ends_with(needle))
                .unwrap_or_else(|| panic!("{needle} 不在 classpath 里: {cp:?}"))
        };
        assert!(pos("middleware/mw.jar") == 0, "middleware 的 jar 必须第一");
        assert!(
            pos("external/classes") < pos("lib/fwserver.jar"),
            "external 是官方第 4 段，必须早于 NCHOME 的 lib"
        );
        assert!(
            pos("resources") < pos("lib/fwserver.jar"),
            "resources 要靠「排在 lib 前」才能覆盖 fwserver.jar 里的同名类"
        );
        assert!(
            pos("framework/fw.jar") < pos("external/classes"),
            "官方 framework 是第 3 段，早于 external"
        );
        cleanup(&home);
    }

    /// classpath 全是 jar 时 develop 模式会 NPE → exit(-1)，错误信息只有一句
    /// 「start tomcat error」。这里必须在拼参数阶段就拦住并说清原因。
    #[test]
    fn 类路径没有目录条目时给出可读错误() {
        // home 单独放一层：`legacy_roots` 会扫「工程根的兄弟目录」，
        // 直接建在 %TEMP% 下会把机器的真实目录算进来
        let base = temp_dir("no-dir-entry");
        let home = base.join("home");
        fs::create_dir_all(home.join("middleware")).unwrap();
        fs::write(home.join("middleware").join("mw.jar"), b"x").unwrap();
        let java = home.join("ufjdk").join("bin").join("java.exe");
        fs::create_dir_all(java.parent().unwrap()).unwrap();
        fs::write(&java, b"stub").unwrap();

        let err = middleware_spec(&home, &java, &home, &base, DEFAULT_HEAP_MB, &[]).unwrap_err();
        assert!(
            err.contains("目录条目") && err.contains("start tomcat error"),
            "错误要解释清楚为什么起不来：{err}"
        );
        cleanup(&base);
    }

    #[test]
    fn nc_home_里没有_jar_时不生成启动参数() {
        let home = temp_dir("no-jar-home");
        fs::create_dir_all(home.join("modules")).unwrap();
        let java = home.join("ufjdk").join("bin").join("java.exe");
        fs::create_dir_all(java.parent().unwrap()).unwrap();
        fs::write(&java, b"stub").unwrap();

        let err = middleware_spec(&home, &java, &home, &home, DEFAULT_HEAP_MB, &[]).unwrap_err();
        assert!(err.contains("没找到任何 jar"), "错误要指出缺 jar：{err}");
        cleanup(&home);
    }

    #[test]
    fn 缺_java_时拒绝启动() {
        let home = temp_dir("no-java");
        let err = middleware_spec(
            &home,
            &home.join("nope").join("java.exe"),
            &home,
            &home,
            DEFAULT_HEAP_MB,
            &[],
        )
        .unwrap_err();
        assert!(err.contains("找不到 NC 自带的 java"), "{err}");
        cleanup(&home);
    }
}
