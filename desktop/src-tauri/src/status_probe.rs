//! 服务状态轮询的探测缓存。
//!
//! 服务面板展开时 1 秒一轮、状态栏 5 秒一轮。以前每轮都要：
//! - `nc_home::resolve`：canonicalize + 数一遍 modules 下几百个子目录；
//! - 读并解析 `ierp/bin/prop.xml`；
//! - fork 一次 `netstat -ano`（实测约 30ms）。
//!
//! 这里把它们缓存起来，但不动三条规矩：
//! 1. 端口由**自己的进程**监听才算就绪——启动中、或还没确认是自己时，端口每轮实时查；
//! 2. 外部占用提示要准——缓存里是「别人占着」时也每轮实时查，不拿旧结果吓人；
//! 3. 最小化停轮询由前端负责，这里不涉及。
//!
//! 只在两种稳态里复用端口结果（最多 `OWNER_TTL`）：服务停着且端口空闲；
//! 服务在跑且端口已确认是自己的进程。
//!
//! 纯逻辑、时间与探测动作都由调用方传入，便于单测。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use crate::nc_home::{ServerEndpoints, SERVER_PROP};
use crate::server::PortOwner;

/// NC home 定位结果的有效期。配置里的路径一变就立刻重新定位，不等它过期。
pub const HOME_TTL: Duration = Duration::from_secs(30);
/// 稳态下端口占用结果的有效期。
pub const OWNER_TTL: Duration = Duration::from_secs(5);

/// 这一轮服务进程的状态，决定端口结果能不能复用。
#[derive(Debug, Clone, Copy)]
pub struct ProcState {
    pub starting: bool,
    pub alive: bool,
    pub pid: Option<u32>,
}

type FileStamp = Option<(SystemTime, u64)>;

pub struct ProbeCache {
    /// (配置里的 NC home, 定位时间, 定位出的根目录；None = 定位失败)
    home: Option<(Option<String>, Instant, Option<PathBuf>)>,
    /// (NC home 根, prop.xml 的修改时间与大小, 解析结果)
    endpoints: Option<(PathBuf, FileStamp, ServerEndpoints)>,
    /// (端口, 探测时间, 占用者)
    owner: Option<(u16, Instant, Option<PortOwner>)>,
}

impl Default for ProbeCache {
    fn default() -> Self {
        Self::new()
    }
}

impl ProbeCache {
    pub const fn new() -> Self {
        Self {
            home: None,
            endpoints: None,
            owner: None,
        }
    }

    /// NC home 根目录。`resolve` 只在配置变了或缓存过期时调用。
    pub fn home_root(
        &mut self,
        configured: Option<&str>,
        now: Instant,
        resolve: impl FnOnce() -> Option<PathBuf>,
    ) -> Option<PathBuf> {
        if let Some((cfg, at, root)) = &self.home {
            if cfg.as_deref() == configured && now.duration_since(*at) < HOME_TTL {
                return root.clone();
            }
        }
        let root = resolve();
        self.home = Some((configured.map(str::to_string), now, root.clone()));
        root
    }

    /// 中间件端点。`prop.xml` 的修改时间或大小一变（改端口、用 sysConfig 改配置）就重读。
    pub fn endpoints(
        &mut self,
        root: Option<&Path>,
        read: impl FnOnce(&Path) -> ServerEndpoints,
    ) -> ServerEndpoints {
        let Some(root) = root else {
            // NC home 定位失败：服务页仍要能显示，端口按默认并标「不是从配置读的」
            return ServerEndpoints::fallback(String::new());
        };
        let stamp = file_stamp(&root.join(SERVER_PROP));
        if let Some((r, s, ep)) = &self.endpoints {
            if r == root && *s == stamp {
                return ep.clone();
            }
        }
        let ep = read(root);
        self.endpoints = Some((root.to_path_buf(), stamp, ep.clone()));
        ep
    }

    /// 谁占着端口。见模块头：只有两种稳态复用，其余每轮实时查。
    pub fn owner(
        &mut self,
        port: u16,
        proc: ProcState,
        now: Instant,
        probe: impl FnOnce() -> Option<PortOwner>,
    ) -> Option<PortOwner> {
        if let Some((p, at, owner)) = &self.owner {
            let stable = !proc.starting
                && match owner {
                    // 停着且空闲
                    None => !proc.alive,
                    // 在跑且是自己的进程
                    Some(o) => proc.alive && proc.pid == Some(o.pid),
                };
            if *p == port && stable && now.duration_since(*at) < OWNER_TTL {
                return owner.clone();
            }
        }
        let owner = probe();
        self.owner = Some((port, now, owner.clone()));
        owner
    }
}

fn file_stamp(path: &Path) -> FileStamp {
    let md = std::fs::metadata(path).ok()?;
    Some((md.modified().ok()?, md.len()))
}

static CACHE: Mutex<ProbeCache> = Mutex::new(ProbeCache::new());

/// 进程内唯一的一份。状态轮询本来就是串行的，持锁期间做探测不会卡别人。
pub fn lock() -> MutexGuard<'static, ProbeCache> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn me(pid: u32) -> PortOwner {
        PortOwner {
            pid,
            name: "java.exe".into(),
        }
    }
    const STOPPED: ProcState = ProcState {
        starting: false,
        alive: false,
        pid: None,
    };
    const fn running(pid: u32) -> ProcState {
        ProcState {
            starting: false,
            alive: true,
            pid: Some(pid),
        }
    }

    #[test]
    fn 稳态才复用端口结果_启动中与外部占用每轮实时查() {
        let t0 = Instant::now();
        let calls = Cell::new(0);
        let mut c = ProbeCache::new();
        let probe = |o: Option<PortOwner>| {
            calls.set(calls.get() + 1);
            o
        };

        // 停着且空闲：5 秒内只查一次
        c.owner(80, STOPPED, t0, || probe(None));
        c.owner(80, STOPPED, t0 + Duration::from_secs(1), || probe(None));
        c.owner(80, STOPPED, t0 + Duration::from_secs(4), || probe(None));
        assert_eq!(calls.get(), 1);
        // 过期重查；换端口立刻重查
        c.owner(80, STOPPED, t0 + OWNER_TTL, || probe(None));
        c.owner(8080, STOPPED, t0 + OWNER_TTL, || probe(None));
        assert_eq!(calls.get(), 3);

        // 启动中：每轮都查（就绪要及时）
        let starting = ProcState {
            starting: true,
            alive: true,
            pid: Some(7),
        };
        let n = calls.get();
        c.owner(8080, starting, t0, || probe(None));
        c.owner(8080, starting, t0, || probe(Some(me(7))));
        assert_eq!(calls.get(), n + 2);

        // 确认是自己的进程在跑：复用
        let n = calls.get();
        assert_eq!(
            c.owner(8080, running(7), t0, || probe(Some(me(7))))
                .map(|o| o.pid),
            Some(7)
        );
        assert_eq!(calls.get(), n);

        // 刚停掉：缓存里的旧 PID 不能被当成「外部占用」，必须重查
        assert!(c.owner(8080, STOPPED, t0, || probe(None)).is_none());
        assert_eq!(calls.get(), n + 1);

        // 别人占着：每轮都查，对方一退出提示就消失
        c.owner(8080, STOPPED, t0 + OWNER_TTL * 3, || probe(Some(me(99))));
        let n = calls.get();
        assert!(c
            .owner(8080, STOPPED, t0 + OWNER_TTL * 3, || probe(None))
            .is_none());
        assert_eq!(calls.get(), n + 1);
    }

    #[test]
    fn nc_home_按配置与有效期缓存() {
        let t0 = Instant::now();
        let calls = Cell::new(0);
        let mut c = ProbeCache::new();
        let resolve = || {
            calls.set(calls.get() + 1);
            Some(PathBuf::from("D:\\ncc\\1909home"))
        };
        c.home_root(Some("D:\\ncc\\1909home"), t0, resolve);
        c.home_root(
            Some("D:\\ncc\\1909home"),
            t0 + Duration::from_secs(10),
            resolve,
        );
        assert_eq!(calls.get(), 1);
        c.home_root(
            Some("D:\\ncc\\other"),
            t0 + Duration::from_secs(10),
            resolve,
        );
        assert_eq!(calls.get(), 2, "配置一变立刻重新定位");
        c.home_root(Some("D:\\ncc\\other"), t0 + HOME_TTL * 2, resolve);
        assert_eq!(calls.get(), 3, "过期重新定位");
    }

    #[test]
    fn 端点按_prop_xml_的修改时间与大小失效() {
        let root =
            std::env::temp_dir().join(format!("ncforge-status-probe-{}", std::process::id()));
        let prop = root.join(SERVER_PROP);
        std::fs::create_dir_all(prop.parent().unwrap()).unwrap();
        std::fs::write(&prop, "<http><port>80</port></http>").unwrap();
        let calls = Cell::new(0);
        let read = |r: &Path| {
            calls.set(calls.get() + 1);
            crate::nc_home::read_endpoints(r)
        };
        let mut c = ProbeCache::new();
        assert_eq!(c.endpoints(Some(&root), read).http_port, 80);
        assert_eq!(c.endpoints(Some(&root), read).http_port, 80);
        assert_eq!(calls.get(), 1);
        // 改端口：大小变了就重读（不依赖文件系统的时间精度）
        std::fs::write(&prop, "<http><port>8080</port></http>").unwrap();
        assert_eq!(c.endpoints(Some(&root), read).http_port, 8080);
        assert_eq!(calls.get(), 2);
        // 定位不到 NC home：回落默认，不碰缓存
        let fb = c.endpoints(None, read);
        assert!(!fb.from_config);
        assert_eq!(calls.get(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }
}
