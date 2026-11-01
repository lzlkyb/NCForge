//! 同目录临时文件 + 原子替换。
//!
//! 以前这四处（保存文件 / 打补丁包 / 导出结果集 / 改 NC 端口）各自手写
//! `.{name}.{pid}.nc-tmp` + `rename`，有两个坑：
//!
//! 1. **同进程并发撞名**：临时名只带 pid，同一进程里两个线程同时写同一个目标
//!    （或两个目标同名不同目录）就会互相踩。`tempfile` 用随机名 + 独占创建解决。
//! 2. **失败路径靠人记**：每个调用点都要记得在 `rename` 失败时删掉临时文件，
//!    漏一个就在用户目录里留垃圾。`NamedTempFile` 析构时自动删除，成功才 `persist`。
//!
//! 语义（与 POSIX rename 一致）：目标已存在则整体替换，不会出现「半个新文件」。

use std::io::Write;
use std::path::{Path, PathBuf};

/// 把一个已完整的字节串原子写到 `path`。
///
/// 适合「内存里已经拼好整份内容」的场景（保存源文件、改写配置）。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut target = AtomicTarget::create(path)?;
    target
        .as_file_mut()
        .write_all(bytes)
        .map_err(|e| format!("写临时文件失败: {e}"))?;
    target.commit()
}

/// 「边写边算」场景（大结果集导出、zip 打包）：先拿临时文件，写完再提交。
///
/// 不 `commit` 就析构 = 放弃本次写入，临时文件自动删除——所以失败路径只要
/// `return Err(...)`，不需要任何清理代码。
pub struct AtomicTarget {
    tmp: tempfile::NamedTempFile,
    dest: PathBuf,
}

impl AtomicTarget {
    /// 在目标**同目录**建临时文件。
    ///
    /// 必须同目录：跨分区 rename 不是原子操作（Windows 上直接报错），
    /// 而用户的目标可能在工作区、也可能是别的盘。
    pub fn create(dest: &Path) -> Result<Self, String> {
        let dir = dest.parent().ok_or("目标路径没有上级目录")?;
        if !dir.is_dir() {
            return Err(format!("目录不存在：{}", dir.display()));
        }
        let tmp = tempfile::Builder::new()
            .prefix(".ncforge-")
            .suffix(".tmp")
            .tempfile_in(dir)
            .map_err(|e| format!("建临时文件失败：{e}"))?;
        Ok(Self {
            tmp,
            dest: dest.to_path_buf(),
        })
    }

    pub fn as_file_mut(&mut self) -> &mut std::fs::File {
        self.tmp.as_file_mut()
    }

    /// 临时文件的路径。给那些「必须拿到路径才能写」的 writer（zip、导出）用：
    /// 它们自己 `File::create` 这个路径，写完后调用方再 `commit`。
    pub fn path(&self) -> &Path {
        self.tmp.path()
    }

    /// 落到目标路径。Windows 上 `persist` 会覆盖同名目标（`MoveFileEx` 带 replace）。
    pub fn commit(self) -> Result<(), String> {
        self.tmp
            .persist(&self.dest)
            .map(|_| ())
            .map_err(|e| format!("替换原文件失败（文件可能只读或被占用）: {}", e.error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-atomic-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn overwrites_existing_file() {
        let d = tmpdir("over");
        let p = d.join("a.txt");
        std::fs::write(&p, b"old").unwrap();
        write_atomic(&p, b"new").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
    }

    #[test]
    fn abort_leaves_target_untouched_and_cleans_temp() {
        let d = tmpdir("abort");
        let p = d.join("a.txt");
        std::fs::write(&p, b"keep").unwrap();
        {
            let mut t = AtomicTarget::create(&p).unwrap();
            t.as_file_mut().write_all(b"partial").unwrap();
            // 不 commit：模拟中途失败
        }
        assert_eq!(std::fs::read(&p).unwrap(), b"keep");
        let left: Vec<_> = std::fs::read_dir(&d).unwrap().collect();
        assert_eq!(left.len(), 1, "临时文件必须被清掉");
    }

    #[test]
    fn missing_directory_is_a_readable_error() {
        let d = tmpdir("nodir");
        let p = d.join("nope").join("a.txt");
        let err = write_atomic(&p, b"x").unwrap_err();
        assert!(err.contains("目录不存在"), "{err}");
    }
}
