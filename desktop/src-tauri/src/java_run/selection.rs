//! Resolve source declarations, not filename guesses, before private compilation.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub(super) struct SourceType {
    pub name: String,
    pub header: usize,
    pub start: usize,
    pub end: usize,
}
pub(super) fn source_types(text: &str) -> Vec<SourceType> {
    let clean = crate::build_state::strip_comments_and_literals(text);
    static PACKAGE: OnceLock<regex::Regex> = OnceLock::new();
    let package = PACKAGE
        .get_or_init(|| {
            regex::Regex::new(
                r"\bpackage\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s*;",
            )
            .expect("static Java package regex")
        })
        .captures(&clean)
        .and_then(|captures| captures.get(1))
        .map(|name| {
            name.as_str()
                .chars()
                .filter(|ch| !ch.is_whitespace())
                .collect::<String>()
        })
        .unwrap_or_default();
    let mut bodies = HashMap::new();
    for (name, _, offset) in crate::build_state::typed_declarations(&clean) {
        let mut parens = 0usize;
        for (at, ch) in clean[offset + name.len()..].char_indices() {
            match ch {
                '(' => parens += 1,
                ')' => parens = parens.saturating_sub(1),
                '{' if parens == 0 => {
                    bodies.insert(offset + name.len() + at, (name, offset));
                    break;
                }
                ';' if parens == 0 => break,
                _ => {}
            }
        }
    }
    let mut scopes: Vec<Option<usize>> = Vec::new();
    let mut types: Vec<SourceType> = Vec::new();
    for (offset, ch) in clean.char_indices() {
        if ch == '{' {
            let declared = bodies
                .remove(&offset)
                .filter(|_| scopes.iter().all(Option::is_some));
            let index = declared.map(|(name, header)| {
                let binary = if let Some(Some(owner)) = scopes.last() {
                    format!("{}${name}", types[*owner].name)
                } else if package.is_empty() {
                    name
                } else {
                    format!("{package}.{name}")
                };
                let index = types.len();
                types.push(SourceType {
                    name: binary,
                    header,
                    start: offset,
                    end: clean.len(),
                });
                index
            });
            scopes.push(index);
        } else if ch == '}' {
            if let Some(Some(index)) = scopes.pop() {
                types[index].end = offset;
            }
        }
    }
    types
}
pub(super) fn source_binary_names(text: &str) -> Vec<String> {
    source_types(text).into_iter().map(|t| t.name).collect()
}

fn source_names(path: &Path) -> Result<Vec<String>, String> {
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
        return Err(format!(
            "运行源码超过 2 MiB，请缩小运行范围：{}",
            path.display()
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(source_binary_names(&crate::workspace::decode_lossy(&bytes)))
}

pub fn selected_sources(
    root: &Path,
    selected: &[String],
    explicit: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    let wanted: HashSet<_> = selected
        .iter()
        .map(|s| s.split('#').next().unwrap_or("").to_string())
        .collect();
    let mut found: HashMap<String, PathBuf> = HashMap::new();
    if let Some(path) = explicit {
        for name in source_names(path)?
            .into_iter()
            .filter(|name| wanted.contains(name))
        {
            found.insert(name, path.into());
        }
    }
    // A chosen source takes priority over duplicate declarations in another source root.
    let remaining: HashSet<_> = wanted
        .iter()
        .filter(|name| !found.contains_key(*name))
        .cloned()
        .collect();
    if !remaining.is_empty() {
        for path in source_files(root)? {
            if explicit == Some(path.as_path()) {
                continue;
            }
            if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
                continue;
            }
            for name in source_names(&path)?
                .into_iter()
                .filter(|name| remaining.contains(name))
            {
                if let Some(previous) = found.insert(name.clone(), path.clone()) {
                    if previous != path {
                        return Err(format!(
                            "测试类 {name} 有多个源码来源，请明确选择其 Java 文件"
                        ));
                    }
                }
            }
        }
    }
    let mut missing: Vec<_> = wanted
        .iter()
        .filter(|name| !found.contains_key(*name))
        .cloned()
        .collect();
    missing.sort();
    if !missing.is_empty() {
        return Err(format!(
            "当前运行范围未找到这些类的源码，未执行旧输出：{}",
            missing.join(", ")
        ));
    }
    let mut files: Vec<_> = found.into_values().collect();
    files.sort();
    files.dedup();
    Ok(files)
}

pub fn test_sources(root: &Path, selected: &[String]) -> Result<Vec<PathBuf>, String> {
    if selected.is_empty() {
        source_files(root)
    } else {
        selected_sources(root, selected, None)
    }
}

fn source_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = pending.pop() {
        visited += 1;
        if visited > 10_000 {
            return Err("测试源码目录超过 10000 个，请缩小运行模块".into());
        }
        for entry in std::fs::read_dir(dir).map_err(|e| format!("读取测试源码失败：{e}"))?
        {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink()
                || crate::build_layout::is_reparse(&entry.metadata().map_err(|e| e.to_string())?)
            {
                continue;
            }
            if kind.is_dir() {
                if ![".git", ".svn", "node_modules", "target", "classes", "bin"]
                    .contains(&entry.file_name().to_string_lossy().as_ref())
                {
                    pending.push(path);
                }
            } else if path.extension().is_some_and(|e| e == "java") {
                found.push(path);
                if found.len() > 20_000 {
                    return Err("源码超过 20000 个，请缩小运行模块".into());
                }
            }
        }
    }
    Ok(found)
}
