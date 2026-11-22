//! 启动配置库：把「服务 / 客户端 / Java 运行」的一次启动要素存成命名配置。
//!
//! ## 为什么需要它
//!
//! Eclipse 的 `.launch` 文件回答的是「这一把要怎么起」：调试开不开、堆多大、挂哪几个
//! web 应用、跑哪个 main。我们此前只有一份全局配置（`config.json` 的
//! `server_heap_mb` / `hotwebs` / `client_heap_mb`），切一种起法就得改一遍全局配置、
//! 起完再改回来。开发机上常见的两三套起法（日常带调试、压测关调试换大堆、只挂一个
//! 前端）因此互相覆盖。
//!
//! ## 存放位置与理由
//!
//! `<工程根>/.ncforge/launches.json`：
//! - 与 `manifest.xml` 同级的「工程自己的文件」，跟着 SVN 走 ⇒ 同事 clone 下来就有
//!   同一套起法（这是 `.launch` 在工作区里最被珍视的性质）；
//! - **不放 config_dir**：那是本机配置（换台机器就没有），而起法属于工程；
//! - `.ncforge/` 目录在目录树里隐藏（见 `workspace::is_hidden_entry`），与
//!   `.settings` / `.nc-compile` 同一类——工具自己维护，不占树上一行。
//!
//! ## 与全局配置的关系
//!
//! 配置里的每个可选项都是 `Option`：`None` = 跟随全局配置。于是「不选任何配置」=
//! 今天的行为，一条回归路径都不用改；选一个配置 = 只覆盖它写了的项。启动参数在
//! `server_start` / `client_start` 里现算，**不写回** `AppConfig`——「改配置不改变
//! 在跑 JVM，也不改变下次默认启动」这条语义必须保持。
//!
//! ## 损坏处理
//!
//! 文件是给人手改的（SVN 合并冲突尤其常见），所以读取时**逐条**校验：坏的那条跳过
//! 并给一句说明，好的照常可用。整份写不进去（JSON 烂尾）时按空配置处理——启动配置
//! 不该成为「服务起不来」的原因。

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 工程根下放启动配置的目录名。
pub const CONFIG_DIR: &str = ".ncforge";
/// 配置文件名。
pub const CONFIG_FILE: &str = "launches.json";
/// 文件格式版本。只增不减：老版本读新文件时忽略不认识的字段（serde 默认行为）。
pub const FILE_VERSION: u32 = 1;
/// 配置数量上限。再多就该用文件夹/命名约定了，下拉框也放不下。
pub const MAX_CONFIGS: usize = 50;
/// 配置名长度上限（字符）。
pub const MAX_NAME_CHARS: usize = 60;
/// 名单类字段（hotwebs / classes / args / extraClasspath）的条目数上限。
pub const MAX_ENTRIES: usize = 64;
/// 单条文本类字段的长度上限（字符）。
pub const MAX_TEXT_CHARS: usize = 1024;
/// id 的长度与字符集上限（后端生成，也允许前端带自己的）。
pub const MAX_ID_CHARS: usize = 64;

/// 中间件目标的可调项。
///
/// `heap_mb` / `hotwebs` 都是 `Option`：`None` = 用全局配置的值（与「默认」一致）。
/// 写 `Some` 时只在**这一次启动**里生效，不落 `config.json`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MiddlewareOptions {
    pub heap_mb: Option<u32>,
    /// `None` = 默认名单（与 Eclipse 一致的 5 个）；`Some` = 显式名单，
    /// 启动时仍按 NC home 里真实存在的目录过滤（`launch::hotwebs_names`）。
    pub hotwebs: Option<Vec<String>>,
    /// 起 JVM 时挂 JDWP（只绑 127.0.0.1，端口由系统分配）。
    pub debug: bool,
}

/// 客户端目标的可调项。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientOptions {
    pub heap_mb: Option<u32>,
    pub debug: bool,
}

/// Java 运行目标：与 `java_run::JavaRunRequest` 同构，只是少了 `id` 与 `coverage`
/// 之外还保留 `coverage`（覆盖率是「这一把怎么跑」的一部分，该记住）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JavaOptions {
    /// 源码文件或模块目录（工程内绝对路径，与运行面板当前填写的一致）。
    pub path: String,
    /// `main` | `test`。
    pub mode: String,
    /// main = 单个完整类名；test = 每行一个 `类名` 或 `类名#方法名`。
    pub classes: Vec<String>,
    /// 程序参数，每行一个完整参数（与面板一致，不拆词）。
    pub args: Vec<String>,
    /// 额外类路径，每行一个 JAR 或目录。
    pub extra_classpath: Vec<String>,
    pub debug: bool,
    pub coverage: bool,
}

impl Default for JavaOptions {
    fn default() -> Self {
        Self {
            path: String::new(),
            mode: "main".into(),
            classes: Vec::new(),
            args: Vec::new(),
            extra_classpath: Vec::new(),
            debug: false,
            coverage: false,
        }
    }
}

/// 三类启动目标。
///
/// 内部标签（`kind`）而不是平铺在一个结构里：三类可调项差别很大（服务有 hotwebs、
/// Java 运行有类名），平铺会让「客户端的配置里出现 classes 字段」这种事靠约定维持。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LaunchTarget {
    Middleware(MiddlewareOptions),
    Client(ClientOptions),
    Java(JavaOptions),
}

impl LaunchTarget {
    /// 下拉框与徽章用的目标名。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Middleware(_) => "中间件",
            Self::Client(_) => "客户端",
            Self::Java(_) => "Java 运行",
        }
    }
}

/// 一条启动配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    /// 空串 = 新建（保存时后端分配）。delete / duplicate 按它引用。
    #[serde(default)]
    pub id: String,
    /// 显示名。同文件内不允许重名（忽略大小写）。
    pub name: String,
    pub target: LaunchTarget,
}

/// 整份文件。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchConfigFile {
    pub version: u32,
    pub configs: Vec<LaunchConfig>,
}

impl LaunchConfigFile {
    /// 新文件。`Default` 给的是 version 0（serde 要求），这里补成当前版本。
    pub fn new() -> Self {
        Self {
            version: FILE_VERSION,
            configs: Vec::new(),
        }
    }
}

// 这里**故意没有** `effective_heap_mb` / `effective_hotwebs` 之类的「生效值」方法：
// 覆盖链是「前端从选中配置取原值 → 作为 server_start/client_start 的 heap_mb/hotwebs
// 参数传来 → 命令层 `heap_mb.or(全局值)` 组合 → `launch::effective_*` 夹边」，
// 后端全程不直接见 LaunchConfig 对象。在结构体上再包一层只会多一条没人走的路径
// （曾经有过，只有测试调用，已删——测试还会造成「组合逻辑有覆盖」的假象）。

/// `<工程根>/.ncforge/launches.json`。
pub fn config_path(root: &Path) -> std::path::PathBuf {
    root.join(CONFIG_DIR).join(CONFIG_FILE)
}

/// 读配置。文件不存在 / 不是合法 JSON 时按空配置处理（附带一句说明）。
///
/// 逐条校验而不是整份判决：SVN 合并常把文件搅成「两条冲突标记夹一段合法 JSON」，
/// 那时至少要把没被冲突波及的配置还给用户。
pub fn load_with_notes(root: &Path) -> (LaunchConfigFile, Vec<String>) {
    let mut notes = Vec::new();
    let bytes = match std::fs::read(config_path(root)) {
        Ok(b) => b,
        Err(_) => return (LaunchConfigFile::new(), notes),
    };
    // 手改过的文件可能带 BOM；UTF-8 之外按 UTF-8 宽松解析（我们只会写 UTF-8）。
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    let file: LaunchConfigFile = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(e) => {
            notes.push(format!(
                "启动配置文件损坏，本次按「没有配置」处理（{CONFIG_FILE}：{e}）"
            ));
            return (LaunchConfigFile::new(), notes);
        }
    };
    let mut kept: Vec<LaunchConfig> = Vec::new();
    for config in file.configs {
        match validate(&config) {
            Ok(()) => {
                if kept.iter().any(|c| c.id == config.id) {
                    notes.push(format!("启动配置「{}」id 重复，已保留前一条", config.name));
                    continue;
                }
                if kept
                    .iter()
                    .any(|c| c.name.eq_ignore_ascii_case(&config.name))
                {
                    notes.push(format!("启动配置「{}」重名，已保留前一条", config.name));
                    continue;
                }
                kept.push(config);
            }
            Err(e) => notes.push(format!("启动配置「{}」不可用：{e}", config.name)),
        }
    }
    if kept.len() > MAX_CONFIGS {
        notes.push(format!(
            "启动配置超过 {MAX_CONFIGS} 个，仅保留前 {MAX_CONFIGS} 个"
        ));
        kept.truncate(MAX_CONFIGS);
    }
    (
        LaunchConfigFile {
            version: FILE_VERSION,
            configs: kept,
        },
        notes,
    )
}

/// 读配置（不要说明时用这个）。
pub fn load(root: &Path) -> LaunchConfigFile {
    load_with_notes(root).0
}

/// 整份写回。**先校验再落盘**：写进去的必须是自洽的文件，否则下次读又要跳过一批。
///
/// 落盘走 `atomic_file::write_atomic`（同目录临时文件 + rename + 目录项刷盘），
/// 与保存配置、写文件同一套语义：不会出现半个文件。
pub fn save(root: &Path, file: &LaunchConfigFile) -> Result<(), String> {
    validate_file(file)?;
    let path = config_path(root);
    let dir = path
        .parent()
        .ok_or_else(|| "启动配置路径没有上级目录".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建 {CONFIG_DIR} 目录失败: {e}"))?;
    let json =
        serde_json::to_string_pretty(file).map_err(|e| format!("启动配置序列化失败: {e}"))?;
    // 末尾换行：手改与 SVN diff 都舒服
    crate::atomic_file::write_atomic(&path, format!("{json}\n").as_bytes())
}

/// 新增或更新一条（按 id；id 为空串 = 新建）。返回**入库的那份**（含分配的 id）。
///
/// 归一化在这里做（trim、名单去重），存进去的就是校验过的形态——读取时再校验只是
/// 为了兜住手改，正常运行路径上两份校验必须给出同一个结果。
pub fn upsert(
    file: &mut LaunchConfigFile,
    mut config: LaunchConfig,
) -> Result<LaunchConfig, String> {
    normalize(&mut config);
    validate(&config)?;
    // 空 id = 新建，先分配再比重名：否则「两条都还没 id」会被当成同一条互相顶掉
    if config.id.is_empty() {
        config.id = fresh_id(file);
    }
    if file
        .configs
        .iter()
        .any(|c| c.id != config.id && c.name.eq_ignore_ascii_case(&config.name))
    {
        return Err(format!("已存在同名配置「{}」，换个名字", config.name));
    }
    match file.configs.iter().position(|c| c.id == config.id) {
        Some(i) => file.configs[i] = config.clone(),
        None => {
            if file.configs.len() >= MAX_CONFIGS {
                return Err(format!("启动配置最多 {MAX_CONFIGS} 个，先删掉不用的"));
            }
            file.configs.push(config.clone());
        }
    }
    Ok(config)
}

/// 复制一条，插在原件后面，名字加「副本」后缀（重名则递加数字）。
pub fn duplicate(file: &mut LaunchConfigFile, id: &str) -> Result<LaunchConfig, String> {
    let index = file
        .configs
        .iter()
        .position(|c| c.id == id)
        .ok_or_else(|| "配置不存在或已被删除".to_string())?;
    let mut copy = file.configs[index].clone();
    copy.id = fresh_id(file);
    let base = copy.name.trim().to_string();
    let mut name = format!("{base} 副本");
    let mut seq = 2;
    while file
        .configs
        .iter()
        .any(|c| c.name.eq_ignore_ascii_case(&name))
    {
        name = format!("{base} 副本 {seq}");
        seq += 1;
    }
    copy.name = name;
    file.configs.insert(index + 1, copy.clone());
    Ok(copy)
}

/// 删除一条。幂等性由命令层决定，这里「没删到」算错误（UI 该提示，不该静默）。
pub fn remove(file: &mut LaunchConfigFile, id: &str) -> Result<(), String> {
    let before = file.configs.len();
    file.configs.retain(|c| c.id != id);
    if file.configs.len() == before {
        return Err("配置不存在或已被删除".to_string());
    }
    Ok(())
}

/// 校验整份文件（写盘前调用）。
pub fn validate_file(file: &LaunchConfigFile) -> Result<(), String> {
    if file.configs.len() > MAX_CONFIGS {
        return Err(format!("启动配置最多 {MAX_CONFIGS} 个"));
    }
    for (i, c) in file.configs.iter().enumerate() {
        validate(c).map_err(|e| format!("第 {} 个配置（{}）：{e}", i + 1, c.name))?;
    }
    for (i, c) in file.configs.iter().enumerate() {
        for other in &file.configs[i + 1..] {
            if c.id == other.id {
                return Err(format!("配置 id 重复：{}", c.id));
            }
            if c.name.eq_ignore_ascii_case(&other.name) {
                return Err(format!("配置名重复：{}", c.name));
            }
        }
    }
    Ok(())
}

/// 校验单条。错误文案直接给用户看，所以每条都写清「怎么改」。
pub fn validate(config: &LaunchConfig) -> Result<(), String> {
    let name = config.name.trim();
    if name.is_empty() {
        return Err("配置名不能为空".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("配置名最长 {MAX_NAME_CHARS} 个字符"));
    }
    let id = config.id.trim();
    if !id.is_empty()
        && (id.chars().count() > MAX_ID_CHARS
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Err("配置 id 含非法字符（只允许字母、数字、-、_）".into());
    }
    match &config.target {
        LaunchTarget::Middleware(m) => {
            // 复用服务启动的同一条规则：文案只有一处，边界不会两处漂移
            crate::launch::validate_heap_mb(m.heap_mb)?;
            validate_hotwebs(m.hotwebs.as_deref())?;
        }
        LaunchTarget::Client(c) => crate::launch::validate_heap_mb(c.heap_mb)?,
        LaunchTarget::Java(j) => validate_java(j)?,
    }
    Ok(())
}

/// web 应用名单：非空、合法目录名、不重复。
///
/// 目录名判据不是洁癖：这些名字会用逗号拼进 `-Duap.hotwebs`，也会被当作
/// `hotwebs/` 下的子目录名去初始化。写了个带逗号或斜杠的名字，Tomcat 那一侧
/// 只会静静地少挂一个前端，极难回头查。
///
/// 公开是因为 `server_start` 的覆盖参数也要走同一条校验（启动配置与界面手填
/// 必须是同一份规则）。
pub fn validate_hotwebs(list: Option<&[String]>) -> Result<(), String> {
    let Some(list) = list else { return Ok(()) };
    if list.len() > MAX_ENTRIES {
        return Err(format!("web 应用最多 {MAX_ENTRIES} 个"));
    }
    let mut seen: Vec<&str> = Vec::new();
    for raw in list {
        let name = raw.trim();
        if name.is_empty() {
            return Err("web 应用名单里不能有空条目".into());
        }
        if name.chars().count() > MAX_TEXT_CHARS {
            return Err("web 应用名过长".into());
        }
        if name.contains(',')
            || name.contains('/')
            || name.contains('\\')
            || name.contains("..")
            || name.chars().any(|c| c.is_control())
        {
            return Err(format!(
                "「{name}」不是合法的 web 应用名（不能含逗号、斜杠或路径符号）"
            ));
        }
        if seen.iter().any(|s| s.eq_ignore_ascii_case(name)) {
            return Err(format!("web 应用「{name}」重复"));
        }
        seen.push(name);
    }
    Ok(())
}

/// Java 运行目标：路径、方式、类名都要能原样交给 `java_run`。
fn validate_java(j: &JavaOptions) -> Result<(), String> {
    let path = j.path.trim();
    if path.is_empty() {
        return Err("Java 运行配置要有源码或模块路径".into());
    }
    if path.chars().count() > MAX_TEXT_CHARS {
        return Err("源码或模块路径过长".into());
    }
    if path.chars().any(|c| c.is_control()) {
        return Err("源码或模块路径含非法字符".into());
    }
    match j.mode.trim() {
        "main" | "test" => {}
        _ => return Err("运行方式只能是 main 或 test".into()),
    }
    let classes: Vec<&str> = j
        .classes
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if classes.is_empty() {
        return Err("至少要有一个类名（或 类名#方法名）".into());
    }
    if classes.len() > MAX_ENTRIES {
        return Err(format!("类名最多 {MAX_ENTRIES} 个"));
    }
    for class in &classes {
        // 完整类名 + `#方法名`；`$` 是内部类的二进制名分隔符
        if !class
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '.' | '#'))
        {
            return Err(format!(
                "「{class}」不是合法的类名（只允许字母、数字、.、#、$、_）"
            ));
        }
    }
    if j.mode.trim() == "main" && classes.len() != 1 {
        return Err("main 方式只能有一个主类".into());
    }
    validate_lines(&j.args, "程序参数")?;
    validate_lines(&j.extra_classpath, "额外类路径")?;
    Ok(())
}

/// 每行一个参数的字段：非空条目、条数与长度上限。
fn validate_lines(list: &[String], field: &str) -> Result<(), String> {
    if list.len() > MAX_ENTRIES {
        return Err(format!("{field}最多 {MAX_ENTRIES} 条"));
    }
    for raw in list {
        let line = raw.trim();
        if line.is_empty() {
            return Err(format!("{field}里不能有空行"));
        }
        if line.chars().count() > MAX_TEXT_CHARS {
            return Err(format!("{field}单条过长"));
        }
        if line.chars().any(|c| c.is_control()) {
            return Err(format!("{field}含非法字符"));
        }
    }
    Ok(())
}

/// 归一化：trim 名字与 id、名单去空白去重。**不改变语义**（空条目本来就会被过滤）。
fn normalize(config: &mut LaunchConfig) {
    config.id = config.id.trim().to_string();
    config.name = config.name.trim().to_string();
    match &mut config.target {
        LaunchTarget::Middleware(m) => {
            if let Some(list) = m.hotwebs.as_mut() {
                dedup_trim(list);
            }
        }
        LaunchTarget::Client(_) => {}
        LaunchTarget::Java(j) => {
            j.path = j.path.trim().to_string();
            j.mode = j.mode.trim().to_string();
            dedup_trim(&mut j.classes);
            dedup_trim(&mut j.args);
            dedup_trim(&mut j.extra_classpath);
        }
    }
}

fn dedup_trim(list: &mut Vec<String>) {
    let mut out: Vec<String> = Vec::new();
    for raw in list.drain(..) {
        let v = raw.trim().to_string();
        if !v.is_empty() && !out.contains(&v) {
            out.push(v);
        }
    }
    *list = out;
}

/// 生成一个文件内唯一的 id：`lc-<毫秒十六进制>-<进程内序号>`。
///
/// 不用 uuid crate：id 只需要在**这一个文件**里唯一（delete / duplicate 的引用键），
/// 时间戳 + 单出让它在同一台机器上不可能撞；跨机器合并同一文件时，SVN 冲突会显式
/// 暴露重名，那时用户改名即可。
static ID_SEQ: AtomicU64 = AtomicU64::new(0);

fn fresh_id(file: &LaunchConfigFile) -> String {
    for _ in 0..8 {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let seq = ID_SEQ.fetch_add(1, Ordering::Relaxed);
        let id = format!("lc-{ms:x}-{seq:x}");
        if !file.configs.iter().any(|c| c.id == id) {
            return id;
        }
    }
    // 理论上到不了；兜底加长随机尾巴
    format!("lc-{}-x", ID_SEQ.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(tag: &str) -> std::path::PathBuf {
        crate::test_support::tmp(tag)
    }

    fn middleware(name: &str) -> LaunchConfig {
        LaunchConfig {
            id: String::new(),
            name: name.into(),
            target: LaunchTarget::Middleware(MiddlewareOptions {
                heap_mb: Some(8192),
                hotwebs: Some(vec!["nccloud".into(), "portal".into()]),
                debug: true,
            }),
        }
    }

    fn java(name: &str) -> LaunchConfig {
        LaunchConfig {
            id: String::new(),
            name: name.into(),
            target: LaunchTarget::Java(JavaOptions {
                path: r"D:\newar\gl\src\public\nc\demo\PriceTest.java".into(),
                mode: "test".into(),
                classes: vec!["nc.demo.PriceTest#testPrice".into()],
                args: vec![],
                extra_classpath: vec![r"D:\libs\extra.jar".into()],
                debug: false,
                coverage: true,
            }),
        }
    }

    #[test]
    fn 空目录读出来是空配置() {
        let f = load(&root("lc-empty"));
        assert_eq!(f, LaunchConfigFile::new());
    }

    #[test]
    fn 往返读写保持数据() {
        let root = root("lc-roundtrip");
        let mut file = LaunchConfigFile::new();
        let saved = upsert(&mut file, middleware("日常带调试")).unwrap();
        upsert(&mut file, java("跑价格测试")).unwrap();
        save(&root, &file).unwrap();

        let back = load(&root);
        assert_eq!(back.configs.len(), 2);
        assert_eq!(back.configs[0].id, saved.id, "保存要回填分配的 id");
        assert_eq!(back.configs[0].name, "日常带调试");
        assert_eq!(
            back.configs[0].target,
            LaunchTarget::Middleware(MiddlewareOptions {
                heap_mb: Some(8192),
                hotwebs: Some(vec!["nccloud".into(), "portal".into()]),
                debug: true,
            })
        );
        assert_eq!(back.configs[1].target.label(), "Java 运行");
    }

    #[test]
    fn 文件损坏按空配置并给出说明() {
        let root = root("lc-broken");
        std::fs::create_dir_all(root.join(CONFIG_DIR)).unwrap();
        std::fs::write(config_path(&root), "{ 这不是 json".as_bytes()).unwrap();
        let (file, notes) = load_with_notes(&root);
        assert!(file.configs.is_empty());
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("损坏"), "{}", notes[0]);
    }

    #[test]
    fn 坏条目被跳好好条目保留() {
        let root = root("lc-partial");
        let mut file = LaunchConfigFile::new();
        upsert(&mut file, middleware("好的")).unwrap();
        // 第二条留空名字：写盘时会被 validate_file 拦下，所以手改文件来模拟
        let mut bad = middleware("");
        bad.id = "lc-bad".into();
        file.configs.push(bad);
        std::fs::create_dir_all(root.join(CONFIG_DIR)).unwrap();
        let json = serde_json::to_string_pretty(&file).unwrap();
        std::fs::write(config_path(&root), json).unwrap();

        let (back, notes) = load_with_notes(&root);
        assert_eq!(back.configs.len(), 1);
        assert_eq!(back.configs[0].name, "好的");
        assert!(notes.iter().any(|n| n.contains("不可用")), "{notes:?}");
    }

    #[test]
    fn 重名与坏字段都被拦下() {
        let mut file = LaunchConfigFile::new();
        let first = upsert(&mut file, middleware("同一套")).unwrap();
        assert!(
            upsert(&mut file, middleware("同一套")).is_err(),
            "重名要报错"
        );
        // 同 id 更新不算重名
        assert!(upsert(&mut file, {
            let mut c = middleware("同一套");
            c.id = first.id.clone();
            c
        })
        .is_ok());

        assert!(upsert(&mut file, middleware("")).is_err(), "空名字要报错");
        assert!(
            upsert(
                &mut file,
                LaunchConfig {
                    id: String::new(),
                    name: "堆超标".into(),
                    target: LaunchTarget::Middleware(MiddlewareOptions {
                        heap_mb: Some(70000),
                        ..Default::default()
                    }),
                }
            )
            .is_err(),
            "堆越界要报错（复用 launch::validate_heap_mb）"
        );
        assert!(
            upsert(
                &mut file,
                LaunchConfig {
                    id: String::new(),
                    name: "web 名带逗号".into(),
                    target: LaunchTarget::Middleware(MiddlewareOptions {
                        hotwebs: Some(vec!["a,b".into()]),
                        ..Default::default()
                    }),
                }
            )
            .is_err(),
            "逗号会拆散 -Duap.hotwebs"
        );
        assert!(
            upsert(
                &mut file,
                LaunchConfig {
                    id: String::new(),
                    name: "main 两个类".into(),
                    target: LaunchTarget::Java(JavaOptions {
                        path: "D:\\newar\\gl".into(),
                        classes: vec!["a.B".into(), "c.D".into()],
                        ..Default::default()
                    }),
                }
            )
            .is_err(),
            "main 只能有一个主类"
        );
    }

    #[test]
    fn 归一化会去空白与重复() {
        let mut file = LaunchConfigFile::new();
        let saved = upsert(
            &mut file,
            LaunchConfig {
                id: String::new(),
                name: "  名字  ".into(),
                target: LaunchTarget::Middleware(MiddlewareOptions {
                    heap_mb: None,
                    hotwebs: Some(vec![" nccloud ".into(), "nccloud".into(), "  ".into()]),
                    debug: false,
                }),
            },
        )
        .unwrap();
        assert_eq!(saved.name, "名字");
        match &saved.target {
            LaunchTarget::Middleware(m) => {
                assert_eq!(m.hotwebs.as_deref(), Some(&["nccloud".to_string()][..]));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn 复制插在原件后面且改名() {
        let mut file = LaunchConfigFile::new();
        let one = upsert(&mut file, middleware("A")).unwrap();
        let copy = duplicate(&mut file, &one.id).unwrap();
        assert_ne!(copy.id, one.id);
        assert_eq!(copy.name, "A 副本");
        assert_eq!(file.configs[1].id, copy.id, "副本应紧挨原件");
        let copy2 = duplicate(&mut file, &one.id).unwrap();
        assert_eq!(copy2.name, "A 副本 2");
        assert!(remove(&mut file, "不存在的id").is_err());
        assert!(remove(&mut file, &one.id).is_ok());
        assert!(remove(&mut file, &one.id).is_err(), "删第二次要报错");
    }

    #[test]
    fn 空目录也能存能取() {
        let root = root("lc-write-fresh");
        let file = LaunchConfigFile::new();
        save(&root, &file).unwrap();
        assert!(config_path(&root).is_file());
        assert_eq!(load(&root).configs.len(), 0);
    }

    #[test]
    fn 配置目录建不出来时保存报错而不是假装成功() {
        // 只读工程 / .ncforge 被文件占用：create_dir_all 必失败。保存必须把错误
        // 抛到前端（launch.saveFailed），不能静默丢数据——用户以为存上了。
        let root = root("lc-unwritable");
        std::fs::write(root.join(CONFIG_DIR), "这是个文件不是目录").unwrap();
        let mut file = LaunchConfigFile::new();
        upsert(&mut file, middleware("存不进去")).unwrap();
        let err = save(&root, &file).unwrap_err();
        assert!(err.contains("目录失败"), "{}", err);
        assert!(!config_path(&root).exists(), "失败时不留下半份文件");
    }
}
