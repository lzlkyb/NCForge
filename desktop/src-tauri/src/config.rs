//! 应用配置：JSON 文件持久化，落在 `app_config_dir()/config.json`。
//!
//! 为何用 JSON 文件而不是 SQLite：壳子不预设业务需要关系库；JSON 足够表达
//! 「少量键值 + 少量结构化字段」，且省掉 rusqlite(bundled) 的编译时间与体积。
//! 业务真需要数据库时，在此模块旁新增 `db.rs`（参考 cc-bridge 的 rusqlite 用法），
//! 不要把配置也搬进去——配置是启动时第一件要读的东西，越简单越可靠。
//!
//! 硬性规则：
//! - **字段只增不改不删语义**：老版本读新配置时未知字段忽略（serde 默认行为），
//!   所以新增字段必须带 `#[serde(default)]`，否则升级后旧配置文件反序列化直接失败。
//! - 写盘用「临时文件 + rename」：半截配置写坏比没有配置更致命。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 应用配置。字段即「跨重启需要记住的设置」；一次性状态不要放这里。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// 开机自启（与 tauri-plugin-autostart 同步的镜像值，供前端读取）。
    #[serde(default)]
    pub autostart_enabled: bool,
    /// 当前工作区根目录（如 newar 工程）。文件读写只允许落在它之下（见 security::path）。
    #[serde(default)]
    pub workspace_root: Option<String>,
    /// NC 安装目录（NC home）。`None` = 用团队约定的默认位置（见 `nc_home::resolve`）。
    /// 存字符串而不是结构化对象：路径是唯一真源，其余信息（java、模块数）每次现探测，
    /// 免得用户重装/搬目录后配置里留着一份过期的 JDK 路径。
    #[serde(default)]
    pub nc_home: Option<String>,
    /// 中间件堆内存上限（MB）。`None` = 用默认 4G（`launch::DEFAULT_HEAP_MB`）。
    ///
    /// 存 **MB 整数**而不是 `"4G"` 字符串：单位只在前端显示层做换算。存字符串会引入
    /// 一处「谁解析、非法值怎么办」的歧义——手改成 `"4g"`/`"4096"`/`"4G"` 三种写法要
    /// 都认，认错就静默回落成默认值，用户以为改成功了。
    #[serde(default)]
    pub server_heap_mb: Option<u32>,
    /// 客户端（`nc.starter.test.JStarter`）堆上限（MB）。`None` = 默认 768
    /// （Eclipse 启动配置里的值，见 `launch::DEFAULT_CLIENT_HEAP_MB`）。
    ///
    /// 与中间件分开存：客户端只画 Swing 界面，768M 就够；跟着 4G 走纯属浪费。
    #[serde(default)]
    pub client_heap_mb: Option<u32>,
    /// 启动时挂载的 web 应用（`hotwebs/` 下的目录名）。`None` = 默认名单，
    /// 与 Eclipse 启动配置一致（`nccloud,uapws,lfw,portal,fs`，见 `launch::DEFAULT_HOTWEBS`）。
    ///
    /// 为什么要能选：`develop` 模式下 `uap.hotwebs` 是**白名单**，多挂一个目录就多
    /// 初始化一个 Spring 上下文，而它们共用同一条 classpath。实测把 `hotwebs/ncchr`
    /// （HR 插件）一起挂上时，它自带的 spring-data-redis 2.1.6 会去调 Spring 5 的
    /// `Assert.isTrue(boolean, Supplier)`，而 classpath 里排前的是 spring-core 4.3.12
    /// （官方 bootstrap 也是这个顺序）⇒ `NoSuchMethodError`、`Context [/ncchr] startup
    /// failed`。Eclipse 不挂它，所以开发态看不到这条报错。
    #[serde(default)]
    pub hotwebs: Option<Vec<String>>,
    /// SVN 用户名。存在这里是为了「下次不用再输一遍」；密码见下一个字段。
    #[serde(default)]
    pub svn_user: Option<String>,
    /// SVN 密码的 **DPAPI 密文**（base64）。只在本机、本用户下可解，
    /// 换机器/换用户必然解不开——那时按「没存过」处理，让用户重输，不要报错吓人。
    #[serde(default)]
    pub svn_password_dpapi: Option<String>,
    /// 补丁输出目录（「待上线补丁」那个位置）。空 = 用 `patch_defaults` 推导的建议值。
    #[serde(default)]
    pub patch_out_dir: Option<String>,
    /// 编译产物根。空 = 自动探测（`<工作区>/out`，再 `<模块>/classes`）。
    ///
    /// 存成可覆盖的显式字段，是因为这台机器上 Eclipse 编译到 `<根>/out`，而工作台自己的
    /// 编译写到 `<模块>/classes`——两套产物会同时存在，必须能人工指定以哪套为准。
    #[serde(default)]
    pub patch_out_root: Option<String>,
    /// 数据库连接串覆盖（默认从 NC home 的 `ierp/bin/prop.xml` 读）。
    #[serde(default)]
    pub db_url: Option<String>,
    /// 数据库用户名覆盖。
    #[serde(default)]
    pub db_user: Option<String>,
    /// 数据库密码的 DPAPI 密文。旧版单连接配置，首次打开新数据库页时迁进 `db_conns`；
    /// 字段保留不删（降级回老版本还能用）。
    #[serde(default)]
    pub db_password_dpapi: Option<String>,
    /// 数据库页的连接列表（见 `db_conns.rs`）。
    #[serde(default)]
    pub db_conns: Vec<DbConnConfig>,
    /// 最近一次在数据库页用过的连接：表结构缓存、悬停卡片、出包核对都用它。
    #[serde(default)]
    pub db_active: Option<String>,
    /// 连接列表初始化过（迁移旧配置 + 自动导入 prop.xml 只做一次，用户删掉的不再自动加回）。
    #[serde(default)]
    pub db_conns_init: bool,
    /// 代码智能（jdt.ls）总开关。关掉后不起 Java 进程，编辑器退回轻量模式。
    #[serde(default = "default_true")]
    pub lang_enabled: bool,
    /// 打开新模块的 .java 时自动拉起。关掉后要在状态栏手动点「启动」（内存紧张时用）。
    #[serde(default = "default_true")]
    pub lang_auto_start: bool,
    /// jdt.ls 堆上限（MB）。`None` = 默认 1024（见 `lang::DEFAULT_XMX_MB`）。
    #[serde(default)]
    pub lang_xmx_mb: Option<u32>,
    /// 启动服务/编译成功后，把工程模块的 `META-INF/*.upm` 等元数据投送到 NCHOME。
    ///
    /// 默认开：不投送时「改了 upm 不生效」没有任何提示，排查成本远高于多写几百 KB。
    /// 落地失败只记日志、不阻断启动；写过的文件有 manifest + 备份，可在服务页一键清理
    /// （见 `nchome_deploy.rs` 头注释里的安全约束）。
    #[serde(default = "default_true")]
    pub deploy_on_start: bool,
    /// 启动中间件时挂上热替换 agent（默认开，2026-11-06 定）。
    ///
    /// 默认开是因为它只绑 127.0.0.1、要令牌，而且只能把磁盘上 classes 目录里的类换进去，
    /// 不像 JDWP 那样等于远程执行入口。关掉后启动参数里不再出现 `-javaagent`。
    /// 见 `docs/NCForge-热替换-方案设计-2026-11-06.md`。
    #[serde(default = "default_true")]
    pub hotswap_enabled: bool,
    /// 编译成功后自动把类推给运行中的服务（默认开）。关掉 = 手动模式：只攒待推列表，
    /// 由用户点「热替换」（`hotswap_push_pending`）时才推。`hotswap_enabled` 关闭时本项无效。
    #[serde(default = "default_true")]
    pub hotswap_auto: bool,
    /// 保存 `.java` 后自动编译这一个文件（默认开）。
    ///
    /// 默认开是因为这就是用户要的行为（Eclipse 里保存即出 class）；关掉的场景是低配
    /// 机器、或正在做大批量替换嫌它吵。**只编保存的那一个文件**，不是整个模块——
    /// 整模块一次几十秒，绑在保存上等于编辑器卡死。见 `docs/NCForge-自动编译-调研与方案-20261104.md`。
    #[serde(default = "default_true")]
    pub auto_compile: bool,
    /// 保存/外部改动后的「空闲增量」：除编当前文件外，再按 ABI 与反向依赖补齐引用方。
    ///
    /// 单文件编译发现不了签名变更（见 `compile_file` 注释）。默认开：改 public 方法
    /// 参数后不补引用方，运行期才会炸；关掉只影响自动链路，手动「编译本模块」不受影响。
    #[serde(default = "default_true")]
    pub auto_compile_incremental: bool,
    /// 外部 `.java` 改动（SVN 更新、其它编辑器保存）也触发一次自动编译。
    ///
    /// 与「保存当前文件」分开：外部改动往往是一批文件，走模块增量而不是单文件。
    #[serde(default = "default_true")]
    pub auto_compile_external: bool,
    /// 打开工作区后在后台预热类索引（首次冷扫 10~100 秒，预热后第一次保存就能编上）。
    #[serde(default = "default_true")]
    pub prewarm_index: bool,
    /// 复用常驻 ecj JVM（默认开）。
    ///
    /// 一次一进程每次要付 0.6~0.9 秒的 JVM 启动；常驻后同一条命令 30~50 毫秒。
    /// 关掉的场景：内存紧张、或怀疑常驻进程状态异常要对照排查——关掉后行为与加常驻之前
    /// 完全一致（见 `ecj_worker` 的回退语义）。
    #[serde(default = "default_true")]
    pub persistent_worker: bool,
    /// 独立模块编译的并行上限。1 = 串行，默认 2。
    ///
    /// 不按 CPU 核数放开：开发机有过重负载蓝屏记录（见项目记忆），
    /// 两个模块同时跑 ecj 已能明显缩短 `compile_all`，更多收益递减。
    #[serde(default = "default_parallel")]
    pub build_parallel: u8,
    /// 工程关联的覆盖表（见 `eclipse_cp::LinkedOverride`）。
    ///
    /// 为什么要有它：依赖顺序的真源是 `.classpath`（那是 Eclipse 写的），但真实工作里
    /// 需要三种「不改 Eclipse 配置也能验证」的调整——把某个关联工程停掉看还编不编得过、
    /// 把某个工程排到别的依赖前面、手工补一个不在任何工程里的产物目录。
    /// 空表 = 完全按 `.classpath`（默认行为，与加这个字段之前一致）。
    #[serde(default)]
    pub linked_overrides: Vec<LinkedOverrideConfig>,
}

/// 一条工程关联覆盖。
///
/// `action` 存字符串而不是枚举：与 `DbConnConfig::engine` 同一口径——老配置没有这个
/// 字段时反序列化出空串，识别不了就跳过该条，不需要写迁移代码。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkedOverrideConfig {
    /// `disable`（停用）/ `front`（排前）/ `add`（追加目录）
    #[serde(default)]
    pub action: String,
    /// 工程名（`.classpath` 里 `/X` 的写法）或工程根绝对路径；`add` 时留空
    #[serde(default)]
    pub target: String,
    /// 仅 `add` 使用：类目录或 jar 的绝对路径
    #[serde(default)]
    pub dir: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_parallel() -> u8 {
    2
}

/// 一条数据库连接。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbConnConfig {
    pub id: String,
    pub name: String,
    /// `dev` / `test` / `prod` / `other`：只决定颜色与「生产库写前确认」，不限制权限。
    #[serde(default)]
    pub env: String,
    /// `manual`（手动填写 / 导入 .properties）或 `prop`（NC prop.xml 的数据源）。
    pub source: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub user: String,
    /// `prop` 来源的数据源名（口令每次由 NC 的 PropXMLReader 现解，不存）。
    #[serde(default)]
    pub prop_ds: Option<String>,
    /// 手动来源的口令 DPAPI 密文（base64）。
    #[serde(default)]
    pub password_dpapi: Option<String>,
    /// 默认事务模式：`false` = 手动提交。
    #[serde(default)]
    pub auto_commit: bool,
    /// 执行引擎：`java`（默认，常驻 JVM + JDBC）或 `rust`（纯 Rust 驱动）。
    ///
    /// 存字符串而不是枚举：老配置里没有这个字段，反序列化出空串即按 `java` 处理，
    /// 不用写迁移代码。识别见 `db_engine::EngineKind::parse`。
    ///
    /// **这是连接级属性**，不是全局开关：同一台机器上可能一个库要解 prop.xml 口令
    /// （只能 JVM）、另一个库在慢网段上要省内存（选 Rust）。
    #[serde(default)]
    pub engine: String,
    /// 来源说明（界面显示「导入 xxx.properties」之类）。
    #[serde(default)]
    pub note: String,
    /// 默认 schema：连上后立刻 `alter session set current_schema`，写 SQL 不用带 `aier633.` 前缀。
    ///
    /// **空串 = 不切**（用登录账号自己的 schema）。存字符串而不是 `Option<String>`：
    /// 老配置里没有这个字段，反序列化出空串正好就是「不切」，不用写迁移。
    ///
    /// 注意它只影响**不带前缀的名字解析**，不改变权限：查询别人 schema 的表仍然需要
    /// 那个账号给了 SELECT。`alter session` 是会话控制语句，不会隐式提交当前事务。
    #[serde(default)]
    pub default_schema: String,
    /// 关掉纯 Rust 驱动的**语句缓存**（`true` = 不缓存预处理语句）。
    ///
    /// 只对 Rust 引擎有意义：JVM 桥用的是 oracle JDBC，它的隐式语句缓存默认就是关的。
    ///
    /// **为什么给这个开关**：Oracle 有一个官方也承认、只做了 workaround 的老问题——
    /// 语句缓存里存着 describe info（列定义），表结构变过（加列 / 改类型 / DROP 后重建同名表）
    /// 之后同一条 SQL 命中旧 slot，服务端按新结构回行、客户端按旧结构解析，字节流就错位了，
    /// 报 `unknown TTC message type N at packet 1, offset …`。python-oracledb 维护者给用户的
    /// 建议就是「把语句缓存设成 0」。默认关着这个开关（= 用缓存）：缓存对宽表分页查询的
    /// 收益很明显，只在错位反复出现时按库关掉，用每条语句重新 parse 换彻底稳定。
    ///
    /// 改它要重连才生效（缓存大小是建连接时定死的），见 `db_rust::RustEngine::connect`。
    #[serde(default)]
    pub no_stmt_cache: bool,
    /// 分组名：侧栏按它把连接折成一类（如「客户 A 生产」「测试环境」）。空串 = 未分组。
    ///
    /// 纯显示属性，不参与连接与权限判断。用空串而不是 `Option<String>`：老配置里没有这个
    /// 字段，反序列化出空串正好就是「未分组」，不用写迁移。
    ///
    /// 只有分组名是自由文本，**颜色不做自由文本**：见 `db_conns::normalize_color`，
    /// 它限定在一小组语义色里，避免把用户输入当成 CSS 值直接拼进样式。
    #[serde(default)]
    pub group: String,
    /// 颜色标记：`db_conns::CONN_COLORS` 里的一个键，空串 = 不标记（跟随环境色）。
    ///
    /// 前端只把这个值当 `data-color` 枚举用，样式表里逐个定义，绝不把它的内容拼进颜色值。
    #[serde(default)]
    pub color: String,
}

impl AppConfig {
    /// 抹掉口令密文，供 `get_config` / `patch_config` 回给前端。
    ///
    /// DPAPI 密文虽然换机器/换用户就解不开，但把它一并发给前端没有任何好处：
    /// 前端没有任何地方消费这两个字段，而 IPC 桥对面是整个 webview——多一跳
    /// 就多一分泄露面（devtools、崩溃转储、被投毒的依赖库都能看见）。
    /// 有值 ⇒ `Some(REDACTED)`，没值 ⇒ `None`：「设没设过」的信息不丢，
    /// 密文本身不过桥。Rust 内部一律走 `state.config` 直读，不经这条出口。
    pub fn redacted(mut self) -> Self {
        const REDACTED: &str = "«dpapi-密文不过桥»";
        if self.svn_password_dpapi.is_some() {
            self.svn_password_dpapi = Some(REDACTED.to_string());
        }
        if self.db_password_dpapi.is_some() {
            self.db_password_dpapi = Some(REDACTED.to_string());
        }
        for c in &mut self.db_conns {
            if c.password_dpapi.is_some() {
                c.password_dpapi = Some(REDACTED.to_string());
            }
        }
        self
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            autostart_enabled: false,
            workspace_root: None,
            nc_home: None,
            server_heap_mb: None,
            client_heap_mb: None,
            hotwebs: None,
            svn_user: None,
            svn_password_dpapi: None,
            patch_out_dir: None,
            patch_out_root: None,
            db_url: None,
            db_user: None,
            db_password_dpapi: None,
            db_conns: Vec::new(),
            db_active: None,
            db_conns_init: false,
            lang_enabled: true,
            lang_auto_start: true,
            lang_xmx_mb: None,
            deploy_on_start: true,
            hotswap_enabled: true,
            hotswap_auto: true,
            auto_compile: true,
            auto_compile_incremental: true,
            auto_compile_external: true,
            prewarm_index: true,
            persistent_worker: true,
            build_parallel: 2,
            linked_overrides: Vec::new(),
        }
    }
}

/// 配置文件路径：`{config_dir}/config.json`。
pub fn config_path(config_dir: &std::path::Path) -> PathBuf {
    config_dir.join("config.json")
}

/// 读配置；文件不存在或损坏时回落默认值（损坏时留警告，不静默）。
pub fn load_config(config_dir: &std::path::Path) -> AppConfig {
    let path = config_path(config_dir);
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<AppConfig>(&text) {
            Ok(cfg) => cfg,
            Err(e) => {
                log::warn!("配置文件损坏，使用默认值（{path:?}: {e}）");
                AppConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AppConfig::default(),
        Err(e) => {
            log::warn!("读取配置失败，使用默认值（{path:?}: {e}）");
            AppConfig::default()
        }
    }
}

/// 写配置：先写临时文件再 rename，避免半截文件。
///
/// 临时文件名带**进程 id + 进程内自增序号**，不用固定的 `config.json.tmp`：
/// 固定名下两个并发的 save_config（前端连点两次开关就会发生）会互相覆盖对方的
/// 半截内容，且 rename 时序错乱时可能把空/坏文件换成正式配置——「读起来还是
/// 默认值，但用户明明改过」这种灵异故障就是这么来的。写失败时清掉残骸，
/// 不在配置目录留 `.tmp` 垃圾。
pub fn save_config(config_dir: &std::path::Path, cfg: &AppConfig) -> Result<(), String> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);

    let path = config_path(config_dir);
    let tmp = config_dir.join(format!(
        "config.json.{}.{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let text = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化配置失败: {e}"))?;
    let write_result = std::fs::write(&tmp, text).map_err(|e| format!("写临时配置失败: {e}"));
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp); // 清残骸（可能压根没写进去）
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp); // rename 失败（跨卷/权限），别留垃圾
        return Err(format!("替换配置失败: {e}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 口令密文不过 IPC 桥：有值抹成占位符（「设没设过」的信息不丢），没值保持 None。
    #[test]
    fn redacted_masks_dpapi_but_keeps_presence() {
        let mut cfg = AppConfig::default();
        assert!(cfg.clone().redacted().svn_password_dpapi.is_none());
        assert!(cfg.clone().redacted().db_password_dpapi.is_none());

        cfg.svn_password_dpapi = Some("AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA".to_string());
        cfg.db_password_dpapi = Some("AQAAANCMnd8BFdERjHoAwE/Cl+sB9999".to_string());
        let r = cfg.clone().redacted();
        // 占位符不是密文：任何一段真密文都不该出现在出口
        for field in [&r.svn_password_dpapi, &r.db_password_dpapi] {
            let v = field.as_ref().expect("有值应保留 Some");
            assert!(!v.starts_with("AQAA"), "密文不该过桥: {v}");
            assert!(v.len() < 32, "占位符不该像密文那么长: {v}");
        }
        // 其余字段原样（redacted 只碰两个口令字段）
        assert_eq!(r.svn_user, cfg.svn_user);
        assert_eq!(r.workspace_root, cfg.workspace_root);
    }

    /// 常驻 ecj worker 默认开；老配置文件里没有这个键时也必须是开——
    /// 否则升级后用户会在不知情的情况下退回每次起 JVM。
    #[test]
    fn persistent_worker_defaults_on() {
        assert!(AppConfig::default().persistent_worker);
        let mut v = serde_json::to_value(AppConfig::default()).unwrap();
        v.as_object_mut().unwrap().remove("persistent_worker");
        let cfg: AppConfig = serde_json::from_value(v).unwrap();
        assert!(cfg.persistent_worker);
    }
}
