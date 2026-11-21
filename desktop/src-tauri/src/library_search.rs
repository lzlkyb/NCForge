//! 库文件的名称/内容查询；与工作区替换范围分开，只返回只读目标。
use crate::library_index::{self, Catalog};
use crate::search::{DocumentMatcher, MatchRange, SearchOptions};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHit {
    pub source: String,
    pub entry: String,
    pub archive: bool,
    pub class: bool,
    pub line: u32,
    pub column: u32,
    pub text: String,
    pub ranges: Vec<MatchRange>,
}
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryOutcome {
    pub items: Vec<LibraryHit>,
    pub building: bool,
    pub stale: bool,
    pub cancelled: bool,
    pub truncated: bool,
    pub scanned: usize,
    pub skipped: usize,
    pub error: Option<String>,
}
fn name_matches(query: &str, name: &str) -> bool {
    if let Some(class) = name.strip_suffix(".class") {
        return crate::java_types::type_match_score_with(
            query
                .trim()
                .to_ascii_lowercase()
                .trim_end_matches(".class")
                .replace(['/', '\\'], ".")
                .as_str(),
            &class.replace('/', "."),
            None,
        )
        .is_some();
    }
    let q = query.trim().replace('\\', "/").to_lowercase();
    let name = name.to_lowercase();
    if name.contains(&q) {
        return true;
    }
    let qualified = q.trim_end_matches(".java").trim_end_matches(".class");
    qualified.contains('.')
        && (name.ends_with(&format!("{}.java", qualified.replace('.', "/")))
            || name.ends_with(&format!("{}.class", qualified.replace('.', "/"))))
}
pub(crate) fn search(
    catalog: &Catalog,
    options: &SearchOptions,
    names: bool,
    cancel: &AtomicBool,
) -> Result<LibraryOutcome, String> {
    let started = Instant::now();
    let matcher = DocumentMatcher::new(options)?;
    let limit = options.max_results.clamp(1, 100);
    let mut out = LibraryOutcome {
        skipped: catalog.skipped,
        ..Default::default()
    };
    for cached in &catalog.sources {
        if cancel.load(Ordering::Relaxed) {
            out.cancelled = true;
            break;
        }
        if started.elapsed().as_millis() > crate::search::TIME_BUDGET_MS {
            out.truncated = true;
            break;
        }
        if !options.dirs.is_empty() && !options.dirs.iter().any(|m| m == &cached.source.module) {
            continue;
        }
        if !names && !cached.has_text {
            continue;
        }
        // 类/文件目录有界常驻；正文仍按来源读取，不给输入框制造逐包 IO。
        let data = if !names || cached.names.is_none() {
            let Some(data) = library_index::read_cached(cached, names)? else {
                out.stale = true;
                continue;
            };
            Some(data)
        } else {
            None
        };
        let entries = if names {
            cached
                .names
                .as_deref()
                .or_else(|| data.as_ref().map(|(t, _)| t.entries.as_slice()))
                .unwrap_or_default()
        } else {
            data.as_ref()
                .map(|(t, _)| t.entries.as_slice())
                .unwrap_or_default()
        };
        for entry in entries {
            if cancel.load(Ordering::Relaxed) {
                out.cancelled = true;
                break;
            }
            if started.elapsed().as_millis() > crate::search::TIME_BUDGET_MS {
                out.truncated = true;
                break;
            }
            if !matcher.accepts(&entry.name) || !names && entry.class {
                continue;
            }
            out.scanned += 1;
            let hits = if names {
                if !name_matches(&options.text, &entry.name) {
                    continue;
                }
                vec![crate::search::SearchHit {
                    path: entry.name.clone(),
                    line: 1,
                    column: 1,
                    text: String::new(),
                    ranges: vec![],
                }]
            } else {
                let data = data
                    .as_ref()
                    .ok_or("库文件正文缓存不可用")?
                    .1
                    .get(entry.off as usize..entry.off as usize + entry.len as usize)
                    .ok_or("库文件正文缓存失效，请重试")?;
                let text = std::str::from_utf8(data).map_err(|e| e.to_string())?;
                matcher.scan(&entry.name, text, limit + 1 - out.items.len())
            };
            for hit in hits {
                if out.items.len() == limit {
                    out.truncated = true;
                    return Ok(out);
                }
                out.items.push(LibraryHit {
                    source: cached.source.path.to_string_lossy().into_owned(),
                    entry: entry.name.clone(),
                    archive: cached.source.archive,
                    class: entry.class,
                    line: hit.line,
                    column: hit.column,
                    text: hit.text,
                    ranges: hit.ranges,
                });
            }
        }
        if out.cancelled || out.truncated {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn 类名支持完整包名_路径_扩展名与驼峰() {
        for query in [
            "nc.ui.Demo",
            "nc/ui/Demo.class",
            "nc\\ui\\Demo.CLASS",
            "Demo",
            "DEMO.CLASS",
        ] {
            assert!(name_matches(query, "nc/ui/Demo.class"));
        }
        assert!(!name_matches("nc.other.Demo", "nc/ui/Demo.class"));
    }
    #[test]
    #[ignore = "本机 NC hyext 样例，显式提供 NCFORGE_TEST_NC_HOME 后运行"]
    fn 本机_hyext_完整类名与散类反编译() {
        let home =
            std::path::PathBuf::from(std::env::var("NCFORGE_TEST_NC_HOME").expect("指定 NC home"));
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("work");
        std::fs::create_dir(&root).unwrap();
        let sources = library_index::discover(&home, &root)
            .into_iter()
            .filter(|s| {
                s.path
                    .to_string_lossy()
                    .replace('\\', "/")
                    .contains("/hyext/")
            })
            .collect();
        let started = Instant::now();
        let cat = library_index::build(sources, &temp.path().join("cache")).unwrap();
        println!(
            "hyext 来源 {} 个，建立耗时 {}ms，跳过 {}",
            cat.sources.len(),
            started.elapsed().as_millis(),
            cat.skipped
        );
        let cancel = AtomicBool::new(false);
        for archive in [true, false] {
            let cached = cat
                .sources
                .iter()
                .find(|s| {
                    s.source.archive == archive
                        && library_index::read_table(&s.meta)
                            .unwrap()
                            .entries
                            .iter()
                            .any(|e| e.class)
                })
                .expect("有真实 class");
            let table = library_index::read_table(&cached.meta).unwrap();
            let entry = table.entries.iter().find(|e| e.class).unwrap();
            let fqcn = entry.name.trim_end_matches(".class").replace('/', ".");
            let opts = SearchOptions {
                text: fqcn.clone(),
                max_results: 100,
                include: "*.class".into(),
                ..Default::default()
            };
            let started = Instant::now();
            let out = search(&cat, &opts, true, &cancel).unwrap();
            assert!(
                out.items
                    .iter()
                    .any(|h| h.source == cached.source.path.to_string_lossy()
                        && h.entry == entry.name)
            );
            println!(
                "完整类名 {fqcn}: {}ms，来源 {}",
                started.elapsed().as_millis(),
                cached.source.path.display()
            );
            let nc = crate::nc_home::resolve(Some(&home.to_string_lossy())).unwrap();
            let cfr = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources/cfr/cfr-0.152.jar");
            let source = if archive {
                crate::decompile::run_cfr(
                    std::path::Path::new(&nc.java),
                    &cfr,
                    &cached.source.path,
                    &entry.name,
                )
                .unwrap()
            } else {
                crate::decompile::run_cfr(
                    std::path::Path::new(&nc.java),
                    &cfr,
                    &cached.source.path.join(&entry.name),
                    "",
                )
                .unwrap()
            };
            // CFR 的 Java 表达使用内部类短名，不保留 JVM 名称里的 `$`。
            assert!(source.contains(fqcn.rsplit(['.', '$']).next().unwrap()));
        }
    }
    #[test]
    fn java全文_xml_properties_同名jar定位_筛选与取消() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        let root = t.path().join("work");
        std::fs::create_dir_all(&root).unwrap();
        for module in ["pp", "other"] {
            let dir = home.join(format!("modules/{module}/hyext/lib"));
            std::fs::create_dir_all(&dir).unwrap();
            let mut z = zip::ZipWriter::new(std::fs::File::create(dir.join("same.jar")).unwrap());
            for (name, text) in [
                (
                    "nc/ui/Demo.java",
                    "class Demo {\n String billType = \"😀单据\";\n}",
                ),
                ("conf/a.xml", "<label>单据</label>"),
                ("messages.properties", "label=单据"),
            ] {
                z.start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                z.write_all(text.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        let cat = library_index::build(
            library_index::discover(&home, &root),
            &t.path().join("cache"),
        )
        .unwrap();
        let mut opts = SearchOptions {
            text: "单据".into(),
            max_results: 100,
            ..Default::default()
        };
        let cancel = AtomicBool::new(false);
        let out = search(&cat, &opts, false, &cancel).unwrap();
        assert_eq!(out.items.len(), 6);
        let java = out
            .items
            .iter()
            .find(|h| h.entry.ends_with(".java"))
            .unwrap();
        assert_eq!(java.line, 2);
        assert_eq!(java.ranges[0].end - java.ranges[0].start, 2);
        opts.include = "*.xml,!messages.properties".into();
        opts.dirs = vec!["pp".into()];
        let out = search(&cat, &opts, false, &cancel).unwrap();
        assert_eq!(out.items.len(), 1);
        assert!(out.items[0].source.contains("pp"));
        opts.include.clear();
        opts.text = "nc.ui.Demo".into();
        assert_eq!(search(&cat, &opts, true, &cancel).unwrap().items.len(), 1);
        opts.text = "billtype".into();
        opts.case_sensitive = true;
        assert!(search(&cat, &opts, false, &cancel)
            .unwrap()
            .items
            .is_empty());
        opts.case_sensitive = false;
        opts.whole_word = true;
        assert_eq!(search(&cat, &opts, false, &cancel).unwrap().items.len(), 1);
        opts.text = "bill".into();
        assert!(search(&cat, &opts, false, &cancel)
            .unwrap()
            .items
            .is_empty());
        opts.text = "bill(Type)".into();
        opts.regex = true;
        assert_eq!(search(&cat, &opts, false, &cancel).unwrap().items.len(), 1);
        cancel.store(true, Ordering::Relaxed);
        assert!(search(&cat, &opts, false, &cancel).unwrap().cancelled);
    }
}
