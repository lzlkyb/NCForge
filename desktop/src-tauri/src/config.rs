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
    /// 关窗时释放界面内存（销毁 webview 进程组，实测省约 80MB 专用工作集；
    /// 代价是重开窗口要重新加载前端 1~2 秒）。由托盘/双击图标重建窗口。
    #[serde(default = "default_true")]
    pub release_webview_on_close: bool,
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
    /// nc-patch 脚本目录（可选）。只用来继承它缓存里的输出目录，省得用户再选一次。
    #[serde(default)]
    pub nc_patch_dir: Option<String>,
    /// 数据库连接串覆盖（默认从 NC home 的 `ierp/bin/prop.xml` 读）。
    #[serde(default)]
    pub db_url: Option<String>,
    /// 数据库用户名覆盖。
    #[serde(default)]
    pub db_user: Option<String>,
    /// 数据库密码的 DPAPI 密文（prop.xml 里那串是 NC 自己的加密格式，解不开）。
    #[serde(default)]
    pub db_password_dpapi: Option<String>,
}

fn default_true() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            release_webview_on_close: true,
            autostart_enabled: false,
            workspace_root: None,
            nc_home: None,
            server_heap_mb: None,
            svn_user: None,
            svn_password_dpapi: None,
            patch_out_dir: None,
            patch_out_root: None,
            nc_patch_dir: None,
            db_url: None,
            db_user: None,
            db_password_dpapi: None,
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
