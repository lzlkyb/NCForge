//! Source and documentation attachments stay in Eclipse's .classpath, the project truth.
//! Updates replace only the selected entry; comments and unrelated XML are preserved.
use regex::Regex;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct LibraryAttachment {
    pub jar: PathBuf,
    pub source: Option<PathBuf>,
    pub javadoc: String,
}
fn attrs() -> Regex {
    Regex::new(r#"([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
        .expect("constant XML attribute pattern")
}
fn value(tag: &str, name: &str) -> Option<String> {
    attrs().captures_iter(tag).find(|c| &c[1] == name).map(|c| {
        decode(
            c.get(2)
                .or_else(|| c.get(3))
                .expect("attribute value")
                .as_str(),
        )
    })
}
fn decode(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn tags(xml: &str, name: &str) -> Vec<(usize, usize)> {
    let mut result = Vec::new();
    let mut position = 0;
    while let Some(start) = xml[position..].find('<').map(|i| i + position) {
        if xml[start..].starts_with("<!--") {
            position = xml[start..]
                .find("-->")
                .map(|i| start + i + 3)
                .unwrap_or(xml.len());
            continue;
        }
        let mut quote = None;
        let mut end = xml.len();
        for (offset, ch) in xml[start..].char_indices().skip(1) {
            if quote == Some(ch) {
                quote = None;
            } else if quote.is_none() && (ch == '\"' || ch == '\'') {
                quote = Some(ch);
            } else if quote.is_none() && ch == '>' {
                end = start + offset + 1;
                break;
            }
        }
        let tail = &xml[start + 1..end];
        if tail.starts_with(name)
            && tail[name.len()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_whitespace() || c == '/' || c == '>')
        {
            result.push((start, end));
        }
        position = end;
        if position >= xml.len() {
            break;
        }
    }
    result
}
fn resolve(root: &Path, path: &str) -> PathBuf {
    let raw = PathBuf::from(path);
    if path.starts_with('/') {
        let workspace = root
            .parent()
            .unwrap_or(root)
            .join(path.trim_start_matches('/'));
        if workspace.exists() {
            return workspace;
        }
    }
    if raw.is_absolute() {
        raw
    } else {
        root.join(raw)
    }
}
fn same(left: &Path, right: &Path) -> bool {
    let key = |p: &Path| {
        crate::security::path::display_path(&p.canonicalize().unwrap_or_else(|_| p.to_path_buf()))
            .replace('\\', "/")
            .to_lowercase()
    };
    key(left) == key(right)
}
fn set_attr(tag: &str, name: &str, text: &str) -> String {
    for cap in attrs().captures_iter(tag) {
        if &cap[1] != name {
            continue;
        }
        let span = cap.get(2).or_else(|| cap.get(3)).expect("attribute value");
        let mut result = tag.to_string();
        result.replace_range(span.range(), &escape(text));
        return result;
    }
    let end = tag
        .rfind('/')
        .filter(|&i| tag[i..].trim() == "/>")
        .unwrap_or(tag.len() - 1);
    format!("{} {name}=\"{}\"{}", &tag[..end], escape(text), &tag[end..])
}
fn document_location(entry: &str) -> String {
    tags(entry, "attribute")
        .into_iter()
        .find_map(|(start, end)| {
            let tag = &entry[start..end];
            (value(tag, "name").as_deref() == Some("javadoc_location"))
                .then(|| value(tag, "value").unwrap_or_default())
        })
        .unwrap_or_default()
}
fn set_documentation(entry: &str, url: &str) -> Result<String, String> {
    for (start, end) in tags(entry, "attribute") {
        let tag = &entry[start..end];
        if value(tag, "name").as_deref() != Some("javadoc_location") {
            continue;
        }
        let mut result = entry.to_string();
        result.replace_range(start..end, &set_attr(tag, "value", url));
        return Ok(result);
    }
    if url.is_empty() {
        return Ok(entry.into());
    }
    let extra = format!(
        "<attribute name=\"javadoc_location\" value=\"{}\"/>",
        escape(url)
    );
    if let Some(end) = entry.find("</attributes>") {
        let mut result = entry.to_string();
        result.insert_str(end, &extra);
        return Ok(result);
    }
    let child = format!("<attributes>{extra}</attributes>");
    if entry.trim_end().ends_with("/>") {
        let end = entry.rfind("/>").expect("self closing entry");
        return Ok(format!("{}>{child}</classpathentry>", &entry[..end]));
    }
    let end = entry
        .rfind("</classpathentry>")
        .ok_or(".classpath 条目不完整")?;
    let mut result = entry.to_string();
    result.insert_str(end, &child);
    Ok(result)
}
fn entry_end(xml: &str, end: usize) -> Result<usize, String> {
    if xml[..end].trim_end().ends_with("/>") {
        Ok(end)
    } else {
        xml[end..]
            .find("</classpathentry>")
            .map(|i| end + i + "</classpathentry>".len())
            .ok_or_else(|| ".classpath 条目缺少结束标签".into())
    }
}
pub fn attachments(root: &Path) -> Vec<LibraryAttachment> {
    let Ok(xml) = std::fs::read_to_string(root.join(".classpath")) else {
        return Vec::new();
    };
    tags(&xml, "classpathentry")
        .into_iter()
        .filter_map(|(start, end)| {
            let tag = &xml[start..end];
            if value(tag, "kind").as_deref() != Some("lib") {
                return None;
            }
            let jar = resolve(root, &value(tag, "path")?);
            let source = value(tag, "sourcepath")
                .filter(|v| !v.is_empty())
                .map(|v| resolve(root, &v));
            let entry_end = entry_end(&xml, end).ok()?;
            Some(LibraryAttachment {
                jar,
                source,
                javadoc: document_location(&xml[start..entry_end]),
            })
        })
        .collect()
}
pub fn plan(
    root: &Path,
    xml: &str,
    jar: &Path,
    source: Option<&Path>,
    javadoc: &str,
) -> Result<String, String> {
    if xml.len() > 1024 * 1024 {
        return Err(".classpath 超过 1 MiB，无法安全修改".into());
    }
    if tags(xml, "classpath").len() != 1 || !xml.contains("</classpath>") {
        return Err(".classpath 格式不完整".into());
    }
    let candidates: Vec<_> = tags(xml, "classpathentry")
        .into_iter()
        .filter(|(start, end)| {
            let tag = &xml[*start..*end];
            value(tag, "kind").as_deref() == Some("lib")
                && value(tag, "path").is_some_and(|p| same(&resolve(root, &p), jar))
        })
        .collect();
    if candidates.len() > 1 {
        return Err("该 JAR 在 .classpath 中重复，请先消除重复条目".into());
    }
    let source = source
        .map(|p| crate::security::path::display_path(p).replace('\\', "/"))
        .unwrap_or_default();
    if let Some(&(start, end)) = candidates.first() {
        let last = entry_end(xml, end)?;
        let entry = format!(
            "{}{}",
            set_attr(&xml[start..end], "sourcepath", &source),
            &xml[end..last]
        );
        let changed = set_documentation(&entry, javadoc)?;
        let mut result = xml.to_string();
        result.replace_range(start..last, &changed);
        Ok(result)
    } else {
        let tag = format!(
            "<classpathentry kind=\"lib\" path=\"{}\" sourcepath=\"{}\"/>",
            escape(&crate::security::path::display_path(jar).replace('\\', "/")),
            escape(&source)
        );
        let entry = set_documentation(&tag, javadoc)?;
        let end = xml.rfind("</classpath>").expect("checked closing tag");
        let mut result = xml.to_string();
        result.insert_str(end, &format!("\t{entry}\n"));
        Ok(result)
    }
}
pub fn apply_shadow_javadoc(xml: &str, attachments: &[LibraryAttachment]) -> String {
    let mut result = xml.to_string();
    for (start, end) in tags(xml, "classpathentry").into_iter().rev() {
        let tag = &xml[start..end];
        let Some(path) = value(tag, "path") else {
            continue;
        };
        let Some(attachment) = attachments
            .iter()
            .find(|a| same(&a.jar, Path::new(&path)) && !a.javadoc.is_empty())
        else {
            continue;
        };
        if let Ok(changed) = set_documentation(tag, &attachment.javadoc) {
            result.replace_range(start..end, &changed);
        }
    }
    result
}
pub fn source_for(attachments: &[LibraryAttachment], jar: &Path) -> Option<PathBuf> {
    attachments
        .iter()
        .find(|a| same(&a.jar, jar))
        .and_then(|a| a.source.clone())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_comments_single_quotes_and_other_entries() {
        let xml="<classpath><!-- <classpathentry kind=\"lib\" path=\"a.jar\"/> --><classpathentry kind='lib' path='a.jar' sourcepath='old.jar'/><classpathentry kind=\"src\" path=\"src\"/></classpath>";
        let result = plan(
            Path::new("."),
            xml,
            Path::new("./a.jar"),
            Some(Path::new("src&1.jar")),
            "https://example.test/docs?a=1&b=2",
        )
        .unwrap();
        assert!(result.contains("<!-- <classpathentry kind=\"lib\" path=\"a.jar\"/> -->"));
        assert!(result.contains("sourcepath='src&amp;1.jar'"));
        assert!(result.contains("a=1&amp;b=2"));
        assert!(result.contains("kind=\"src\" path=\"src\""));
    }
    #[test]
    fn keeps_existing_access_rules_and_updates_javadoc() {
        let xml="<classpath><classpathentry kind=\"lib\" path=\"a.jar\"><accessrules><accessrule kind=\"accessible\" pattern=\"**\"/></accessrules><attributes><attribute name=\"javadoc_location\" value=\"old\"/></attributes></classpathentry></classpath>";
        let result = plan(
            Path::new("."),
            xml,
            Path::new("./a.jar"),
            None,
            "https://example.test/new",
        )
        .unwrap();
        assert!(result.contains("accessrule kind=\"accessible\""));
        assert!(result.contains("value=\"https://example.test/new\""));
        assert_eq!(result.matches("javadoc_location").count(), 1);
    }
    #[test]
    fn adds_explicit_library_and_rejects_duplicate_entries() {
        assert!(plan(
            Path::new("."),
            "<classpath></classpath>",
            Path::new("a.jar"),
            None,
            ""
        )
        .unwrap()
        .contains("kind=\"lib\""));
        let xml="<classpath><classpathentry kind=\"lib\" path=\"a.jar\"/><classpathentry kind=\"lib\" path=\"a.jar\"/></classpath>";
        assert!(plan(Path::new("."), xml, Path::new("./a.jar"), None, "").is_err());
    }
    #[test]
    fn persisted_attachments_are_read_back_into_shadow_classpath() {
        let dir = crate::test_support::tmp("classpath-sources-persist");
        let jar = dir.join("library-1.0.jar");
        let source = dir.join("library-1.0-sources.jar");
        std::fs::write(&jar, []).unwrap();
        std::fs::write(&source, []).unwrap();
        let xml = plan(
            &dir,
            "<classpath></classpath>",
            &jar,
            Some(&source),
            "https://example.test/docs?a=1&b=2",
        )
        .unwrap();
        std::fs::write(dir.join(".classpath"), xml).unwrap();
        let attachments = attachments(&dir);
        let attached = source_for(&attachments, &jar).unwrap();
        assert!(same(&attached, &source));
        let jars = vec![(jar, Some(attached))];
        let rendered = crate::shadow::render_classpath(&crate::shadow::ClasspathInputs {
            src_dirs: &[],
            src_outputs: &[],
            class_dirs: &[],
            jars: &jars,
        });
        let rendered = apply_shadow_javadoc(&rendered, &attachments);
        assert!(rendered.contains("library-1.0-sources.jar"));
        assert!(rendered.contains("javadoc_location"));
        assert!(rendered.contains("a=1&amp;b=2"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
