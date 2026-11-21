//! 真实索引的端到端校验：Java 写出的 `types.idx` 能不能被 Rust 读回、查得准。
//!
//! 为什么不放进 `cargo test --lib`：它需要一个**真实生成的**索引文件（含 jar 侧约 124 MB），
//! 生成过程要 20 余秒 + 真实 NC 工作区。单测里那 5 条用手写字节钉格式，这里钉「两边对得上」。
//!
//! ```bash
//! # 1) 先用产品索引器生成（NC_HOME 指向 1909home）
//! #    java -cp resources/ecj-bridge/ncecj.jar;resources/jdtls/plugins/* NcIndexer \
//! #         --ws <工作区> --out target/idx/work.idx
//! # 2) 再跑本测试
//! cargo test --test decl_index_live -- --ignored --nocapture
//! # 换文件：
//! NCFORGE_DECL_IDX=D:\x\work.idx cargo test --test decl_index_live -- --ignored
//! ```

use std::path::{Path, PathBuf};
use std::time::Instant;

use nc_forge::decl_index::DeclIndex;

#[path = "../src/test_support.rs"]
mod test_support;

fn idx_path() -> PathBuf {
    std::env::var("NCFORGE_DECL_IDX")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/idx/work.idx")
        })
}

#[test]
#[ignore = "需要先跑 NcIndexer 生成 types.idx（真实工作区，~25s）"]
fn 真实索引能被读回且查询正确() {
    let p = idx_path();
    assert!(
        p.is_file(),
        "找不到索引 {}。先用 NcIndexer 生成（见本文件头注释）",
        p.display()
    );

    let t0 = Instant::now();
    let (idx, st) = DeclIndex::load(&p).expect("应能解析真实索引");
    let ms = t0.elapsed().as_millis();

    println!(
        "读回 {}：类型 {} / 路径 {} / 源文件 {} / 源字节 {} / jar 类型 {}，耗时 {}ms",
        p.display(),
        st.types,
        st.paths,
        st.source_files,
        st.source_bytes,
        st.jar_types,
        ms
    );

    // 规模下限：2026-11-21 实测 204380 类型 / 7419 源文件 / 196590 jar class。
    // 只防「解析半个文件」这种结构性错误，所以给范围而不是等值（换工作区也能跑）。
    assert!(st.types > 150_000, "类型数 {} 明显偏少", st.types);
    assert!(st.source_files > 7_000, "源文件只有 {} 个", st.source_files);
    assert!(st.paths > 1_000, "路径表只有 {} 条", st.paths);
    assert!(ms < 5_000, "读回耗时 {ms}ms，远超预期的 200ms 级");

    // 每条声明都该有可用的位置信息
    for d in idx.all().iter().take(2_000) {
        assert!(!d.name.is_empty(), "类型名不能为空");
        assert!(!d.path.is_empty(), "{} 没有路径", d.name);
        if d.from_jar {
            assert_eq!(d.line, 0, "jar 里的 {} 不该有行号", d.name);
        } else {
            assert!(d.line > 0, "源码里的 {} 行号 {} 不合法", d.name, d.line);
        }
    }

    // 二分命中：拿一个真实存在的类验。
    // 🔴 不要求它带成员签名：生产索引用 `--no-members` 建（跳转不需要成员，
    //    270 万条签名占体积 80%）。成员解析本身由 `decl_index.rs` 的单测用
    //    手写字节覆盖，这里只验「读得回、查得准、位置合法」。
    let hit = idx
        .find("nc.bs.framework.core.Plugin")
        .or_else(|| idx.all().iter().find(|d| !d.from_jar))
        .or_else(|| idx.all().first())
        .expect("索引不该是空的");
    println!(
        "命中 {} → {}:{}（{} 方法 / {} 字段）",
        hit.name,
        hit.path,
        hit.line,
        hit.methods.len(),
        hit.fields.len()
    );
    assert!(hit.path.ends_with(".java") || hit.path.ends_with(".jar"));
}

/// 端到端：真实索引 + 真实源文件 → 真的能解析出跳转目标。
///
/// 走 `fast_decl::definition` 而不是自己拼逻辑 —— 它包含「行列换算 → 取词 → 四级消歧
/// → LSP Location」整条链，是命令层实际调用的那个函数。
#[test]
#[ignore = "依赖真实工作区与已生成的 types.idx"]
fn 真实索引能答一次跳转() {
    use nc_forge::decl_index::DeclIndex;
    use nc_forge::fast_decl::Loaded;

    let root = std::env::var("NCFORGE_TEST_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"C:\work\aier\newar"));
    assert!(root.is_dir(), "工作区不存在：{}", root.display());

    let (index, stats) = DeclIndex::load(&idx_path()).expect("应能解析真实索引");
    let loaded = Loaded {
        index,
        stats,
        root: root.clone(),
        source: idx_path(),
    };

    // 找一个「import 了**源码类**」的文件，把光标放在 import 的类名上。
    // 🔴 必须限定目标在源码索引里：第一版刻意不索引 jar 侧（省 10s），
    //    import 指向 jar 类时本地解析必然空，那是设计内的行为，不是 bug。
    let mut tested = 0;
    let mut found: Option<(PathBuf, u32, u32, String)> = None;
    for hit in loaded.index.all().iter().filter(|d| !d.from_jar).take(400) {
        let p = PathBuf::from(&hit.path);
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        for (n, line) in text.lines().enumerate() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("import ") {
                let name = rest.trim_end_matches(';').trim();
                if name.ends_with(".*") || name.starts_with("java.") || name.starts_with("javax.") {
                    continue;
                }
                if let Some(simple) = name.rsplit('.').next() {
                    // 只挑源码侧的目标：jar 目标由下一条测试（跳 jar 里的类）覆盖
                    match loaded.index.find(name) {
                        Some(d) if !d.from_jar => {}
                        _ => continue,
                    }
                    if let Some(col) = line.find(simple) {
                        found = Some((p.clone(), n as u32 + 1, col as u32, name.to_string()));
                        break;
                    }
                }
            }
        }
        if found.is_some() {
            break;
        }
    }

    let (file, line, col, expect_fqcn) = found.expect("工作区里应至少有一个 import 语句");
    let locs = nc_forge::fast_decl::definition(&loaded, &file, line, col, &root);
    println!(
        "跳转 {}:{}:{} → {} 个目标；首个 = {}",
        file.display(),
        line,
        col,
        locs.len(),
        locs.first().map(|v| v.to_string()).unwrap_or_default()
    );
    assert_eq!(locs.len(), 1, "显式 import 应只有一个权威目标");
    let first = &locs[0];
    assert_eq!(
        first["name"],
        expect_fqcn.as_str(),
        "目标类名应与 import 一致"
    );
    assert!(
        first["uri"].as_str().unwrap_or("").ends_with(".java"),
        "应落到源码而不是 jdt://"
    );
    tested += 1;
    assert_eq!(tested, 1);
    assert_eq!(
        first["range"]["start"]["line"].as_u64(),
        Some(
            loaded
                .index
                .find(&expect_fqcn)
                .map(|d| d.line.max(0) as u64)
                .unwrap_or(9999)
                - 1
        ),
        "行号应是声明行减一（LSP 0 基）"
    );
}

/// 成员级跳转：`接收者.成员()` → 声明行。真实数据上跑通链路。
///
/// 不断言「必须跳到索引里记的那一行」—— 接收者类型是启发式推的，同名成员在不同类里
/// 很常见，硬断言会把测试变成脆弱的口号。这里钉两件确定的事：
/// ① 至少有一条能跳；② 跳到的行**确实写着那个成员名**（跳到错地方立刻能看出来）。
#[test]
#[ignore = "依赖真实工作区与已生成的 types.idx"]
fn 真实索引能跳到源码里的成员() {
    use nc_forge::decl_index::sig_name;
    use nc_forge::fast_decl::Loaded;

    let root = std::env::var("NCFORGE_TEST_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"C:\work\aier\newar"));
    assert!(root.is_dir(), "工作区不存在：{}", root.display());

    // 必须用 `load_meta`（生产路径）：它会跳过 jar 侧成员，但**保留源码侧**。
    let (index, stats) = DeclIndex::load_meta(&idx_path()).expect("应能解析真实索引");
    let loaded = Loaded {
        index,
        stats,
        root: root.clone(),
        source: idx_path(),
    };

    let mut tried = 0usize;
    let mut hit: Option<(PathBuf, String, u64, String)> = None;
    for d in loaded.index.all().iter().filter(|d| !d.from_jar) {
        if d.methods.is_empty() || hit.is_some() {
            continue;
        }
        let p = PathBuf::from(&d.path);
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        for m in &d.methods {
            let name = sig_name(&m.name);
            // 太短的方法名（`get`/`run`）假阳性太高，跳过
            if name.len() < 5 {
                continue;
            }
            // 找 `.name(` 的调用点：接收者类型要能推出来，这条链路才有意义
            let Some(pos) = text.find(&format!(".{name}(")) else {
                continue;
            };
            let line = text[..pos].bytes().filter(|b| *b == b'\n').count() as u32 + 1;
            let line_start = text[..pos].rfind('\n').map_or(0, |i| i + 1);
            // 光标落在方法名首字符上（`.name(` 里 `.` 之后）
            let col = (pos + 1 - line_start) as u32;
            tried += 1;
            let locs = nc_forge::fast_decl::definition(&loaded, &p, line, col, &root);
            let Some(first) = locs.first() else {
                continue;
            };
            let uri = first["uri"].as_str().unwrap_or("");
            if !uri.ends_with(".java") {
                continue; // jar 目标不参与成员级跳转
            }
            let got_line = first["range"]["start"]["line"].as_u64().unwrap_or(0);
            let target = PathBuf::from(
                uri.trim_start_matches("file:///")
                    .replace("%20", " ")
                    .replace('/', "\\"),
            );
            let Ok(ttext) = std::fs::read_to_string(&target) else {
                continue;
            };
            let tlines: Vec<&str> = ttext.split('\n').collect();
            let Some(text_at) = tlines.get(got_line as usize) else {
                continue;
            };
            if text_at.contains(name) {
                hit = Some((
                    p.clone(),
                    name.to_string(),
                    got_line + 1,
                    target.display().to_string(),
                ));
                break;
            }
        }
        if hit.is_some() {
            break;
        }
        if tried > 400 {
            break;
        }
    }

    let (from, name, line, to) = hit.expect("真实工作区里应至少有一条成员调用能跳到声明行");
    println!("成员跳转 {} → {name} @ {to}:{line}", from.display());
    assert!(line > 0, "LSP 行号是 0 基，转成 1 基后必须为正");
}

/// 轻量加载（跳转实际用的那条）与全量加载：耗时与结果都要对得上。
///
/// 只比耗时不够 —— `load_meta` 跳过的是变长字段，一旦跳错一个字节，后面全部记录错位。
/// 所以这里同时比对每条声明（名字/类型/来源/行/路径）。
#[test]
#[ignore = "需要已生成的 types.idx（含 jar 侧）"]
fn 轻量加载与全量加载结果一致且更快() {
    let p = idx_path();
    let t0 = Instant::now();
    let (full, st_full) = DeclIndex::load(&p).expect("全量应解析成功");
    let t_full = t0.elapsed();

    let t1 = Instant::now();
    let (meta, st_meta) = DeclIndex::load_meta(&p).expect("轻量应解析成功");
    let t_meta = t1.elapsed();

    assert_eq!(st_full, st_meta, "规模统计必须一致");
    assert_eq!(full.len(), meta.len(), "声明条数必须一致");
    let mut jar_members = 0usize;
    for (a, b) in full.all().iter().zip(meta.all()) {
        assert_eq!(a.name, b.name);
        assert_eq!((a.kind, a.from_jar, a.line), (b.kind, b.from_jar, b.line));
        assert_eq!(a.path, b.path);
        if a.from_jar {
            // jar 侧成员行号恒 0、跳转用不上 ⇒ 轻量加载整块跳过
            jar_members += a.methods.len() + a.fields.len();
            assert!(
                b.methods.is_empty() && b.fields.is_empty(),
                "jar 侧成员应被跳过：{}",
                a.name
            );
        } else {
            // 源码侧成员是成员级跳转的**唯一**数据源，一条都不能少
            assert_eq!(a.methods, b.methods, "源码侧方法必须保留：{}", a.name);
            assert_eq!(a.fields, b.fields, "源码侧字段必须保留：{}", a.name);
        }
    }
    println!(
        "全量 {:?} / 轻量 {:?}（{} 类型，其中 jar {}，jar 成员 {}）",
        t_full, t_meta, st_meta.types, st_meta.jar_types, jar_members
    );
    // 跳过 jar 侧成员时才该更快；生产索引用 `--no-jar-members` 建，此时两者等价。
    if jar_members > 0 {
        assert!(
            t_meta < t_full,
            "轻量 {:?} 不该慢于全量 {:?}",
            t_meta,
            t_full
        );
    } else {
        println!("这份索引没有 jar 侧成员（--no-jar-members），轻量与全量等价属预期");
    }
}

/// 端到端：**跳到 jar 里的类**。
///
/// 与下一条的差别是目标类型：那条落在源码，这条落在 jar。走的是同一条
/// `fast_decl::definition`，但 jar 目标必须产出 `jdt://` 而不是 `file://`，
/// 否则前端会拿 jar 路径去读文本（二进制，必然失败）。
///
/// 同时验证 URI 能被既有反编译链路（`parse_jdt_uri` + `pick_jar`）接住 ——
/// 这是「跳过去能看见源码」的唯一保证。
#[test]
#[ignore = "依赖真实工作区与含 jar 侧的 types.idx"]
fn 真实索引能跳到_jar_里的类() {
    use nc_forge::decl_index::DeclIndex;
    use nc_forge::fast_decl::Loaded;

    let root = std::env::var("NCFORGE_TEST_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"C:\work\aier\newar"));
    assert!(root.is_dir(), "工作区不存在：{}", root.display());

    let (index, stats) = DeclIndex::load_meta(&idx_path()).expect("应能解析真实索引");
    assert!(stats.jar_types > 0, "这份索引没有 jar 侧，跑不了本条");
    let loaded = Loaded {
        index,
        stats,
        root: root.clone(),
        source: idx_path(),
    };

    // 找一个「import 指向 jar 里的类」的位置
    let mut found: Option<(PathBuf, u32, u32, String)> = None;
    'outer: for hit in loaded.index.all().iter().filter(|d| !d.from_jar).take(600) {
        let p = PathBuf::from(&hit.path);
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        for (n, line) in text.lines().enumerate() {
            let t = line.trim();
            let Some(rest) = t.strip_prefix("import ") else {
                continue;
            };
            let name = rest.trim_end_matches(';').trim();
            if name.ends_with(".*") || name.starts_with("java.") || name.starts_with("javax.") {
                continue;
            }
            let Some(simple) = name.rsplit('.').next() else {
                continue;
            };
            // 只要 jar 侧的目标：源码侧由上一条覆盖
            match loaded.index.find(name) {
                Some(d) if d.from_jar => {}
                _ => continue,
            }
            if let Some(col) = line.find(simple) {
                found = Some((p.clone(), n as u32 + 1, col as u32, name.to_string()));
                break 'outer;
            }
        }
    }

    let (file, line, col, expect_fqcn) =
        found.expect("工作区里应至少有一个 import 指向 jar 里的类");
    let locs = nc_forge::fast_decl::definition(&loaded, &file, line, col, &root);
    println!(
        "跳 jar {}:{}:{} → {} → {}",
        file.display(),
        line,
        col,
        expect_fqcn,
        locs.first().map(|v| v.to_string()).unwrap_or_default()
    );
    assert_eq!(locs.len(), 1, "显式 import 应只有一个权威目标");
    let first = &locs[0];
    assert_eq!(first["name"], expect_fqcn.as_str());
    assert_eq!(first["fromJar"], true);
    let uri = first["uri"].as_str().unwrap_or("");
    assert!(
        uri.starts_with("jdt://contents/"),
        "jar 目标必须是 jdt:// 而不是 {uri}"
    );
    // 既有反编译链路必须认得它，否则点开只会报错
    let class = nc_forge::decompile::parse_jdt_uri(uri).expect("反编译链路应能解析这个 URI");
    assert_eq!(class.fqcn, expect_fqcn);
    // jar 必须真实存在（索引里记的路径就是它）
    let decl = loaded.index.find(&expect_fqcn).expect("应能再查到");
    assert!(
        PathBuf::from(&decl.path).is_file(),
        "索引记的 jar 不存在：{}",
        decl.path
    );
    assert_eq!(
        class.jar_name,
        PathBuf::from(&decl.path)
            .file_name()
            .unwrap()
            .to_string_lossy()
    );
}

/// 打印生产口径的 jar 清单（`nc_index::classpath_jars`），供手工跑索引器用。
///
/// 这条不是断言，是**工具**：`fast_decl::build` 在运行时算同一份清单，
/// 想用命令行复现它的索引就必须先拿到同样的输入，否则「命令行 19s」和
/// 「产品里 60s」会比不出来。
#[test]
#[ignore = "读取真实 NC home，产出 jar 清单到 target/"]
fn 导出生产_jar_清单() {
    use nc_forge::nc_index::classpath_jars;
    let home = nc_forge::nc_home::resolve(Some(r"D:\ncc\1909home")).expect("NC home 无效");
    let t0 = Instant::now();
    let mut seen = std::collections::HashSet::new();
    let jars: Vec<PathBuf> = classpath_jars(std::path::Path::new(&home.root))
        .into_iter()
        .filter(|p| seen.insert(p.to_string_lossy().to_lowercase()))
        .collect();
    let text = jars
        .iter()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>()
        .join("\n");
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/idx/prod-jars.list");
    std::fs::create_dir_all(out.parent().unwrap()).unwrap();
    std::fs::write(&out, &text).expect("写清单失败");
    println!(
        "jar 清单 {} 条，扫描耗时 {:?}，写到 {}",
        jars.len(),
        t0.elapsed(),
        out.display()
    );
    assert!(
        jars.len() > 500,
        "1909home 的 classpath jar 不该只有 {} 个",
        jars.len()
    );
}

/// **生产口径全流程**：`fast_decl::build_index` 真的能建出一份可用索引。
///
/// 这条覆盖前面几条都碰不到的一段：jar 清单从 `classpath_jars` 算（4367 条）→
/// 传给索引器由它按源码引用包精选 → 写 `types.idx` → 写 `jars.done` 指纹。
/// 最容易错的三个点（包名斜杠格式、Xmx、指纹顺序）都在这一段里。
///
/// 同时验证**复用判据**：第二次调用必须**不重建**（耗时趋近 0，文件 mtime 不变）。
#[test]
#[ignore = "真实全流程：约 20 秒 + 8 线程 + 3GB 临时堆"]
fn 生产口径能建出可用的索引() {
    use nc_forge::fast_decl::build_index;

    let home = nc_forge::nc_home::resolve(Some(r"D:\ncc\1909home")).expect("NC home 无效");
    let res = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    let bridge = res.join("ecj-bridge").join("ncecj.jar");
    let plugins = res.join("jdtls").join("plugins");
    assert!(
        bridge.is_file(),
        "缺索引器：先跑 node scripts/build-bridge-jar.mjs ecj"
    );
    let root = PathBuf::from(
        std::env::var("NCFORGE_TEST_WORKSPACE").unwrap_or_else(|_| r"C:\work\aier\newar".into()),
    );
    assert!(root.is_dir(), "工作区不存在：{}", root.display());

    // 🔴 专属文件名：这条会**先删再建**，与其它读 `prod.idx` 的用例并行跑会互相踩。
    //    （cargo test 默认并行；已踩过一次 —— 表现为「轻量与全量结果不一致」）
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/idx/prod-flow.idx");
    std::fs::create_dir_all(out.parent().unwrap()).unwrap();
    let _ = std::fs::remove_file(&out);

    let t0 = Instant::now();
    build_index(
        std::path::Path::new(&home.java),
        std::path::Path::new(&home.root),
        &bridge,
        &plugins,
        &root,
        &out,
    )
    .expect("生产口径建索引失败");
    let first = t0.elapsed();
    assert!(out.is_file(), "没产出 {}", out.display());

    // 指纹 + 清单必须落到同一个目录
    let manifest = out.with_file_name("jars.done");
    let list = out.with_file_name("jars.list");
    assert!(manifest.is_file(), "缺指纹 jars.done");
    assert!(list.is_file(), "缺 jar 清单 jars.list");
    let text = std::fs::read_to_string(&manifest).unwrap();
    assert!(
        text.lines().count() > 500,
        "清单只有 {} 条",
        text.lines().count()
    );

    let (idx, st) = nc_forge::decl_index::DeclIndex::load_meta(&out).expect("应能读回");
    assert!(st.jar_types > 100_000, "jar 侧类型只有 {}", st.jar_types);
    assert_eq!(
        st.source_files, 7419,
        "源文件数应与 collect_sources 口径一致"
    );
    assert!(
        idx.find("nc.vo.arap.pay.AggPayBillVO").is_some(),
        "常用 jar 类应被索引到"
    );

    // 二次调用必须走复用：不重建、不改文件。
    //
    // 判据用**文件 mtime** 而不是耗时：并行跑集成测试时磁盘争用能让「复用」慢到 15s
    // （单独跑 6s），而重建一次要 30s+。耗时阈值分不清这两种情况，mtime 能 ——
    // 复用路径一次都不碰 `types.idx`，重建则必然 `rename` 覆盖它。
    let size = std::fs::metadata(&out).unwrap().len();
    let mtime_before = std::fs::metadata(&out).unwrap().modified().unwrap();
    let t1 = Instant::now();
    build_index(
        std::path::Path::new(&home.java),
        std::path::Path::new(&home.root),
        &bridge,
        &plugins,
        &root,
        &out,
    )
    .expect("第二次应直接复用");
    let second = t1.elapsed();
    let after = std::fs::metadata(&out).unwrap();
    assert_eq!(after.len(), size, "复用不该重写索引");
    assert_eq!(
        after.modified().unwrap(),
        mtime_before,
        "复用不该动 types.idx 的 mtime（动了就是重建过）"
    );
    assert!(
        second.as_secs() < 30,
        "第二次用了 {:?}，说明没有命中复用判据（清单比对 / 过期判据失败？）",
        second
    );
    println!(
        "首次 {:?} → {} KB / {} 类型（jar {}）；复用 {:?}",
        first,
        size / 1024,
        st.types,
        st.jar_types,
        second
    );

    // 过期判据的**等价性**：Rust 侧走盘必须与索引器数出同一个源文件数。
    // 不等就是「每次启动都判过期、白重建 21s」——不报错，只是慢，最难发现的那种退化。
    let t2 = Instant::now();
    let scan = nc_forge::fast_decl::scan_sources(&root, st.built_at_ms);
    println!(
        "走盘 {} 个源文件，耗时 {:?}，判过期={}",
        scan.files,
        t2.elapsed(),
        scan.stale
    );
    assert_eq!(
        scan.files, st.source_files,
        "Rust 走盘与 Java 索引器的源文件数必须一致（SRC_DIRS / NOT_MODULE 同源）"
    );
    assert!(!scan.stale, "刚建好的索引不该判过期");
}

/// **过期判据端到端**：源码变了必须重建，没变必须复用。
///
/// 刻意不碰真实 NC home：给它一个**空的**「NC home」目录，jar 清单就是 0 条，
/// 索引只走源码侧，几百毫秒建完 —— 判据本身与 jar 无关，用真 NC home 只是白等 21s。
///
/// 三条覆盖的是「索引跨重启持久」带来的真实风险：改了行号还跳旧行（比跳不到更坏）。
#[test]
#[ignore = "起一次 JVM（~2s），需要先跑 build-bridge-jar.mjs ecj"]
fn 源码变更后索引重建_未变更则复用() {
    use nc_forge::fast_decl::build_index;

    let home = nc_forge::nc_home::resolve(Some(r"D:\ncc\1909home")).expect("NC home 无效");
    let res = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    let bridge = res.join("ecj-bridge").join("ncecj.jar");
    let plugins = res.join("jdtls").join("plugins");
    assert!(
        bridge.is_file(),
        "缺索引器：先跑 node scripts/build-bridge-jar.mjs ecj"
    );

    // 🔴 `test_support::tmp` 会 `canonicalize`，Windows 上给的是 `\\?\C:\...` 的 verbatim 形式，
    //    Java 的 `Paths.get` 直接判非法路径（`?` 不合法）。生产路径拿的是 `display_path`（已去前缀），
    //    所以这只是测试侧要处理的事。
    let dir = nc_forge::nc_home::strip_verbatim(&test_support::tmp("decl-live-stale"));
    let ws = dir.join("ws");
    let pkg = ws.join("mod").join("src").join("private").join("demo");
    std::fs::create_dir_all(&pkg).unwrap();
    let a = pkg.join("A.java");
    std::fs::write(&a, "package demo;\npublic class A {\n  void m() {}\n}\n").unwrap();
    // 空 NC home：classpath_jars 扫不到任何 jar，索引只剩源码侧
    let empty_home = dir.join("nchome");
    std::fs::create_dir_all(&empty_home).unwrap();
    let out = dir.join("idx").join("types.idx");

    let build = || {
        build_index(
            Path::new(&home.java),
            &empty_home,
            &bridge,
            &plugins,
            &ws,
            &out,
        )
        .expect("建索引失败")
    };

    let t0 = Instant::now();
    build();
    let first = t0.elapsed();
    let st1 = DeclIndex::read_stats(&out).expect("应能读头部");
    assert!(st1.built_at_ms > 0, "必须写入落盘时刻");
    assert!(st1.source_files >= 1);

    // ① 没改动 → 复用（不重建、不改 builtAt）
    let t1 = Instant::now();
    build();
    let second = t1.elapsed();
    let st2 = DeclIndex::read_stats(&out).expect("应能读头部");
    assert_eq!(st2.built_at_ms, st1.built_at_ms, "没改动不该重建");
    assert!(
        second < first.max(std::time::Duration::from_secs(5)),
        "复用 {:?} 不该慢于首次 {:?}",
        second,
        first
    );

    // ② 改一个文件（行号漂移）→ 必须重建
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(
        &a,
        "package demo;\n\n// 头注释变长，A 的声明行随之往下漂\npublic class A {\n  void m() {}\n}\n",
    )
    .unwrap();
    build();
    let st3 = DeclIndex::read_stats(&out).expect("应能读头部");
    assert!(
        st3.built_at_ms > st1.built_at_ms,
        "改了源文件必须重建（否则会跳到旧行号）"
    );

    // ③ 新增文件 → 也要重建（新类的 mtime 比索引新）
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(pkg.join("B.java"), "package demo;\nclass B {}\n").unwrap();
    build();
    let (idx, st4) = DeclIndex::load_meta(&out).expect("应能读回");
    assert!(st4.built_at_ms > st3.built_at_ms, "新增文件必须重建");
    assert!(idx.find("demo.B").is_some(), "重建后新类应能查到");

    // ④ 删除文件 → 只能靠父目录 mtime 发现
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::remove_file(&a).unwrap();
    build();
    let (idx, st5) = DeclIndex::load_meta(&out).expect("应能读回");
    assert!(st5.built_at_ms > st4.built_at_ms, "删文件必须重建");
    assert!(idx.find("demo.A").is_none(), "重建后删掉的类不该还在索引里");
    assert!(idx.find("demo.B").is_some());

    println!("首次 {:?} / 复用 {:?}；重建三次都命中", first, second);
}
