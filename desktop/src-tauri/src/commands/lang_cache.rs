//! 代码智能的索引缓存：看得到、清得掉。
//!
//! 缓存按「工作区 + 模块 + NC home + jdt.ls 目录」各存一份（`lang_cmds::data_dir_for`），
//! 保留最近用过的若干份。多项目场景下（顾问同时跟三个工程）份数会累积到几 GB，
//! 没有入口的话只能去 AppData 里翻——那不是一个工作台该让用户做的事。
//!
//! 只动 `<config_dir>/lang/jdtls-ws/` 下自己的目录：符号链接与 junction 一律不碰，
//! 语言服务正在跑时拒绝清理（它正在写那份目录，删了会立刻出错）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

const CACHE_SUBDIR: &str = "jdtls-ws";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LangCacheStats {
    /// 有几份缓存（一个「工程 + 形态」一份：flat 下全工作区只占一份，single 回滚路径才按模块）。
    pub count: usize,
    /// 合计占用字节数。目录很大时遍历要一点时间，所以这个命令是 async 的。
    pub bytes: u64,
    pub dir: String,
    /// 语言服务在跑：清理会被拒绝，UI 据此把按钮灰掉。
    pub busy: bool,
}

fn cache_root(state: &AppState) -> PathBuf {
    state.config_dir.join("lang").join(CACHE_SUBDIR)
}

/// 可以放心递归统计/删除的普通目录：符号链接与 junction 一律不算
/// （`symlink_metadata` 不跟随链接，junction 在 Windows 上也报成符号链接）。
fn plain_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

/// 递归算目录体积。只统计普通文件；读不到（权限/正在被删）就跳过，不中断。
fn dir_size(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in rd.flatten() {
        let path = entry.path();
        match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() => total += m.len(),
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => total += dir_size(&path),
            _ => {}
        }
    }
    total
}

fn busy(state: &AppState) -> bool {
    let run = state.lang.lock().unwrap_or_else(|e| e.into_inner());
    in_use(&run)
}

pub(crate) fn in_use(run: &crate::lang::LangRun) -> bool {
    run.session.is_some() || matches!(run.status.state.as_str(), "starting" | "indexing" | "ready")
}

/// 缓存现状。语言服务在跑时仍然可以统计（读的是磁盘，不碰进程）。
#[tauri::command]
pub async fn lang_cache_stats(state: State<'_, Arc<AppState>>) -> Result<LangCacheStats, String> {
    let root = cache_root(&state);
    let busy = busy(&state);
    let dir = root.display().to_string();
    let stats = tauri::async_runtime::spawn_blocking(move || {
        let Ok(rd) = std::fs::read_dir(&root) else {
            return (0usize, 0u64);
        };
        let dirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| plain_dir(p))
            .collect();
        let count = dirs.len();
        let bytes = dirs.iter().map(|d| dir_size(d)).sum();
        (count, bytes)
    })
    .await
    .map_err(|e| format!("统计索引缓存失败: {e}"))?;
    Ok(LangCacheStats {
        count: stats.0,
        bytes: stats.1,
        dir,
        busy,
    })
}

/// 清掉全部索引缓存。返回删掉的份数。
///
/// 拒绝在语言服务运行时执行：它正握着其中一份目录（索引库、临时文件），
/// 删掉的表现是「代码智能突然报错」，而用户只是想腾点空间。
#[tauri::command]
pub async fn lang_cache_clear(state: State<'_, Arc<AppState>>) -> Result<usize, String> {
    let state = state.inner().clone();
    let root = cache_root(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let _cache = state
            .language_cache
            .try_write()
            .map_err(|_| "代码智能正在准备索引，稍后再清理".to_string())?;
        let run = state.lang.lock().unwrap_or_else(|error| error.into_inner());
        if in_use(&run) {
            return Err("代码智能正在运行，先停止再清理索引缓存".into());
        }
        let Ok(rd) = std::fs::read_dir(&root) else {
            return Ok(0usize);
        };
        let dirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| plain_dir(p))
            .collect();
        let mut removed = 0usize;
        for d in dirs {
            if std::fs::remove_dir_all(&d).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    })
    .await
    .map_err(|e| format!("清理索引缓存失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 体积统计要穿透子目录：jdt.ls 的索引库是 `data/.metadata/.plugins/...` 这种深路径，
    /// 只算一层会报出「几十 KB」，用户看着像是清不出空间。
    #[test]
    fn 体积统计穿透子目录() {
        let root = crate::test_support::tmp("cache-size");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/x.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(root.join("a/b/y.bin"), vec![0u8; 200]).unwrap();
        assert_eq!(dir_size(&root), 300);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 符号链接不能被当成目录统计：`plain_dir` 是删除前的守卫，
    /// 它的判据一旦松掉，清理就可能顺着链接删到用户目录里去。
    #[test]
    fn 目录守卫不认符号链接() {
        let root = crate::test_support::tmp("cache-link");
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::write(root.join("real/a.bin"), vec![0u8; 10]).unwrap();
        assert!(plain_dir(&root.join("real")));
        assert!(!plain_dir(&root.join("real/a.bin")));
        assert!(!plain_dir(&root.join("nope")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
