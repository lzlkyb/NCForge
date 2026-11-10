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

/// 一次「全库按值反查」的取消登记：标志位 + 它正在用的临时会话。
///
/// 带句柄是为了取消能立刻生效（见 `AppState::search_cancels`）。
pub struct ValueSearchJob {
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
    pub engine: Arc<crate::db_engine::EngineHandle>,
}

pub struct AppState {
    /// 应用配置（跨重启持久化，见 config.rs）。
    pub config: RwLock<AppConfig>,
    /// 配置写入的串行化闸门。**所有改配置的入口都必须走 `update_config`**。
    ///
    /// 没有它的时候每个命令都是「读全量 → 改一个字段 → 写全量」：设置页拨开关的同时
    /// 服务页改堆上限，两边各拿一份旧快照，后写的那次把另一次改动整个抹掉，
    /// 而两边都显示保存成功。临界区里只有内存拷贝和一个 `spawn_blocking` 的写盘，
    /// 锁跨过它是刻意的：写入顺序必须与修改顺序一致。
    config_write: tokio::sync::Mutex<()>,
    /// 配置目录（`{config_dir}`，与 data_dir 相同）。
    pub config_dir: std::path::PathBuf,
    /// NC 中间件的运行态（起/停/日志都以它为准）。
    ///
    /// 用 `std::sync::Mutex` 而不是 tokio 的：起停是阻塞操作（杀进程要等 200ms 级），
    /// 调用方都在 `spawn_blocking` 里持锁，不需要 await 语义。
    pub server: std::sync::Mutex<ServerRun>,
    /// NC 客户端（Swing `JStarter`）的运行态。与中间件是两个独立进程，不能共用一个槽位：
    /// 客户端可以连别的机器上的服务，也可能在中间件停止后继续开着。
    pub client: std::sync::Mutex<ServerRun>,
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
    pub db_policies:
        std::sync::Mutex<std::collections::HashMap<String, Arc<std::sync::RwLock<bool>>>>,
    pub db_procs: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Weak<crate::java_bridge::Bridge>>,
    >,
    /// 连接上**临时切换过**的默认 schema（连接 id → schema 名，空串不入表）。
    ///
    /// 与配置里的 `default_schema` 分开记：配置是「每次连上都切的初始值」，
    /// 这里是「这一次运行里用户手动切到的值」。申请新会话槽、起 JVM 兜底会话都要按它
    /// 建，否则切完 schema 再开一个 SQL 标签会悄悄回到配置值，而左栏表树已经是新 schema。
    /// 断开连接 / 重新配置默认值后整条删掉。
    pub db_schemas: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// 代码智能（jdt.ls）会话与状态。同样在 `spawn_blocking` 里持锁，用 std Mutex。
    pub lang: std::sync::Mutex<crate::lang::LangRun>,
    /// 调试会话（java-debug 的 DAP 连接）。与语言服务是两条独立连接。
    pub debug: std::sync::Mutex<crate::debug::DebugRun>,
    /// 编译的取消标志。
    ///
    /// 一次编译最坏是「300 秒超时 × 6 轮」≈ 30 分钟，中间没有任何中断手段，用户只能
    /// 杀进程。放在 AppState 上而不是模块级 static：它跟一个应用实例同生命周期，
    /// 测试里也不会互相污染（本文件头注释的同一条纪律）。
    pub compile_cancel: std::sync::atomic::AtomicBool,
    /// 热替换：最近一次结果、「运行中代码不是最新」标记、手动模式的待推列表。
    /// 启动服务时清空（见 `hotswap::HotswapState::reset`）。
    pub hotswap: std::sync::Mutex<crate::hotswap::HotswapState>,
    /// 客户端那一份。两个 JVM 各有各的 agent、各自的「代码不是最新」标记：
    /// 客户端失败不能把中间件的标记点亮，反过来也一样。启动客户端时清空。
    pub hotswap_client: std::sync::Mutex<crate::hotswap::HotswapState>,
    /// 流式导出的取消标志，**按导出实例**登记（`db_export_cancel(id)` 置位）。
    ///
    /// 以前是一个全局 `AtomicBool`：两个结果页同时导出时，取消其中一个会把另一个也停掉；
    /// 而且 A 导出开始时复位标志，会把 B 刚点的取消吞掉。与 `compile_cancel` 一样只置
    /// 标志、不做中断：正在飞的那一页必须写完，否则前端不知道这一页到底提交没有。
    /// 取消后保留已经写入的部分文件（合法前缀）。
    pub export_cancels:
        std::sync::Mutex<std::collections::HashMap<u64, Arc<std::sync::atomic::AtomicBool>>>,
    /// 表 → 表 直连搬运的取消标志（按前端给的 `transferId`）。
    /// 与导出分开一张表：同一次会话里可能一边导出、一边搬运，两者不能被彼此的取消串台。
    pub transfer_cancels:
        std::sync::Mutex<std::collections::HashMap<u64, Arc<std::sync::atomic::AtomicBool>>>,
    /// 全库按值反查：按搜索实例登记「取消标志 + 它正在用的临时会话」。
    ///
    /// 为什么带上引擎句柄：一批表扫下来，单张表的全表扫描可能要几十秒到几分钟。
    /// 只置标志位然后等「两张表之间」检查，等于用户点了取消还要干等当前这张表跑完；
    /// 带句柄才能在取消时真的把正在跑的那条查询打断（与 `db_cancel` 同一条路）。
    pub search_cancels: std::sync::Mutex<std::collections::HashMap<u64, ValueSearchJob>>,
    /// 补丁出包的取消标志（`patch_build_cancel` 置位，`write_package` 每写一项检查一次）。
    ///
    /// 同一时刻只允许一个出包（界面只有一个按钮、重复点击被 `building` 挡住），
    /// 所以不需要按 id 分账；置位后正在写的那一项写完即停，临时文件被删掉。
    pub patch_cancel: std::sync::atomic::AtomicBool,
    /// 退出已获放行：`CloseRequested` 看到它就真的让窗口关（进程随后退出）。
    ///
    /// 为什么需要这个标志：关窗时前端要先问一遍「有未提交的事务吗」，同步的窗口
    /// 回调里没法等结果，只能 `prevent_close()` 拦一次；前端答完（提交/回滚完，
    /// 或确认干净）再置这个位，由 `app_quit` 重新关窗放行。
    pub quit_approved: std::sync::atomic::AtomicBool,
    /// 当前工作区的文件监听（树自动刷新用）。`None` = 没选工作区或监听起不来。
    ///
    /// 存一份实例而不是裸线程：`Drop` 会停掉 OS 监听与后台线程，换工作区就是替换它。
    pub watcher: std::sync::Mutex<Option<crate::watcher::WorkspaceWatcher>>,
    /// 前端已经开始处理这一次退出请求。
    ///
    /// 用于兜底强退：`prevent_close()` 之后如果 webview 已经卡死/崩了，没人会回话，
    /// 应用就永远关不掉。起一个 5 秒计时，没等到这个位就说明界面起不来了，直接退
    /// （这种状态下也弹不出确认框，未提交事务只能由 Oracle 回滚）。
    pub quit_acked: std::sync::atomic::AtomicBool,
    /// 正在走一次退出确认。只在 `quit_cancel` / `app_quit` / 兜底强退三处复位：
    /// 计时器**不能**无条件清它，否则确认框还开着时连点 X 会启动第二轮。
    pub quit_checking: std::sync::atomic::AtomicBool,
    /// 退出检查轮次 id。每轮 `begin_quit_check` 递增；兜底计时器只在 round 仍匹配
    /// 且本轮没收到 ack 时才强退，避免上一轮的计时器把新一轮踢出去。
    pub quit_round: std::sync::atomic::AtomicU64,
    /// 供 notifications feature 关闭时也能注入的 AppHandle 存根。
    /// 需要发桌面通知的代码统一走 main.rs 的 `notify_toast`（那里按 feature 门控），
    /// 不要直接持有 AppHandle 到处发。
    pub app_handle: std::sync::Mutex<Option<tauri::AppHandle>>,
}

impl AppState {
    /// 某个 JVM 的热替换状态。
    pub fn hotswap_of(
        &self,
        target: crate::hotswap::Target,
    ) -> &std::sync::Mutex<crate::hotswap::HotswapState> {
        match target {
            crate::hotswap::Target::Server => &self.hotswap,
            crate::hotswap::Target::Client => &self.hotswap_client,
        }
    }

    pub fn new(config: AppConfig, config_dir: std::path::PathBuf) -> Arc<Self> {
        Arc::new(Self {
            config: RwLock::new(config),
            config_write: tokio::sync::Mutex::new(()),
            config_dir,
            server: std::sync::Mutex::new(ServerRun::default()),
            client: std::sync::Mutex::new(ServerRun::default()),
            svn: std::sync::Mutex::new(None),
            db: std::sync::Mutex::new(Default::default()),
            db_policies: std::sync::Mutex::new(std::collections::HashMap::new()),
            db_procs: std::sync::Mutex::new(Default::default()),
            db_schemas: std::sync::Mutex::new(Default::default()),
            lang: std::sync::Mutex::new(Default::default()),
            debug: std::sync::Mutex::new(Default::default()),
            compile_cancel: std::sync::atomic::AtomicBool::new(false),
            hotswap: std::sync::Mutex::new(Default::default()),
            hotswap_client: std::sync::Mutex::new(Default::default()),
            export_cancels: std::sync::Mutex::new(Default::default()),
            transfer_cancels: std::sync::Mutex::new(Default::default()),
            search_cancels: std::sync::Mutex::new(Default::default()),
            patch_cancel: std::sync::atomic::AtomicBool::new(false),
            watcher: std::sync::Mutex::new(None),
            quit_approved: std::sync::atomic::AtomicBool::new(false),
            quit_acked: std::sync::atomic::AtomicBool::new(false),
            quit_checking: std::sync::atomic::AtomicBool::new(false),
            quit_round: std::sync::atomic::AtomicU64::new(0),
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
        // 写盘放阻塞线程：落盘是 fs::write + rename，赶上杀软/机械盘要几十毫秒，
        // 直接在 async 任务里做会把整个运行时的那条工作线程钉住（同一时刻的
        // 其它命令、定时器都得等它）。闸门仍然罩着这一段，写入顺序不变。
        let dir = self.config_dir.clone();
        let to_save = cfg.clone();
        tokio::task::spawn_blocking(move || crate::config::save_config(&dir, &to_save))
            .await
            .map_err(|e| format!("保存配置的后台任务异常退出：{e}"))??;
        *self.config.write().await = cfg.clone();
        Ok(cfg)
    }
}
