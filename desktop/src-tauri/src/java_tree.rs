//! Bounded, read-only source classification for the workspace tree.
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JavaKind {
    Class,
    Interface,
    Enum,
    Annotation,
    Record,
}

const MAX_SOURCE_BYTES: u64 = 512 * 1024;
pub const MAX_BATCH: usize = 64;

/// Only classify unambiguous compilation units with one top-level declaration.
fn source_kind(text: &str) -> Option<JavaKind> {
    // Java expands Unicode escapes before lexing; avoid giving uncertain files a specific icon.
    if text.contains("\\u") {
        return None;
    }
    let mut rest = text.trim_start_matches('\u{feff}');
    let mut previous = "";
    let mut depth = 0usize;
    let mut parens = 0usize;
    let mut declaration = None;
    let mut pending = None;
    let mut has_body = false;
    while let Some(ch) = rest.chars().next() {
        if ch.is_whitespace() {
            rest = &rest[ch.len_utf8()..];
            continue;
        }
        if let Some(line) = rest.strip_prefix("//") {
            rest = line.find(['\r', '\n']).map_or("", |end| &line[end..]);
            continue;
        }
        if let Some(comment) = rest.strip_prefix("/*") {
            rest = &comment[comment.find("*/")? + 2..];
            continue;
        }
        if matches!(ch, '\'' | '"') {
            let delimiter = if rest.starts_with("\"\"\"") {
                "\"\"\""
            } else {
                &rest[..1]
            };
            let mut body = &rest[delimiter.len()..];
            loop {
                if let Some(after) = body.strip_prefix(delimiter) {
                    rest = after;
                    break;
                }
                let next = body.chars().next()?;
                body = &body[next.len_utf8()..];
                if next == '\\' {
                    body = &body[body.chars().next()?.len_utf8()..];
                }
            }
            previous = "";
            continue;
        }
        if ch.is_alphabetic() || matches!(ch, '_' | '$') {
            let end = rest
                .find(|c: char| !c.is_alphanumeric() && !matches!(c, '_' | '$'))
                .unwrap_or(rest.len());
            let word = &rest[..end];
            rest = &rest[end..];
            if let Some(kind) = pending.take() {
                if declaration.replace(kind).is_some() {
                    return None;
                }
            } else if depth == 0 && parens == 0 && previous != "." {
                pending = match word {
                    "class" => Some(JavaKind::Class),
                    "interface" if previous == "@" => Some(JavaKind::Annotation),
                    "interface" => Some(JavaKind::Interface),
                    "enum" => Some(JavaKind::Enum),
                    "record" => Some(JavaKind::Record),
                    _ => None,
                };
            }
            previous = word;
            continue;
        }
        let symbol = &rest[..ch.len_utf8()];
        rest = &rest[ch.len_utf8()..];
        if pending.is_some() {
            return None;
        }
        match ch {
            '{' => {
                if depth == 0 && parens == 0 && declaration.is_some() {
                    has_body = true;
                }
                depth += 1;
            }
            '}' => depth = depth.checked_sub(1)?,
            '(' => parens += 1,
            ')' => parens = parens.checked_sub(1)?,
            _ => {}
        }
        previous = symbol;
    }
    if has_body && depth == 0 && parens == 0 && pending.is_none() {
        declaration
    } else {
        None
    }
}

fn classify_file(path: &Path) -> Option<JavaKind> {
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_SOURCE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return None;
    }
    match std::str::from_utf8(&bytes) {
        Ok(text) => source_kind(text),
        Err(_) => {
            let (text, _, errors) = encoding_rs::GBK.decode(&bytes);
            if errors {
                None
            } else {
                source_kind(&text)
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct SourceVersion {
    modified: SystemTime,
    size: u64,
}

struct CachedKind {
    version: SourceVersion,
    kind: Option<JavaKind>,
}

static KINDS: Mutex<BTreeMap<PathBuf, CachedKind>> = Mutex::new(BTreeMap::new());

fn version(path: &Path) -> Option<SourceVersion> {
    let metadata = path.metadata().ok()?;
    Some(SourceVersion {
        modified: metadata.modified().ok()?,
        size: metadata.len(),
    })
}

fn cached_kind(path: PathBuf) -> Option<JavaKind> {
    let current = version(&path)?;
    if let Ok(cache) = KINDS.lock() {
        if let Some(entry) = cache.get(&path).filter(|entry| entry.version == current) {
            return entry.kind;
        }
    }
    let kind = classify_file(&path);
    // Reading is outside the lock. A concurrent save invalidates the result before publication.
    if version(&path) != Some(current) {
        return None;
    }
    if let Ok(mut cache) = KINDS.lock() {
        if cache.len() >= 4096 && !cache.contains_key(&path) {
            cache.pop_first();
        }
        cache.insert(
            path,
            CachedKind {
                version: current,
                kind,
            },
        );
    }
    kind
}

pub fn kinds_in_directory(dir: &Path, names: Vec<String>) -> BTreeMap<String, JavaKind> {
    names
        .into_iter()
        .take(MAX_BATCH)
        .filter_map(|name| {
            if crate::workspace::validate_entry_name(&name).is_err()
                || !name.to_ascii_lowercase().ends_with(".java")
            {
                return None;
            }
            let candidate = dir.join(&name);
            let file = candidate.canonicalize().ok()?;
            if file.parent() != Some(dir) || !file.is_file() {
                return None;
            }
            Some((name, cached_kind(file)?))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_declaration_kinds_without_counting_comments_nested_types_or_class_literals() {
        assert_eq!(
            source_kind("// class Fake {}\n@Example(Fake.class) public interface Service {}"),
            Some(JavaKind::Interface)
        );
        assert_eq!(
            source_kind("public @interface Tag {}"),
            Some(JavaKind::Annotation)
        );
        assert_eq!(source_kind("enum Mode { A, B }"), Some(JavaKind::Enum));
        assert_eq!(source_kind("record Pair(int n) {}"), Some(JavaKind::Record));
        assert_eq!(
            source_kind(r#"class Demo { String text = "interface Fake {}"; class Nested {} }"#),
            Some(JavaKind::Class)
        );
    }

    #[test]
    fn refresh_uses_the_new_file_version_and_skips_non_children() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().canonicalize().unwrap();
        let file = dir.join("Service.java");
        let names = || vec!["Service.java".to_string(), "../Service.java".to_string()];
        std::fs::write(&file, "interface Service {}").unwrap();
        assert_eq!(
            kinds_in_directory(&dir, names()),
            BTreeMap::from([("Service.java".into(), JavaKind::Interface)])
        );
        std::fs::write(&file, "public class Service {} // refreshed").unwrap();
        assert_eq!(
            kinds_in_directory(&dir, names()),
            BTreeMap::from([("Service.java".into(), JavaKind::Class)])
        );
    }

    #[test]
    fn ambiguous_or_incomplete_sources_use_the_generic_icon() {
        assert_eq!(source_kind("class First {} interface Second {}"), None);
        assert_eq!(source_kind("interface Unfinished {"), None);
        assert_eq!(source_kind("/* enum Hidden {} */"), None);
        assert_eq!(source_kind("@Deprecated package nc;"), None);
    }
}
