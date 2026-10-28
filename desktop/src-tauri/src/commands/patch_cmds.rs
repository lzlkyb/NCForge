//! 补丁命令层：扫描清单、出包、输出目录与产物根的默认值。
//!
//! 与 `svn_cmds` 同一套约定：
//! 1. **扫描与出包都在 `spawn_blocking`**：扫 hyext jar 首次可能要几秒，出包要读几十上百个
//!    class 文件，放在 async 线程上会卡住 IPC。
//! 2. **文件路径必须落在白名单内**：工作区或 NC home。hotwebs 的源文件在 NC home 里，
//!    所以白名单是这两个根，不是只有工作区。
//! 3. **不缓存清单**：每次 scan 真扫。class 的 mtime 随时会变（IDE 一编译），缓存只会给出
//!    「刚才还能打、现在不能打」的假结论。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config::AppConfig;
use crate::patch_build::{self, BuildOptions, BuildRequest, BuildResult, ScanResult};
use crate::security::path::{display_path, resolve_safe_path};
use crate::state::AppState;

/// 已知的 nc-patch 脚本位置（只用来继承它缓存里的输出目录）。
const KNOWN_NC_PATCH_DIRS: [&str; 2] = [r"D:\AItool\aiwork\nc-patch", r"C:\work\aier\nc-patch"];

/// 补丁目录的常见叫法。**第一次用**（没有 nc-patch 缓存）时靠它们在已知位置里找现成的，
/// 找到就直接用——比凭空造一个路径靠谱得多。
const PATCH_DIR_NAMES: [&str; 4] = ["待上线补丁", "待上线补丁包", "补丁", "patches"];

/// 探测补丁目录的父目录。只到「工作副本、它的父级、已知工程根」这一层。
///
/// 刻意不全盘扫：机械盘上遍历整个 D: 能让首屏卡十几秒，而漏掉一个非标准命名的
/// 目录，代价只是退回到「建议值 + 用户手改一次」。
///
/// 第一条是本机 `nc-patch` 脚本缓存里 `CACHED_PATCH_DIR` 的父级（`待上线补丁` 就在它下面），
/// 写进来是为了在脚本缓存丢了、但补丁目录还在时不至于退回建议值。
const KNOWN_PATCH_PARENTS: [&str; 3] = [
    r"D:\NC技术文档\爱尔文档\补丁",
    r"C:\work\aier",
    r"D:\AItool\aiwork",
];

// ───────────────────────── DTO ─────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchDefaults {
    pub workspace_root: Option<String>,
    /// 建议的输出目录。
    pub out_dir: Option<String>,
    /// `config` / `nc-patch` / `detect` / `suggest` / `none`——界面据此显示「这个路径哪来的」。
    ///
    /// - `config`：用户自己设过（最可信）
    /// - `nc-patch`：继承 nc-patch 脚本缓存里的正式目录
    /// - `detect`：第一次用，在常见位置里**找到了**现成的目录
    /// - `suggest`：第一次用，一个都没找到——`out_dir` 只是建议值，**还不存在**，出包时才会建
    /// - `none`：连工作区都没打开，没法猜
    pub out_dir_source: String,
    /// `out_dir` 现在是否真实存在。`suggest` 必然是 `false`，界面要照这个提示。
    pub out_dir_exists: bool,
    /// 配置里显式指定的产物根。
    pub out_root: Option<String>,
    /// 自动探测会依次尝试的产物根。
    pub out_root_candidates: Vec<String>,
    pub nc_home: Option<String>,
    /// NC home 下能数到的模块数（0 = 路径不对）。
    pub nc_home_modules: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildArgs {
    pub files: Vec<String>,
    pub out_dir: String,
    pub desc: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub sqls: Vec<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub force_hyext: Vec<String>,
    #[serde(default)]
    pub force_std: Vec<String>,
}

// ───────────────────────── 辅助 ─────────────────────────

/// 探测的父目录清单，按优先级：工作副本 → 工作副本父级 → 已知工程根。
fn probe_parents(root: Option<&Path>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Some(r) = root {
        v.push(r.to_path_buf());
        if let Some(p) = r.parent() {
            v.push(p.to_path_buf());
        }
    }
    v.extend(KNOWN_PATCH_PARENTS.iter().map(PathBuf::from));
    // 工作副本的父级常常就是已知工程根，会重复；去重后每个目录只探一次
    let mut seen: Vec<PathBuf> = Vec::new();
    v.retain(|p| {
        if seen.contains(p) {
            false
        } else {
            seen.push(p.clone());
            true
        }
    });
    v
}

/// 在 parents × names 里找第一个**真实存在**的目录。
fn first_existing_dir(parents: &[PathBuf], names: &[&str]) -> Option<PathBuf> {
    for parent in parents {
        for name in names {
            let p = parent.join(name);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    None
}

fn root_of(cfg: &AppConfig) -> Result<PathBuf, String> {
    cfg.workspace_root
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "还没有选择工作区（先在文件页打开一个工程根目录）".to_string())
}

/// 文件白名单：工作区 + NC home。hotwebs 的源文件本来就住在 NC home 里。
fn allow_roots(cfg: &AppConfig) -> Result<Vec<String>, String> {
    let root = root_of(cfg)?;
    let mut roots = vec![display_path(&root)];
    if let Ok(home) = crate::nc_home::resolve(cfg.nc_home.as_deref()) {
        roots.push(display_path(Path::new(&home.root)));
    }
    Ok(roots)
}

fn check_files(cfg: &AppConfig, files: &[String]) -> Result<Vec<String>, String> {
    let roots = allow_roots(cfg)?;
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let p = resolve_safe_path(f, &roots, &[], true)?;
        out.push(display_path(&crate::nc_home::strip_verbatim(&p)));
    }
    Ok(out)
}

/// 组装出包选项（产物根、NC home、jar 索引缓存）。
fn options_of(
    state: &AppState,
    cfg: &AppConfig,
    force_hyext: Vec<String>,
    force_std: Vec<String>,
) -> Result<BuildOptions, String> {
    let root = root_of(cfg)?;
    let nc_home = crate::nc_home::resolve(cfg.nc_home.as_deref())
        .ok()
        .map(|h| display_path(Path::new(&h.root)));
    Ok(BuildOptions {
        root: display_path(&root),
        out_root: cfg.patch_out_root.clone().filter(|s| !s.trim().is_empty()),
        nc_home,
        cache_file: display_path(&state.config_dir.join("jar-index.tsv")),
        force_hyext,
        force_std,
    })
}

// ───────────────────────── 命令 ─────────────────────────

/// 扫描清单：不写盘，只算「勾了这些文件会打成什么样」。
#[tauri::command]
pub async fn patch_scan(
    state: tauri::State<'_, Arc<AppState>>,
    files: Vec<String>,
    force_hyext: Option<Vec<String>>,
    force_std: Option<Vec<String>>,
) -> Result<ScanResult, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let opts = options_of(
        &st,
        &cfg,
        force_hyext.unwrap_or_default(),
        force_std.unwrap_or_default(),
    )?;
    let files = check_files(&cfg, &files)?;
    tauri::async_runtime::spawn_blocking(move || patch_build::scan(&opts, &files))
        .await
        .map_err(|e| format!("扫描补丁清单失败：{e}"))?
}

/// 出包。会先重新扫一遍，保证「看到的清单」与「打出来的包」是同一份。
#[tauri::command]
pub async fn patch_build(
    state: tauri::State<'_, Arc<AppState>>,
    args: BuildArgs,
) -> Result<BuildResult, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();

    if args.desc.trim().is_empty() {
        return Err(
            "先写一句「改动内容描述」——它就是补丁包的名字（<描述>_<年月日>.zip）".to_string(),
        );
    }
    let out_dir = args.out_dir.trim();
    if out_dir.is_empty() {
        return Err("还没选补丁输出目录".to_string());
    }
    let out = Path::new(out_dir);
    if !out.is_absolute() {
        return Err(format!("补丁输出目录要给绝对路径：{out_dir}"));
    }
    // 盘符根（`D:\`）当输出目录几乎一定是选错了
    if out.parent().is_none() {
        return Err(format!("不能用盘符根当补丁输出目录：{out_dir}"));
    }

    let files = check_files(&cfg, &args.files)?;
    let sqls = check_files(&cfg, &args.sqls)?;
    let opts = options_of(&st, &cfg, args.force_hyext, args.force_std)?;

    let req = BuildRequest {
        options: opts,
        files,
        out_dir: out_dir.to_string(),
        desc: args.desc,
        note: args.note,
        sqls,
        date: args.date,
    };
    tauri::async_runtime::spawn_blocking(move || patch_build::build(&req))
        .await
        .map_err(|e| format!("出包失败：{e}"))?
}

/// 输出目录 / 产物根 / NC home 的当前建议值。
#[tauri::command]
pub async fn patch_defaults(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<PatchDefaults, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let root = root_of(&cfg).ok();
    let root_s = root.as_ref().map(|p| display_path(p));

    let (out_dir, source) =
        if let Some(d) = cfg.patch_out_dir.clone().filter(|s| !s.trim().is_empty()) {
            (Some(d), "config")
        } else {
            // 先看 nc-patch 脚本缓存（它记着用户当初 -D 给过的正式目录）
            let script_dir = cfg
                .nc_patch_dir
                .clone()
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    KNOWN_NC_PATCH_DIRS
                        .iter()
                        .map(PathBuf::from)
                        .find(|p| p.is_dir())
                });
            let from_cache = script_dir
                .as_deref()
                .and_then(patch_build::read_cached_patch_dir)
                .filter(|d| Path::new(d).is_dir());
            if let Some(d) = from_cache {
                (Some(d), "nc-patch")
            } else {
                // 第一次用：先在常见位置里找现成的目录，找不到才给建议值
                let mut parents = probe_parents(root.as_deref());
                if let Some(p) = script_dir.as_deref().and_then(Path::parent) {
                    if !parents.contains(&p.to_path_buf()) {
                        parents.push(p.to_path_buf());
                    }
                }
                if let Some(d) = first_existing_dir(&parents, &PATCH_DIR_NAMES) {
                    (Some(display_path(&d)), "detect")
                } else if let Some(r) = &root {
                    // 建议放在工作副本的同级（不是里面）：补丁包不该混进工程目录
                    let base = r.parent().unwrap_or(r);
                    (
                        Some(display_path(&base.join(PATCH_DIR_NAMES[0]))),
                        "suggest",
                    )
                } else {
                    (None, "none")
                }
            }
        };
    let out_dir_exists = out_dir
        .as_deref()
        .map(|d| Path::new(d).is_dir())
        .unwrap_or(false);

    let (nc_home, modules) = match crate::nc_home::resolve(cfg.nc_home.as_deref()) {
        Ok(h) => {
            let home = PathBuf::from(&h.root);
            let n = std::fs::read_dir(home.join("modules"))
                .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).count())
                .unwrap_or(0);
            (Some(display_path(&home)), n)
        }
        Err(_) => (None, 0),
    };

    let mut cands = Vec::new();
    if let Some(r) = &root {
        if let Some(o) = cfg.patch_out_root.clone().filter(|s| !s.trim().is_empty()) {
            cands.push(o);
        }
        cands.push(display_path(&r.join("out")));
        // 模块级产物（M3 的落点），拿实际存在的模块名拼
        if let Ok(rd) = std::fs::read_dir(r) {
            for e in rd.flatten().take(400) {
                let p = e.path();
                if p.is_dir() && p.join("classes").is_dir() {
                    cands.push(display_path(&p.join("classes")));
                }
            }
        }
    }

    Ok(PatchDefaults {
        workspace_root: root_s,
        out_dir,
        out_dir_source: source.to_string(),
        out_dir_exists,
        out_root: cfg.patch_out_root,
        out_root_candidates: cands,
        nc_home,
        nc_home_modules: modules,
    })
}

/// 记住补丁输出目录（与脚本「-D 给一次就记住」的行为一致）。
#[tauri::command]
pub async fn patch_set_out_dir(
    state: tauri::State<'_, Arc<AppState>>,
    dir: String,
) -> Result<(), String> {
    let dir = dir.trim().to_string();
    let p = Path::new(&dir);
    if !p.is_absolute() || p.parent().is_none() {
        return Err(format!("要给一个正常的绝对路径：{dir}"));
    }
    if !p.is_dir() {
        std::fs::create_dir_all(p).map_err(|e| format!("建不了这个目录：{e}"))?;
    }
    state
        .update_config(|c| {
            c.patch_out_dir = Some(dir);
            Ok(())
        })
        .await
        .map(|_| ())
}

/// 记住产物根。传空串 = 清掉，回到自动探测。
#[tauri::command]
pub async fn patch_set_out_root(
    state: tauri::State<'_, Arc<AppState>>,
    dir: Option<String>,
) -> Result<(), String> {
    let dir = dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(d) = &dir {
        if !Path::new(d).is_dir() {
            return Err(format!("产物根不存在：{d}"));
        }
    }
    state
        .update_config(|c| {
            c.patch_out_root = dir;
            Ok(())
        })
        .await
        .map(|_| ())
}

/// 在资源管理器里定位补丁包（或它所在的目录）。
#[tauri::command]
pub fn patch_reveal(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = Path::new(&path);
    if p.is_file() {
        app.opener()
            .reveal_item_in_dir(p)
            .map_err(|e| format!("打不开文件位置：{e}"))
    } else if p.is_dir() {
        app.opener()
            .open_path(path.clone(), None::<&str>)
            .map_err(|e| format!("打不开目录：{e}"))
    } else {
        Err(format!("路径不存在：{path}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 探测父目录先工作副本再父级() {
        let p = probe_parents(Some(Path::new(r"D:\ws\newar")));
        assert_eq!(p[0], PathBuf::from(r"D:\ws\newar"));
        assert_eq!(p[1], PathBuf::from(r"D:\ws"));
    }

    #[test]
    fn 没有工作区只剩已知工程根() {
        let p = probe_parents(None);
        assert_eq!(p.len(), KNOWN_PATCH_PARENTS.len());
        assert_eq!(p[0], PathBuf::from(KNOWN_PATCH_PARENTS[0]));
    }

    #[test]
    fn 父目录不重复出现() {
        // 工作副本父级恰好是已知工程根时不能探两遍（用真实补丁父目录当父级）
        let p = probe_parents(Some(Path::new(r"D:\NC技术文档\爱尔文档\补丁\newar")));
        let n = p
            .iter()
            .filter(|x| x.as_path() == Path::new(r"D:\NC技术文档\爱尔文档\补丁"))
            .count();
        assert_eq!(n, 1);
    }

    #[test]
    fn 找目录按父目录优先于目录名() {
        let a = std::env::temp_dir().join(format!("ncp-a-{}", std::process::id()));
        let b = std::env::temp_dir().join(format!("ncp-b-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
        // a 里只放了排第四的名字，b 里放了排第一的名字：仍应取 a 的（父目录优先）
        std::fs::create_dir_all(a.join("patches")).unwrap();
        std::fs::create_dir_all(b.join("待上线补丁")).unwrap();
        let got = first_existing_dir(&[a.clone(), b.clone()], &PATCH_DIR_NAMES);
        assert_eq!(got, Some(a.join("patches")));
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn 一个都没有就返回_none() {
        let d = std::env::temp_dir().join(format!("ncp-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(
            first_existing_dir(std::slice::from_ref(&d), &PATCH_DIR_NAMES),
            None
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 建议目录落在工作副本同级而不是里面() {
        // 与 patch_defaults 里 suggest 分支同一套算法
        let root = Path::new(r"D:\NC技术\newar");
        let base = root.parent().unwrap_or(root);
        assert_eq!(
            base.join(PATCH_DIR_NAMES[0]),
            PathBuf::from(r"D:\NC技术\待上线补丁")
        );
    }
}
