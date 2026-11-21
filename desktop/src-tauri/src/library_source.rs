//! Read only the source attached to this exact binary archive, never a basename match.
use std::path::Path;

pub struct AttachedSource {
    pub text: String,
    pub origin: String,
}
struct Cursor<'a> {
    raw: &'a [u8],
    offset: usize,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, size: usize) -> Option<&'a [u8]> {
        let end = self.offset.checked_add(size)?;
        let result = self.raw.get(self.offset..end)?;
        self.offset = end;
        Some(result)
    }
    fn byte(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn short(&mut self) -> Option<usize> {
        Some(u16::from_be_bytes(self.take(2)?.try_into().ok()?) as usize)
    }
    fn word(&mut self) -> Option<usize> {
        usize::try_from(u32::from_be_bytes(self.take(4)?.try_into().ok()?)).ok()
    }
    fn skip_attributes(&mut self) -> Option<()> {
        let count = self.short()?;
        for _ in 0..count {
            self.short()?;
            let size = self.word()?;
            self.take(size)?;
        }
        Some(())
    }
}
fn source_file(raw: &[u8]) -> Option<String> {
    let mut cursor = Cursor { raw, offset: 0 };
    if cursor.take(4)? != [0xca, 0xfe, 0xba, 0xbe] {
        return None;
    }
    cursor.take(4)?;
    let count = cursor.short()?;
    let mut strings = vec![None; count];
    let mut index = 1;
    while index < count {
        match cursor.byte()? {
            1 => {
                let size = cursor.short()?;
                strings[index] = crate::class_pool::decode_mutf8(cursor.take(size)?);
            }
            3 | 4 | 9 | 10 | 11 | 12 | 17 | 18 => {
                cursor.take(4)?;
            }
            5 | 6 => {
                cursor.take(8)?;
                index += 1;
            }
            7 | 8 | 16 | 19 | 20 => {
                cursor.take(2)?;
            }
            15 => {
                cursor.take(3)?;
            }
            _ => return None,
        }
        index += 1;
    }
    cursor.take(6)?;
    let interfaces = cursor.short()?;
    cursor.take(interfaces.checked_mul(2)?)?;
    // SourceFile is a class attribute, not an arbitrary string in its constant pool.
    for _ in 0..2 {
        let members = cursor.short()?;
        for _ in 0..members {
            cursor.take(6)?;
            cursor.skip_attributes()?;
        }
    }
    let attributes = cursor.short()?;
    for _ in 0..attributes {
        let name = cursor.short()?;
        let size = cursor.word()?;
        let value = cursor.take(size)?;
        if strings.get(name)?.as_deref() == Some("SourceFile") && size == 2 {
            let source = u16::from_be_bytes(value.try_into().ok()?) as usize;
            let name = strings.get(source)?.as_ref()?;
            if name.ends_with(".java") && !name.contains(['/', '\\', ':', '\0']) {
                return Some(name.clone());
            }
        }
    }
    None
}
fn source_entry(entry: &str, bytes: &[u8]) -> Option<String> {
    let stem = entry.strip_suffix(".class")?;
    let package = entry
        .rsplit_once('/')
        .map(|(p, _)| format!("{p}/"))
        .unwrap_or_default();
    Some(
        source_file(bytes)
            .map(|name| format!("{package}{name}"))
            .unwrap_or_else(|| format!("{stem}.java")),
    )
}
pub fn read_attached(
    jar: &Path,
    entry: &str,
    class_bytes: &[u8],
    project_roots: &[String],
    allowed: &[String],
) -> Result<Option<AttachedSource>, String> {
    let Some(entry) = source_entry(entry, class_bytes) else {
        return Ok(None);
    };
    let attached = project_roots
        .iter()
        .find_map(|root| {
            crate::classpath_sources::source_for(
                &crate::classpath_sources::attachments(Path::new(root)),
                jar,
            )
        })
        .or_else(|| crate::shadow::src_jar_of(jar));
    let Some(attached) = attached else {
        return Ok(None);
    };
    if !attached.exists() {
        return Ok(None);
    }
    let attached =
        crate::security::path::resolve_safe_path(&attached.to_string_lossy(), allowed, &[], true)?;
    let raw = match crate::library_index::read_entry(&attached, &entry, attached.is_file()) {
        Ok(raw) => raw,
        Err(_) => return Ok(None), // Missing member or unreadable attachment: use the binary implementation.
    };
    if raw.contains(&0) && crate::workspace::utf16_encoding(&raw).is_none() {
        return Ok(None);
    }
    Ok(Some(AttachedSource {
        text: crate::workspace::decode_lossy(&raw),
        origin: format!(
            "{} ! {entry}",
            crate::security::path::display_path(&attached)
        ),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn class_with_source(name: &str) -> Vec<u8> {
        let mut bytes = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 3];
        for value in ["SourceFile", name] {
            bytes.push(1);
            bytes.extend_from_slice(&(value.len() as u16).to_be_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        bytes.extend_from_slice(&[0; 12]);
        bytes.extend_from_slice(&[0, 1, 0, 1, 0, 0, 0, 2, 0, 2]);
        bytes
    }
    fn archive(path: &Path, entry: &str, raw: &[u8]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        zip.start_file(entry, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(raw).unwrap();
        zip.finish().unwrap();
    }
    #[test]
    fn inner_classes_use_the_verified_source_file_and_not_a_dollar_heuristic() {
        assert_eq!(
            source_entry("p/Outer$Inner.class", &class_with_source("Outer.java")).as_deref(),
            Some("p/Outer.java")
        );
        assert_eq!(
            source_entry("p/A$B.class", &class_with_source("A$B.java")).as_deref(),
            Some("p/A$B.java")
        );
        assert_eq!(
            source_entry("p/Outer$Inner.class", b"invalid").as_deref(),
            Some("p/Outer$Inner.java")
        );
        assert!(source_file(&class_with_source("../Wrong.java")).is_none());
        let class = class_with_source("Outer.java");
        for end in 0..class.len() {
            assert!(source_file(&class[..end]).is_none());
        }
    }
    #[test]
    fn exact_binary_path_encoding_missing_entry_and_root_boundary() {
        let dir = crate::test_support::tmp("library-source");
        let project = dir.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let jar = project.join("a.jar");
        std::fs::write(&jar, []).unwrap();
        let sources = project.join("sources.jar");
        let raw = encoding_rs::GBK
            .encode("package p; // 中文源码")
            .0
            .into_owned();
        archive(&sources, "p/Outer.java", &raw);
        let xml = crate::classpath_sources::plan(
            &project,
            "<classpath></classpath>",
            &jar,
            Some(&sources),
            "",
        )
        .unwrap();
        std::fs::write(project.join(".classpath"), xml).unwrap();
        let roots = vec![project.to_string_lossy().into_owned()];
        let result = read_attached(
            &jar,
            "p/Outer$Inner.class",
            &class_with_source("Outer.java"),
            &roots,
            &roots,
        )
        .unwrap()
        .unwrap();
        assert!(result.text.contains("中文源码"));
        assert!(result.origin.ends_with("sources.jar ! p/Outer.java"));
        assert!(
            read_attached(&dir.join("a.jar"), "p/Outer.class", b"", &roots, &roots)
                .unwrap()
                .is_none()
        );
        assert!(read_attached(&jar, "p/Other.class", b"", &roots, &roots)
            .unwrap()
            .is_none());
        let external = dir.join("external.jar");
        archive(&external, "p/Outer.java", b"package p;");
        let xml = crate::classpath_sources::plan(
            &project,
            "<classpath></classpath>",
            &jar,
            Some(&external),
            "",
        )
        .unwrap();
        std::fs::write(project.join(".classpath"), xml).unwrap();
        assert!(read_attached(&jar, "p/Outer.class", b"", &roots, &roots).is_err());
        // Without explicit settings, use the same NC companion convention as shadow JDT.
        std::fs::remove_file(project.join(".classpath")).unwrap();
        archive(
            &project.join("a_src.jar"),
            "p/Outer.java",
            b"package p; // NC source",
        );
        let standard = read_attached(&jar, "p/Outer.class", b"", &roots, &roots)
            .unwrap()
            .unwrap();
        assert!(standard.text.contains("NC source"));
        assert!(standard.origin.ends_with("a_src.jar ! p/Outer.java"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
