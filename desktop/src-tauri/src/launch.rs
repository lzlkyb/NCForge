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

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::nc_index::{module_layers, LayerKind};
use crate::server::ServerSpec;

/// 中间件主类（开发态直启，不走 `bin/startup.bat` 的 NCStarter）。
pub const MIDDLEWARE_MAIN_CLASS: &str = "ufmiddle.start.tomcat.StartDirectServer";

/// NC 客户端主类（Swing 界面）。
///
/// Eclipse 的 `newar_JStarter.launch` 用的就是它；类在
/// `modules/riart/client/lib/uiriart_riasfbaseLevel-1.jar` 里。
pub const CLIENT_MAIN_CLASS: &str = "nc.starter.test.JStarter";

/// 客户端堆上限默认值（MB）。
///
/// Eclipse 启动配置写的是 `-Xmx768m`。客户端只画 Swing 界面，不像中间件要装 245 个
/// 模块；768M 是官方验证过的值，用户仍可在服务页改。
pub const DEFAULT_CLIENT_HEAP_MB: u32 = 768;

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

/// 默认挂载的 web 应用，与 Eclipse 启动配置（`*-_Server.launch`）里的
/// `-Duap.hotwebs` 完全一致。
///
/// 为什么默认不是「目录里有几个挂几个」：`develop` 模式下 `uap.hotwebs` 是白名单，
/// 多挂一个目录就多初始化一个 Spring 上下文，而所有 webapp 共用同一条 classpath。
/// 实测把 `hotwebs/ncchr`（HR 插件）一起挂上时，它依赖的 spring-data-redis 2.1.6
/// 会去调 Spring 5 的 `Assert.isTrue(boolean, Supplier)`，而 classpath 里排前的是
/// `external/lib/spring-core-4.3.12`（官方 bootstrap 也是这个顺序）⇒
/// `NoSuchMethodError: org.springframework.util.Assert.isTrue(ZLjava/util/function/Supplier;)V`
/// ⇒ `Context [/ncchr] startup failed`。Eclipse 只挂这 5 个，所以开发态看不到这条报错；
/// 工作台默认也挂这 5 个，「在 Eclipse 里能起、在工作台里也能起」才是可预期的。
///
/// 需要 iwebap / eyeapp 等其它前端时在服务页勾选，见 [`hotwebs_names`]。
///
/// **不能传空串**：空串会被解析成空集合 ⇒ 所有 hotwebs 全部跳过，
/// 服务「启动成功」但一个前端页面都打不开。
pub const DEFAULT_HOTWEBS: [&str; 5] = ["nccloud", "uapws", "lfw", "portal", "fs"];

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

/// `hotwebs/` 下真实存在的子目录（排序）；目录缺失时返回空。
pub fn all_hotwebs(home: &Path) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(home.join(HOTWEBS_DIR)) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

/// 本次启动要挂载的 webapp 名单。
///
/// `configured` 是配置里的显式名单：`None` / 空 = 默认名单（与 Eclipse 一致，
/// 理由见 [`DEFAULT_HOTWEBS`]）。
///
/// 显式名单只保留安装目录里**真实存在**的目录：手改配置写错一个字母时，宁可少挂
/// 一个，也不要让 Tomcat 拿着一个不存在的名字去初始化（那种偏差在日志里很难找）。
/// 过滤后一个都不剩（例如换了 NC 安装）时回落默认名单——空集合等于全不挂，比多挂
/// 一个坏 webapp 更难发现。
pub fn hotwebs_names(home: &Path, configured: Option<&[String]>) -> Vec<String> {
    let all = all_hotwebs(home);
    // 没有 hotwebs/ 目录时无法校验任何显式名单，一律用默认：此时显式名单多半是
    // 从另一台机器抄来的，照着挂反而会挂空。
    let mut names: Vec<String> = match configured {
        Some(list) if !list.is_empty() && !all.is_empty() => list
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && all.contains(s))
            .collect(),
        _ => DEFAULT_HOTWEBS.iter().map(|s| s.to_string()).collect(),
    };
    names.sort();
    names.dedup();
    if names.is_empty() {
        return DEFAULT_HOTWEBS.iter().map(|s| s.to_string()).collect();
    }
    names
}

/// 中间件 VM 参数（`heap_mb` 为堆上限，调用方传 `effective_heap_mb(配置值)`；
/// `hotwebs` 传 `hotwebs_names` 的返回值）。
///
/// 只有一个入口、一个必填的 `heap_mb`：留一个「默认值版本」的重载，迟早会有人
/// 在启动路径上调它，于是「预览显示 8G、真起的是 4G」。
///
/// `-Dnc.server.location` / `-DEJBConfigDir` / `-DExtServiceConfigDir` 三个必须是
/// 绝对路径，且工作目录也得是 NC home——中间件会用相对路径去开 `ejbXMLs` 与日志。
pub fn middleware_vm_args(
    home: &Path,
    heap_mb: u32,
    debug_port: Option<u16>,
    hotwebs: &[String],
) -> Vec<String> {
    let h = home.to_string_lossy();
    // 服务名必须与 prop.xml 一致：我们跳过 `Main` 直接起 `StartDirectServer`，
    // 没人替我们补 `-Dnc.server.name`（实证 §5 E3），缺了就退回默认 `server`。
    let server_name = crate::nc_home::read_server_name(home)
        .unwrap_or_else(|| crate::nc_home::DEFAULT_SERVER_NAME.to_string());
    let mut args = vec![
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
        // 白名单语义；名单由服务页决定，默认与 Eclipse 启动配置一致（理由见 DEFAULT_HOTWEBS）
        format!("-Duap.hotwebs={}", hotwebs.join(",")),
        "-Djava.net.preferIPv4Stack=true".into(),
        "-DforceUseRedis=true".into(),
        // 别让 JVM 去读机器上别的 java 配置，行为才可复现
        "-Dfile.encoding=GBK".into(),
    ];
    if let Some(port) = debug_port {
        // JDWP 没有认证，等同于远程执行入口：只许绑回环，且默认不开（None 时不出现）。
        // Java 8 的 address 语法是 [host:]port；写死 127.0.0.1 而不是 0.0.0.0 是红线。
        args.push(format!(
            "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:{port}"
        ));
    }
    args
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

/// 中间件启动时可调的三项（都在服务页可改）。
///
/// 打成一个结构既压住 `middleware_spec` 的参数个数，也让「堆 + 调试端口 + web 应用」
/// 始终成组传递：启动与命令行预览各拼一套参数，迟早会出现「预览显示 8G、真起的是 4G」
/// 或「预览说挂了 5 个、实际挂了 18 个」。
#[derive(Clone, Copy)]
pub struct MiddlewareTuning<'a> {
    /// 堆上限（调用方传 `effective_heap_mb(配置值)`）。
    pub heap_mb: u32,
    pub debug_port: Option<u16>,
    /// `hotwebs_names` 的返回值。
    pub hotwebs: &'a [String],
}

/// 拼出中间件的完整启动要素（写好 pathing jar，返回可直接起进程的 `ServerSpec`）。
///
/// `work_dir` 只用来放 pathing jar：**不要写进 NC home**。安装目录是同事共用的，
/// 往里塞 `*.jar` 既可能被 `middleware/*.jar` 的扫描收进去，也可能被当成脏文件清掉。
pub fn middleware_spec(
    nc_home: &Path,
    java: &Path,
    project_root: &Path,
    work_dir: &Path,
    tuning: MiddlewareTuning<'_>,
    overrides: &[crate::eclipse_cp::LinkedOverride],
) -> Result<(ServerSpec, usize), String> {
    middleware_spec_inner(
        nc_home,
        java,
        project_root,
        work_dir,
        middleware_vm_args(nc_home, tuning.heap_mb, tuning.debug_port, tuning.hotwebs),
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
    tuning: MiddlewareTuning<'_>,
    overrides: &[crate::eclipse_cp::LinkedOverride],
) -> Result<(ServerSpec, usize), String> {
    middleware_spec_inner(
        nc_home,
        java,
        project_root,
        work_dir,
        middleware_vm_args(nc_home, tuning.heap_mb, tuning.debug_port, tuning.hotwebs),
        overrides,
        false,
    )
}

fn middleware_spec_inner(
    nc_home: &Path,
    java: &Path,
    project_root: &Path,
    work_dir: &Path,
    vm_args: Vec<String>,
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
        vm_args,
        classpath_jar,
        work_dir: nc_home.to_path_buf(),
        program_args: Vec::new(),
    };
    Ok((spec, entries.len()))
}

/// 客户端堆上限的生效值。规则与 `effective_heap_mb` 相同，只换默认值。
pub fn effective_client_heap_mb(configured: Option<u32>) -> u32 {
    configured.map_or(DEFAULT_CLIENT_HEAP_MB, |mb| {
        mb.clamp(HEAP_MIN_MB, HEAP_MAX_MB)
    })
}

/// 客户端要连的中间件地址：`-Dnc.jstart.server` / `-Dnc.jstart.port`。
///
/// 端口必须取自 `ierp/bin/prop.xml`（用户可能把 80 改成 8081）。地址也跟配置走：
/// 配了具体局域网 IP 时客户端要连那个 IP；`0.0.0.0` / `::` 表示监听所有网卡，
/// 客户端连回环即可（Eclipse 的工作区变量值也是 `127.0.0.1`）。
pub fn client_endpoint(home: &Path) -> (String, u16) {
    client_endpoint_host_port(&crate::nc_home::read_endpoints(home))
}

/// 从已读好的端点里取客户端要连的主机与端口。
///
/// 单独抽出来是因为状态查询已经读过一次 `prop.xml`：再调 `client_endpoint(home)`
/// 会把同一个文件读两遍，而这段逻辑还需要处理 `0.0.0.0` / `::` 的映射。
pub fn client_endpoint_host_port(ep: &crate::nc_home::ServerEndpoints) -> (String, u16) {
    let host = match ep.http_address.as_deref().map(str::trim) {
        Some(a) if !a.is_empty() && a != "0.0.0.0" && a != "::" && a != "[::]" => a.to_string(),
        _ => "127.0.0.1".to_string(),
    };
    (host, ep.http_port)
}

/// 客户端 VM 参数。
///
/// 对齐 Eclipse 的 `newar_JStarter.launch`：`-Dnc.runMode=develop`、
/// `-Dnc.jstart.server`、`-Dnc.jstart.port`、`-Xmx768m`。Eclipse 老配置里的
/// `-XX:MaxPermSize=256m` 在 1.8 上是被忽略的空参数（Metaspace 才是真正生效的），
/// 这里写成 `-XX:MaxMetaspaceSize=256m`，避免日志里出现一行无意义的警告。
pub fn client_vm_args(host: &str, port: u16, heap_mb: u32, debug_port: Option<u16>) -> Vec<String> {
    let mut args = vec![
        "-Dnc.runMode=develop".into(),
        format!("-Dnc.jstart.server={host}"),
        format!("-Dnc.jstart.port={port}"),
        format!("-Xmx{heap_mb}m"),
        "-XX:MaxMetaspaceSize=256m".into(),
    ];
    if let Some(port) = debug_port {
        // 与中间件同一条红线：JDWP 无鉴权，只许绑回环
        args.push(format!(
            "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:{port}"
        ));
    }
    args
}

/// 客户端 classpath：复刻 Eclipse UAP 插件的 `ClientClasspathEntry`。
///
/// 顺序（也是优先级）：
/// 1. 工程侧输出目录（`.classpath` 解析出来，不含 NC home 的模块 classes）；
/// 2. `Product_Common_Library`：NC home 根 + `external/` 的 `computeStandCP`；
/// 3. `Module_Public_Library`：每个模块的 `computeStandCP`（15 层里的 public 作用域）；
/// 4. `Module_Client_Library`：每个模块的 `client/` 再走 `computeStandCP`。
///    `uap*` 与当前工程同名模块算「accessible」排前面，其余算「discouraged」排后面——
///    两者都进 classpath，只是 Eclipse 会给后者打警告。这里不读那个偏好设置。
/// 5. `Module_Lang_Library`：`langlib/` 下一层 jar。
///
/// 已知差异：Eclipse 还会按 `FIELD_EX_MODULES` 排除显式 ex 模块，本工具不读该偏好，
/// 因此这些模块的 public/client 仍会进 classpath。多收通常只是清单更长，不会缺类；
/// 若确有 ex 模块与主模块同名类冲突，以 Eclipse 的清单为准时需要把该偏好的实际值
/// 补进来（未做是因为它存在 Eclipse 工作区变量里，跨机器不可得）。
///
/// **不包含** `middleware` / `framework` / `ant` / `ejb`，也不包含
/// `modules/*/META-INF`（`Module_Private_Library`）——这是插件的客户端规则，
/// 与服务端 7000+ jar 的全量 classpath 是两回事。
pub fn client_classpath(
    home: &Path,
    project_dirs: &[PathBuf],
    current_module: Option<&str>,
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = project_dirs
        .iter()
        .filter(|p| p.is_dir())
        .cloned()
        .collect();

    // Product_Common_Library：NC home 根 + external
    out.extend(crate::nc_index::stand_cp(home));
    out.extend(crate::nc_index::stand_cp(&home.join("external")));

    let modules = home.join("modules");
    let names = crate::nc_index::module_names(home);

    // Module_Public_Library
    for name in &names {
        out.extend(crate::nc_index::stand_cp(&modules.join(name)));
    }

    // Module_Client_Library：accessible 在前，discouraged 在后
    let accessible = |name: &str| {
        name.to_ascii_lowercase().starts_with("uap")
            || current_module.is_some_and(|m| name.eq_ignore_ascii_case(m))
    };
    for name in names.iter().filter(|n| accessible(n)) {
        out.extend(crate::nc_index::stand_cp(
            &modules.join(name).join("client"),
        ));
    }
    for name in names.iter().filter(|n| !accessible(n)) {
        out.extend(crate::nc_index::stand_cp(
            &modules.join(name).join("client"),
        ));
    }

    // Module_Lang_Library：langlib 下的 jar 直接放在目录里，没有 lib/ 这一层
    out.extend(crate::nc_index::one_level_archives(&home.join("langlib")));
    out
}

/// 拼出客户端的完整启动要素（写好 pathing jar，返回可直接起进程的 `ServerSpec`）。
///
/// `work_dir` 只用来放 pathing jar；客户端进程的工作目录仍是 NC home
/// （Eclipse 的 `ATTR_WORKING_DIRECTORY = FIELD_NC_HOME`）。
pub fn client_spec(
    nc_home: &Path,
    java: &Path,
    project_root: &Path,
    work_dir: &Path,
    heap_mb: u32,
    debug_port: Option<u16>,
    overrides: &[crate::eclipse_cp::LinkedOverride],
) -> Result<(ServerSpec, usize), String> {
    client_spec_inner(
        nc_home,
        java,
        project_root,
        work_dir,
        LaunchTuning {
            heap_mb,
            debug_port,
        },
        overrides,
        true,
    )
}

/// 只算清单、**不写** pathing jar 的客户端版本，给「命令行」预览用。
pub fn client_spec_preview(
    nc_home: &Path,
    java: &Path,
    project_root: &Path,
    work_dir: &Path,
    heap_mb: u32,
    debug_port: Option<u16>,
    overrides: &[crate::eclipse_cp::LinkedOverride],
) -> Result<(ServerSpec, usize), String> {
    client_spec_inner(
        nc_home,
        java,
        project_root,
        work_dir,
        LaunchTuning {
            heap_mb,
            debug_port,
        },
        overrides,
        false,
    )
}

/// 两个只在启动时生效的 JVM 参数。打包成一个结构是给 `client_spec_inner`
/// 控制参数个数（clippy 上限 7），同时让「堆 + 调试端口」这对语义保持成组。
#[derive(Clone, Copy)]
struct LaunchTuning {
    heap_mb: u32,
    debug_port: Option<u16>,
}

fn client_spec_inner(
    nc_home: &Path,
    java: &Path,
    project_root: &Path,
    work_dir: &Path,
    tuning: LaunchTuning,
    overrides: &[crate::eclipse_cp::LinkedOverride],
    write_jar: bool,
) -> Result<(ServerSpec, usize), String> {
    if !java.is_file() {
        return Err(format!("找不到 NC 自带的 java：{}", java.display()));
    }
    // 客户端只保留工程侧输出，NC home 的模块类由下面四个库提供；
    // 再拼 `module_class_dirs` 会让同一批类出现两次、顺序也偏离 Eclipse。
    let project_dirs = crate::eclipse_cp::project_outputs(project_root, overrides);
    let current_module = project_root.file_name().and_then(|n| n.to_str());
    let entries = client_classpath(nc_home, &project_dirs, current_module);
    if entries.is_empty() {
        return Err(format!(
            "在 {} 下没找到任何客户端 classpath 条目：这不是能启动客户端的 NC 安装目录",
            nc_home.display()
        ));
    }
    let classpath_jar = work_dir.join("client-cp.jar");
    if write_jar {
        write_pathing_jar(&classpath_jar, &entries)?;
    }
    let (host, port) = client_endpoint(nc_home);
    let spec = ServerSpec {
        java: java.to_path_buf(),
        main_class: CLIENT_MAIN_CLASS.to_string(),
        vm_args: client_vm_args(&host, port, tuning.heap_mb, tuning.debug_port),
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

    /// 默认 webapp 名单（与 `hotwebs_names(home, None)` 一样是排序后的）。只关心其它
    /// 参数的用例可以直接传它。
    fn default_hotwebs() -> Vec<String> {
        let mut names: Vec<String> = DEFAULT_HOTWEBS.iter().map(|s| s.to_string()).collect();
        names.sort();
        names
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
        let args = middleware_vm_args(
            Path::new(r"D:\ncc\1909home"),
            DEFAULT_HEAP_MB,
            None,
            &default_hotwebs(),
        );
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
        let args = middleware_vm_args(
            Path::new(r"D:\ncc\1909home"),
            8192,
            None,
            &default_hotwebs(),
        );
        let xmx: Vec<&String> = args.iter().filter(|a| a.starts_with("-Xmx")).collect();
        assert_eq!(
            xmx.len(),
            1,
            "堆参数只能有一个，否则 JVM 以后出现的为准：{args:?}"
        );
        assert_eq!(xmx[0], "-Xmx8192m");
    }

    /// 调试参数：默认一个都不加；开了只绑回环、不 suspend。
    ///
    /// `suspend=y` 会让 JVM 停在启动前等调试器 attach，NC 服务就永远起不来；
    /// 绑 0.0.0.0 则等于把无鉴权的 JDWP 敞开给同网段任何人。
    #[test]
    fn 调试参数默认关闭_开启时只绑回环() {
        let off = middleware_vm_args(
            Path::new(r"D:\ncc\1909home"),
            DEFAULT_HEAP_MB,
            None,
            &default_hotwebs(),
        );
        assert!(
            !off.iter().any(|a| a.contains("jdwp")),
            "没开调试不该带 JDWP：{off:?}"
        );

        let on = middleware_vm_args(
            Path::new(r"D:\ncc\1909home"),
            DEFAULT_HEAP_MB,
            Some(61539),
            &default_hotwebs(),
        );
        let jdwp: Vec<&String> = on
            .iter()
            .filter(|a| a.starts_with("-agentlib:jdwp"))
            .collect();
        assert_eq!(jdwp.len(), 1, "JDWP 参数只能有一个：{on:?}");
        assert_eq!(
            jdwp[0].as_str(),
            "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:61539"
        );
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

    /// 默认名单必须与 Eclipse 一致：多挂一个目录就多初始化一个 Spring 上下文，
    /// 而它们共用同一条 classpath（`ncchr` 就是这么撞上 Spring 版本冲突的）。
    #[test]
    fn hotwebs_默认名单与_eclipse_一致而不是全挂() {
        let home = temp_dir("hotwebs-default");
        for name in [
            "eyeapp", "fs", "iwebap", "lfw", "ncchr", "nccloud", "portal", "uapws",
        ] {
            fs::create_dir_all(home.join("hotwebs").join(name)).unwrap();
        }
        // 不是目录的同名文件不算 webapp
        fs::write(home.join("hotwebs").join("readme.txt"), b"x").unwrap();

        assert_eq!(
            hotwebs_names(&home, None),
            vec!["fs", "lfw", "nccloud", "portal", "uapws"],
            "默认只挂 Eclipse 那 5 个；全挂会把 ncchr 这类插件 webapp 也拉起来"
        );
        assert_eq!(
            all_hotwebs(&home),
            vec!["eyeapp", "fs", "iwebap", "lfw", "ncchr", "nccloud", "portal", "uapws"],
            "界面上仍要能看到全部候选，供用户按需勾选"
        );
        cleanup(&home);
    }

    /// 显式名单：只保留安装目录里真实存在的名字，并排序去重。
    #[test]
    fn hotwebs_显式名单按实扫结果过滤并排序() {
        let home = temp_dir("hotwebs-explicit");
        for name in ["nccloud", "iwebap", "eyeapp"] {
            fs::create_dir_all(home.join("hotwebs").join(name)).unwrap();
        }
        let configured = vec![
            "iwebap".to_string(),
            "nccloud".to_string(),
            "iwebap".to_string(),
            "typo".to_string(),
        ];
        assert_eq!(
            hotwebs_names(&home, Some(&configured)),
            vec!["iwebap", "nccloud"],
            "写错的名字要忽略，重复项要去重"
        );
        cleanup(&home);
    }

    #[test]
    fn hotwebs_目录缺失或名单全失效时回落默认且不为空() {
        let home = temp_dir("hotwebs-none");
        assert_eq!(hotwebs_names(&home, None), default_hotwebs());
        // 显式名单里的目录一个都不存在（换过安装目录）：回落默认，绝不能全不挂
        let stale = vec!["gone".to_string()];
        assert_eq!(hotwebs_names(&home, Some(&stale)), default_hotwebs());
        // 空串在白名单语义下等于「全不挂」，比少挂几个更糟
        assert!(!hotwebs_names(&home, None).is_empty(), "绝不能返回空集合");
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

        let args = middleware_vm_args(&home, DEFAULT_HEAP_MB, None, &default_hotwebs());
        assert!(
            args.iter().any(|a| a == "-Dnc.server.name=xuyserver"),
            "要从 prop.xml 的 <server><name> 取服务名：{args:?}"
        );
        cleanup(&home);
    }

    #[test]
    fn prop_xml_缺失时服务名回落_server() {
        let home = temp_dir("prop-none");
        let args = middleware_vm_args(&home, DEFAULT_HEAP_MB, None, &default_hotwebs());
        let want = format!("-Dnc.server.name={}", crate::nc_home::DEFAULT_SERVER_NAME);
        assert!(
            args.contains(&want),
            "读不到配置时要显式给默认名，与 ServiceManagerDaemon 的缺省一致：{args:?}"
        );
        cleanup(&home);
    }

    #[test]
    fn vm_参数里的_hotwebs_用调用方给的名单() {
        let home = temp_dir("vm-hotwebs");
        fs::create_dir_all(home.join("hotwebs").join("uapws")).unwrap();
        fs::create_dir_all(home.join("hotwebs").join("iwebap")).unwrap();
        let hotwebs = hotwebs_names(&home, Some(&["iwebap".to_string(), "uapws".to_string()]));
        let args = middleware_vm_args(&home, DEFAULT_HEAP_MB, None, &hotwebs);
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

        let err = middleware_spec(
            &home,
            &java,
            &home,
            &base,
            MiddlewareTuning {
                heap_mb: DEFAULT_HEAP_MB,
                debug_port: None,
                hotwebs: &default_hotwebs(),
            },
            &[],
        )
        .unwrap_err();
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

        let err = middleware_spec(
            &home,
            &java,
            &home,
            &home,
            MiddlewareTuning {
                heap_mb: DEFAULT_HEAP_MB,
                debug_port: None,
                hotwebs: &default_hotwebs(),
            },
            &[],
        )
        .unwrap_err();
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
            MiddlewareTuning {
                heap_mb: DEFAULT_HEAP_MB,
                debug_port: None,
                hotwebs: &default_hotwebs(),
            },
            &[],
        )
        .unwrap_err();
        assert!(err.contains("找不到 NC 自带的 java"), "{err}");
        cleanup(&home);
    }

    /// 客户端 VM 参数对齐 Eclipse 的 `JStarter` 启动配置。
    #[test]
    fn 客户端_vm_参数带连接地址与默认堆() {
        let args = client_vm_args("192.168.1.20", 8081, DEFAULT_CLIENT_HEAP_MB, None);
        assert!(args.iter().any(|a| a == "-Dnc.runMode=develop"));
        assert!(args.iter().any(|a| a == "-Dnc.jstart.server=192.168.1.20"));
        assert!(args.iter().any(|a| a == "-Dnc.jstart.port=8081"));
        assert!(
            args.iter().any(|a| a == "-Xmx768m"),
            "客户端默认堆应为 768M：{args:?}"
        );
        assert!(
            !args.iter().any(|a| a.contains("jdwp")),
            "没开调试不该带 JDWP：{args:?}"
        );
        // Eclipse 老配置的 MaxPermSize 在 JDK 8 上无效，不能再原样搬过来
        assert!(!args.iter().any(|a| a.contains("MaxPermSize")));
    }

    #[test]
    fn 客户端调试参数只绑回环且不_suspend() {
        let args = client_vm_args("127.0.0.1", 80, DEFAULT_CLIENT_HEAP_MB, Some(61539));
        let jdwp: Vec<&String> = args
            .iter()
            .filter(|a| a.starts_with("-agentlib:jdwp"))
            .collect();
        assert_eq!(jdwp.len(), 1, "JDWP 参数只能有一个：{args:?}");
        assert!(jdwp[0].contains("address=127.0.0.1:61539"), "{jdwp:?}");
        assert!(!jdwp[0].contains("0.0.0.0"), "JDWP 不能敞开给同网段");
        assert!(
            jdwp[0].contains("suspend=n"),
            "suspend=y 会让客户端卡在启动前"
        );
    }

    /// 通配监听地址（`0.0.0.0` / `::`）下客户端应连回环，而不是拿通配地址去 connect。
    #[test]
    fn 客户端端点把通配地址回落成回环() {
        let ep = |addr: Option<&str>, port: u16| crate::nc_home::ServerEndpoints {
            http_port: port,
            http_address: addr.map(str::to_string),
            service_port: None,
            config_path: "ierp/bin/prop.xml".into(),
            from_config: true,
        };
        assert_eq!(
            client_endpoint_host_port(&ep(Some("0.0.0.0"), 8081)),
            ("127.0.0.1".into(), 8081)
        );
        assert_eq!(
            client_endpoint_host_port(&ep(Some("::"), 80)),
            ("127.0.0.1".into(), 80)
        );
        assert_eq!(
            client_endpoint_host_port(&ep(Some("192.168.1.20"), 8081)),
            ("192.168.1.20".into(), 8081)
        );
        assert_eq!(
            client_endpoint_host_port(&ep(None, 80)),
            ("127.0.0.1".into(), 80)
        );
    }

    /// classpath 必须复刻 Eclipse 客户端 provider 的五段顺序，并排除中间件/私有库。
    #[test]
    fn 客户端_classpath_按_eclipse_规则排序并排除中间件() {
        let home = temp_dir("client-cp-home");
        let write = |rel: &str| {
            let p = home.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, b"x").unwrap();
            p
        };
        write("lib/product.jar");
        write("external/lib/ext.jar");
        write("middleware/mw.jar");
        write("framework/fw.jar");
        write("ant/ant.jar");
        write("ejb/ejb.jar");
        write("modules/aa/META-INF/private.jar");
        write("modules/aa/lib/public.jar");
        fs::create_dir_all(home.join("modules").join("aa").join("classes")).unwrap();
        write("modules/aa/client/lib/aa-client.jar");
        write("modules/uapbase/client/lib/uap-client.jar");
        write("modules/zz/client/lib/zz-client.jar");
        write("langlib/lang.jar");

        let project = temp_dir("client-cp-proj");
        let out = project.join("bin");
        fs::create_dir_all(&out).unwrap();

        let cp = client_classpath(&home, std::slice::from_ref(&out), Some("aa"));
        let pos = |needle: &str| {
            cp.iter()
                .position(|p| p.to_string_lossy().replace('\\', "/").ends_with(needle))
                .unwrap_or_else(|| panic!("classpath 缺 {needle}：{cp:?}"))
        };

        assert_eq!(cp.first(), Some(&out), "工程输出目录必须排第一");
        assert!(cp
            .iter()
            .any(|p| p.ends_with("public.jar") && p.to_string_lossy().contains("modules")));
        assert!(
            cp.iter()
                .any(|p| p.ends_with("classes") || p.ends_with("resources")),
            "computeStandCP 的 classes/resources 目录应被收进来：{cp:?}"
        );
        // 五段顺序：产品公共库 → 模块 public → 客户端 client → langlib
        assert!(
            pos("product.jar") < pos("public.jar"),
            "产品公共库先于模块 public"
        );
        assert!(
            pos("ext.jar") < pos("public.jar"),
            "external 同属产品公共库"
        );
        assert!(
            pos("public.jar") < pos("aa-client.jar"),
            "模块 public 先于 client"
        );
        assert!(pos("aa-client.jar") < pos("lang.jar"), "langlib 最后");
        // accessible（uap* / 当前模块）排在其它模块之前
        assert!(pos("aa-client.jar") < pos("uap-client.jar"), "当前模块排前");
        assert!(
            pos("uap-client.jar") < pos("zz-client.jar"),
            "uap* 排在普通模块前"
        );

        let joined = cp
            .iter()
            .map(|p| p.to_string_lossy().to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join("\n");
        for banned in ["middleware", "framework", "ant", "ejb", "meta-inf"] {
            assert!(!joined.contains(banned), "客户端 classpath 不该含 {banned}");
        }
        cleanup(&home);
        cleanup(&project);
    }

    #[test]
    fn 客户端_spec_写清单且工作目录是_nc_home() {
        let home = temp_dir("client-spec-home");
        fs::create_dir_all(home.join("lib")).unwrap();
        fs::write(home.join("lib").join("product.jar"), b"x").unwrap();
        let java = home.join("ufjdk").join("bin").join("java.exe");
        fs::create_dir_all(java.parent().unwrap()).unwrap();
        fs::write(&java, b"stub").unwrap();

        let project = temp_dir("client-spec-proj");
        fs::write(
            project.join(".classpath"),
            "<classpath><classpathentry kind=\"src\" path=\"src\" output=\"bin\"/></classpath>",
        )
        .unwrap();
        fs::create_dir_all(project.join("bin")).unwrap();
        let work = temp_dir("client-spec-work");

        let (spec, entries) = client_spec(
            &home,
            &java,
            &project,
            &work,
            DEFAULT_CLIENT_HEAP_MB,
            None,
            &[],
        )
        .unwrap();
        assert_eq!(spec.main_class, CLIENT_MAIN_CLASS);
        assert_eq!(spec.work_dir, home, "客户端工作目录必须是 NC home");
        assert!(spec.classpath_jar.is_file(), "pathing jar 必须写出来");
        assert!(entries >= 2, "至少应有工程 bin + 产品 jar：{entries}");
        assert!(spec
            .vm_args
            .iter()
            .any(|a| a == "-Dnc.jstart.server=127.0.0.1"));
        cleanup(&home);
        cleanup(&project);
        cleanup(&work);
    }
}
