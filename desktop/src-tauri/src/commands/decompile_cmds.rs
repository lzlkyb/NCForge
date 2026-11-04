//! 反编译命令：把 `jdt://` 指向的 jar 内类还原成 Java 源码。
//!
//! 纯逻辑（URI 解析、挑 jar、跑 CFR）在 `crate::decompile`，这里只负责
//! 「从配置里找 NC home / java / CFR 组件 / 工作区 jar」，把阻塞工作丢到后台线程。
//!
//! 为什么不做成「打开时静默失败就完了」：桩本身没有信息量，用户点进去就是想看实现。
//! 失败原因必须能回传（找不到 jar / 找不到组件 / CFR 超时），前端只对第一次失败提示一次。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::decompile;
use crate::nc_home;
use crate::nc_index;
use crate::resource_pack::{active_dir, PACK_CFR};
use crate::state::AppState;

/// 反编译结果。`jar` 是绝对路径，前端只用来告诉用户「这个类来自哪」。
#[derive(Debug, serde::Serialize)]
pub struct Decompiled {
    pub source: String,
    pub jar: String,
    pub class: String,
    pub ms: u64,
}

/// CFR 候选顺序：外部资源包（按需下载）→ 源码树资源（开发模式）。
///
/// 与 `find_ecj` 同一套：开发态下 `active_dir` 为空（没走过下载流程），
/// 只能落到 `CARGO_MANIFEST_DIR` 那份。资源包目录里只有一个 jar，不按版本号硬编码，
/// 换版本时不用改代码。
fn find_cfr(config_dir: &Path) -> Result<PathBuf, String> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(dir) = active_dir(config_dir, PACK_CFR) {
        cands.extend(jars_in(&dir));
    }
    cands.extend(jars_in(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("cfr"),
    ));
    cands.into_iter().find(|p| p.is_file()).ok_or_else(|| {
        "找不到反编译组件（CFR）。请到设置 → 组件里下载，或检查网络后重试".to_string()
    })
}

/// 目录下的 jar（含一层子目录，资源包解压后可能是 `cfr/cfr-0.152.jar`）。
fn jars_in(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_file() {
            if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("jar")) {
                out.push(p);
            }
        } else if p.is_dir() {
            out.extend(jars_in(&p));
        }
    }
    out
}

/// 工作区自己带的 jar：`<模块>/lib/*.jar` 与 `<模块>/*.jar`。
///
/// 不递归整棵树：工作区里 59 个模块、上万个文件，全盘找 jar 要几秒，而 NC 的二开
/// jar 只出现在模块根和 `lib` 下这两个位置（`.classpath` 的 `kind="lib"` 也指这两处）。
fn workspace_jars(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&p) else {
            continue;
        };
        for f in files.flatten() {
            let fp = f.path();
            if fp.is_file() {
                if fp
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case("jar"))
                {
                    out.push(fp);
                }
            } else if fp
                .file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("lib"))
            {
                out.extend(jars_in(&fp));
            }
        }
    }
    out
}

/// jar 候选清单的进程内缓存。
///
/// 真机实测 `classpath_jars` 遍历 4382 个路径要 **876 ms**——比反编译本身（577 ms）还贵，
/// 而这份清单在一次运行里几乎不变（装/卸 NC 组件才动）。缓存后第一个类付一次，
/// 之后每个类都是 0。
///
/// 键是「NC home + 工作区根」：换 NC 安装目录或切工作区必须重扫，否则会拿旧清单
/// 去反编译另一个环境里同名的 jar。工作区里**新加**的 jar 要重启才认——用户极少在
/// 会话中途往模块里丢 jar，为此每次做 stat 校验不值得。
static JAR_CACHE: std::sync::Mutex<Option<(String, Arc<Vec<PathBuf>>)>> =
    std::sync::Mutex::new(None);

fn jar_candidates(nc_home: &str, root: Option<&str>) -> Arc<Vec<PathBuf>> {
    let key = format!("{nc_home}\u{1}{}", root.unwrap_or(""));
    // 只在锁里做「查」：扫盘要 876 ms，持锁扫会把并发的第二个类（比如连点两个
    // 未打开的 jar 类）白卡一秒，还占着 spawn_blocking 的线程。同 crate 的
    // `INDEX_GATE` 注释写过同一条：锁内不做重活。
    {
        let guard = JAR_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((k, jars)) = guard.as_ref() {
            if *k == key {
                return Arc::clone(jars);
            }
        }
    }
    let mut jars = nc_index::classpath_jars(Path::new(nc_home));
    if let Some(root) = root {
        jars.extend(workspace_jars(Path::new(root)));
    }
    let jars = Arc::new(jars);
    let mut guard = JAR_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    // 扫盘期间别人可能刚填好同一份清单：用它那份，别让两个 Arc 各存一份
    if let Some((k, existing)) = guard.as_ref() {
        if *k == key {
            return Arc::clone(existing);
        }
    }
    *guard = Some((key, Arc::clone(&jars)));
    jars
}

/// 反编译 `uri` 指向的类。
///
/// 失败都用 `Err(String)` 回传给前端——前端只对「第一次反编译失败」提示一次，
/// 之后同一个类不再打扰（`useFileSession` 里记住失败过的 uri）。
#[tauri::command]
pub async fn decompile_class(
    state: tauri::State<'_, Arc<AppState>>,
    uri: String,
) -> Result<Decompiled, String> {
    let class = decompile::parse_jdt_uri(&uri)
        .ok_or_else(|| "这个地址不是 jar 内的类，无法反编译".to_string())?;
    let (config_dir, nc_home_cfg, root) = {
        let cfg = state.config.read().await;
        (
            state.config_dir.clone(),
            cfg.nc_home.clone(),
            cfg.workspace_root.clone(),
        )
    };
    let home = nc_home::resolve(nc_home_cfg.as_deref())?;
    let java = PathBuf::from(&home.java);
    let cfr = find_cfr(&config_dir)?;

    let started = Instant::now();
    // 找 jar 与跑 CFR 都是阻塞 I/O + 子进程，必须离开 async 线程
    let source = tauri::async_runtime::spawn_blocking(move || {
        let candidates = jar_candidates(&home.root, root.as_deref());
        let jar = decompile::pick_jar(&class.jar_name, &candidates).ok_or_else(|| {
            format!(
                "在 NC 安装目录与工作区里都没找到 {}，它可能来自已卸载的组件",
                class.jar_name
            )
        })?;
        let source = decompile::run_cfr(&java, &cfr, &jar, &class.entry)?;
        Ok::<(String, PathBuf), String>((source, jar))
    })
    .await
    .map_err(|e| format!("反编译任务异常：{e}"))??;
    let (source, jar) = source;

    Ok(Decompiled {
        source,
        jar: jar.to_string_lossy().to_string(),
        class: class.fqcn,
        ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 工作区只认模块根与_lib_下的_jar() {
        let tmp = std::env::temp_dir().join(format!("ncf-decompile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let mod_a = tmp.join("bill");
        std::fs::create_dir_all(mod_a.join("lib")).unwrap();
        std::fs::create_dir_all(mod_a.join("src")).unwrap();
        std::fs::write(mod_a.join("a.jar"), b"x").unwrap();
        std::fs::write(mod_a.join("lib").join("b.jar"), b"x").unwrap();
        // `src` 下的 jar 不是类路径（那是源码目录里的杂物），不该被收
        std::fs::write(mod_a.join("src").join("c.jar"), b"x").unwrap();

        let mut got: Vec<String> = workspace_jars(&tmp)
            .iter()
            .map(|p| {
                p.strip_prefix(&tmp)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        got.sort();
        assert_eq!(got, ["bill/a.jar", "bill/lib/b.jar"]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 真机：第一次扫盘要多久、之后是不是真的 0 成本。`--ignored 缓存` 单独跑。
    #[test]
    #[ignore]
    fn 缓存让第二次找_jar_不再扫盘() {
        let home = r"D:\ncc\1909home";
        if !Path::new(home).is_dir() {
            eprintln!("跳过：本机没有 {home}");
            return;
        }
        let t = Instant::now();
        let first = jar_candidates(home, None);
        let first_ms = t.elapsed().as_millis();
        let t = Instant::now();
        let second = jar_candidates(home, None);
        let second_ms = t.elapsed().as_millis();
        eprintln!(
            "候选 {} 个：首次 {first_ms} ms，第二次 {second_ms} ms",
            first.len()
        );
        assert!(
            Arc::ptr_eq(&first, &second),
            "第二次应命中缓存（同一个 Arc）"
        );
        assert!(second_ms <= 5, "缓存命中不该再扫盘，实测 {second_ms} ms");
    }
}
