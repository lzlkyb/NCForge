//! 应用共享状态（Tauri Managed State）。
//!
//! 范式：`main.rs` 里 `app.manage(Arc::new(AppState::new(...)))`，命令里用
//! `tauri::State<Arc<AppState>>` 取。配置用 `tokio::sync::RwLock` 包着——
//! 读多写少，且同步回调里只能用 `try_read()`。
//!
//! 业务加状态时在此文件加字段（如 `db: tokio::sync::Mutex<Connection>`），
//! 不要散着用全局 static——全局static 在测试里互相污染，且没有生命周期管理。

use std::sync::Arc;

use tokio::sync::RwLock;

use crate::config::AppConfig;
use crate::server::ServerRun;

pub struct AppState {
    /// 应用配置（跨重启持久化，见 config.rs）。
    pub config: RwLock<AppConfig>,
    /// 配置写入的串行化闸门。**所有改配置的入口都必须走 `update_config`**。
    ///
    /// 没有它的时候每个命令都是「读全量 → 改一个字段 → 写全量」：设置页拨开关的同时
    /// 服务页改堆上限，两边各拿一份旧快照，后写的那次把另一次改动整个抹掉，
    /// 而两边都显示保存成功。普通 Mutex 够了——临界区里没有 await（只有内存拷贝与写盘）。
    config_write: tokio::sync::Mutex<()>,
    /// 配置目录（`{config_dir}`，与 data_dir 相同）。
    pub config_dir: std::path::PathBuf,
    /// NC 中间件的运行态（起/停/日志都以它为准）。
    ///
    /// 用 `std::sync::Mutex` 而不是 tokio 的：起停是阻塞操作（杀进程要等 200ms 级），
    /// 调用方都在 `spawn_blocking` 里持锁，不需要 await 语义。
    pub server: std::sync::Mutex<ServerRun>,
    /// SVN 桥（常驻 JVM）。`None` = 还没用过；`Err` 由命令层转成可读错误。
    ///
    /// 存 `Arc` 是因为命令层要把它从锁里拿出来在 `spawn_blocking` 里用——桥内部自己
    /// 串行化请求，锁只保护「有没有这个桥 / 用哪份 java」。
    pub svn: std::sync::Mutex<Option<std::sync::Arc<crate::svn_bridge::Bridge>>>,
    /// 数据库引擎：**每个连接一个句柄**（键是连接 id）。
    ///
    /// 存的是 [`crate::db_engine::EngineHandle`] 而不是具体桥，好处是「换驱动」不用动命令层。
    /// 多个句柄共用同一个 JVM，只有会话不同（内存从「每连接一条进程」变成常量底价 + 每会话几 MB）。
    pub db: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Arc<crate::db_engine::EngineHandle>>,
    >,
    /// 共享的数据库桥进程池：按「java 路径 + classpath」索引，存**弱引用**。
    ///
    /// 用 `Weak` 而不是 `Arc`：最后一条会话释放时 `Arc<Bridge>` 归零，桥自己 `Drop` 掉进程，
    /// 池里那条记录随之失效（下次 upgrade 失败就重建）。省掉一套「谁该关进程」的记账。
    pub db_procs: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Weak<crate::java_bridge::Bridge>>,
    >,
    /// 代码智能（jdt.ls）会话与状态。同样在 `spawn_blocking` 里持锁，用 std Mutex。
    pub lang: std::sync::Mutex<crate::lang::LangRun>,
    /// 编译的取消标志。
    ///
    /// 一次编译最坏是「300 秒超时 × 6 轮」≈ 30 分钟，中间没有任何中断手段，用户只能
    /// 杀进程。放在 AppState 上而不是模块级 static：它跟一个应用实例同生命周期，
    /// 测试里也不会互相污染（本文件头注释的同一条纪律）。
    pub compile_cancel: std::sync::atomic::AtomicBool,
    /// 供 notifications feature 关闭时也能注入的 AppHandle 存根。
    /// 需要发桌面通知的代码统一走 main.rs 的 `notify_toast`（那里按 feature 门控），
    /// 不要直接持有 AppHandle 到处发。
    pub app_handle: std::sync::Mutex<Option<tauri::AppHandle>>,
}

impl AppState {
    pub fn new(config: AppConfig, config_dir: std::path::PathBuf) -> Arc<Self> {
        Arc::new(Self {
            config: RwLock::new(config),
            config_write: tokio::sync::Mutex::new(()),
            config_dir,
            server: std::sync::Mutex::new(ServerRun::default()),
            svn: std::sync::Mutex::new(None),
            db: std::sync::Mutex::new(Default::default()),
            db_procs: std::sync::Mutex::new(Default::default()),
            lang: std::sync::Mutex::new(Default::default()),
            compile_cancel: std::sync::atomic::AtomicBool::new(false),
            app_handle: std::sync::Mutex::new(None),
        })
    }

    /// 串行化的「读 → 改 → 落盘 → 更新内存」，返回改完的配置。
    ///
    /// 为什么必须先读全量再改：`AppConfig` 是整份序列化的，只写一个字段也得带上其余字段，
    /// 否则落盘的就是一份「其余都是默认值」的配置（工作区、NC home、堆上限全没）。
    /// 而「读全量」本身就会与并发的写互相覆盖，所以整段加锁。
    ///
    /// 闭包返回 `Err` 时既不改内存也不落盘——校验失败要能干净地退出。
    pub async fn update_config<F>(&self, edit: F) -> Result<AppConfig, String>
    where
        F: FnOnce(&mut AppConfig) -> Result<(), String>,
    {
        let _serialized = self.config_write.lock().await;
        let mut cfg = self.config.read().await.clone();
        edit(&mut cfg)?;
        crate::config::save_config(&self.config_dir, &cfg)?;
        *self.config.write().await = cfg.clone();
        Ok(cfg)
    }
}
