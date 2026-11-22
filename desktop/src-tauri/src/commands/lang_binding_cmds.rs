//! 常驻 binding resolver 的命令层（窗口期精确跳转的第二链路）。
//!
//! 分工与 `lang_fast_cmds` 一致：从配置里取工作区根 / NC home、装配 resolver 环境、
//! 把 `Hit`（身份）映射成 `Location[]`（位置）。位置不由 Java 侧给——它拿不到
//! `decl_index`，这边查（设计 §2 契约）。
//!
//! **永远不返回错误**：环境不齐 / 退避中 / 超时 / 进程挂 / offset 处没有绑定 /
//! 索引没建好，一律回空数组，前端据此退回内容搜索。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::app_error::AppError;
use crate::bind_resolver::{self, Hit, ResolverEnv};
use crate::decl_index::DeclIndex;
use crate::state::AppState;

/// 在常驻 resolver 里解析 `textDocument/definition`（ECJ 全量绑定）。
///
/// 返回 `Location[]`，与 `lang_fast_definition` 同形状（额外带 `name`/`fromJar`）。
/// `line` 是 **1 基**、`character` 是 **0 基**（LSP 口径）。
///
/// 与 `lang_fast_definition` 的分工：那边答「索引里有的」（源码 + jar 成员），
/// 这边答「绑定推得出来的」（继承成员、精确接收者、二进制类型的方法）。
#[tauri::command]
pub async fn lang_binding_resolve(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    line: u32,
    character: u32,
) -> Result<Value, AppError> {
    let empty = || Ok(json!([]));
    let (root, nc_home, config_dir, enabled) = {
        let cfg = state.config.read().await;
        (
            cfg.workspace_root.clone(),
            cfg.nc_home.clone(),
            state.config_dir.clone(),
            cfg.lang_binding_resolver,
        )
    };
    // 开关是硬闸门：关掉时命令直接回空，前端继续走内容搜索——与开开关之前逐字节一致
    if !enabled {
        return empty();
    }
    let Some(root) = root else {
        return empty();
    };
    let root = PathBuf::from(root);
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return empty();
    }
    // 索引没建好：顺手起一次后台构建（与 lang_fast_definition 同一条路径），当次回空。
    // Hit 只有身份，没有索引就变不出位置。
    let Some(loaded) =
        crate::fast_decl::lookup_or_kick(&app, state.inner(), &root, nc_home.clone())
    else {
        return empty();
    };
    let Some(env) = resolver_env(&app, &config_dir, &root, nc_home.as_deref()) else {
        return empty();
    };
    let Ok(bytes) = std::fs::read(&file) else {
        return empty();
    };
    // offset 口径 = Java 侧 char[] 下标：解码规则、行尾、BOM 全都要对齐，见 utf16_offset
    let Some(offset) = utf16_offset(&bytes, line, character) else {
        return empty();
    };
    // resolver 单线程且一次调用最长 5s：放 spawn_blocking，别占着 tokio  worker
    let moved_env = env;
    let moved_file = file.clone();
    let hit = tauri::async_runtime::spawn_blocking(move || {
        bind_resolver::resolve(&moved_env, &moved_file, offset)
    })
    .await
    .ok()
    .flatten();
    let Some(hit) = hit else {
        return empty();
    };
    let locs = to_locations(&hit, &loaded.index, &file, line);
    Ok(json!(locs))
}

/// resolver 的状态（设置页显示）。进程级、与工作区无关，不报错。
#[tauri::command]
pub async fn lang_binding_status() -> Result<Value, AppError> {
    // status() 要拿 holder 锁，而 resolve/init 持锁最长约 35s（init 30s + call 5s）——
    // 和 resolve 一个道理放 spawn_blocking，别占着 tokio worker（那边注释有完整解释）。
    // 后台任务异常退出 / 序列化失败一律按「没有状态」处理：本命令契约就是永不返回错误。
    let status = tauri::async_runtime::spawn_blocking(bind_resolver::status)
        .await
        .ok()
        .and_then(|s| serde_json::to_value(s).ok());
    Ok(status.unwrap_or(Value::Null))
}

/// 文件已保存：作废 resolver 里的 CU 缓存（保存路径调用，fire-and-forget）。
///
/// 与 `notifyLangSaved`（jdt.ls 的 didSave）并排：影子工程的源根是 junction，
/// 两边都看不见磁盘变化，都得显式通知。没有在跑的 worker 时后端直接返回——
/// 为了「作废」去拉起一个 768MB 的进程纯属浪费（`bind_resolver::invalidate` 同款判断）。
#[tauri::command]
pub async fn lang_binding_invalidate(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> Result<(), AppError> {
    if paths.is_empty() {
        return Ok(());
    }
    let (root, nc_home, config_dir, enabled) = {
        let cfg = state.config.read().await;
        (
            cfg.workspace_root.clone(),
            cfg.nc_home.clone(),
            state.config_dir.clone(),
            cfg.lang_binding_resolver,
        )
    };
    if !enabled {
        return Ok(());
    }
    let Some(root) = root else {
        return Ok(());
    };
    let Some(env) = resolver_env(&app, &config_dir, &PathBuf::from(root), nc_home.as_deref())
    else {
        return Ok(());
    };
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    tauri::async_runtime::spawn_blocking(move || bind_resolver::invalidate(&env, &files))
        .await
        .map_err(|e| AppError::internal("task.join", format!("后台任务失败: {e}")))?;
    Ok(())
}

/// 找 binding resolver 的桥 jar：第一个存在的候选，都不在就回第一个候选
/// （让 `ensure_worker` 报出那条统一的「缺桥 jar」错误，路径也是可读的）。
///
/// 不能只用 `jdtls.parent()` 推导：开发布局里 jdtls 在 `src-tauri/resources/jdtls`、
/// 桥在兄弟目录 `ecj-bridge/`，这个关系凑巧成立；**生产环境 jdtls 来自下载的资源包**
/// （`<config_dir>/resources/jdtls@<版本>`），而桥由 `bundle.resources` 装到
/// `resource_dir()/ecj-bridge/`——两者 parent 毫无关系。用 jdtls 推导会得到一个
/// 从来没人写过的路径，于是精确解析整体静默失效（回空 → 前端退回内容搜索），
/// 状态行还停在「待命」——正是这个特性想消灭的「失败没有可见症状」。
fn bridge_jar(app: &tauri::AppHandle, jdtls: &Path) -> PathBuf {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("NCFORGE_ECJ_BRIDGE_JAR") {
        cands.push(PathBuf::from(p));
    }
    // 生产：bundle.resources 的落点，与 jdtls 在哪无关
    if let Ok(dir) = app.path().resource_dir() {
        cands.push(dir.join("ecj-bridge").join("ncecj.jar"));
    }
    // 开发：jdtls 在 src-tauri/resources/jdtls，桥在兄弟目录
    if let Some(parent) = jdtls.parent() {
        cands.push(parent.join("ecj-bridge").join("ncecj.jar"));
    }
    // 兜底：源码树内的资源目录（未打包运行 / 测试）
    cands.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ecj-bridge")
            .join("ncecj.jar"),
    );
    if let Some(found) = cands.iter().find(|p| p.is_file()) {
        return found.clone();
    }
    cands.into_iter().next().unwrap_or_default()
}

/// 装配 resolver 环境：NC home 的 java + 桥 jar + jdtls plugins 全集。
///
/// `find_jdtls` 的候选顺序（资源包 → 安装目录 → 开发目录）与索引构建用的同一份，
/// 两边必须拿到同一个 jdtls——ECJ 版本不一致会让「索引说在 3 行、resolver 说在 5 行」。
fn resolver_env(
    app: &tauri::AppHandle,
    config_dir: &Path,
    root: &Path,
    nc_home: Option<&str>,
) -> Option<ResolverEnv> {
    let home = crate::nc_home::resolve(nc_home).ok()?;
    let jdtls = crate::commands::find_jdtls(app, config_dir).ok()?;
    let plugins = jdtls.join("plugins");
    let bridge = bridge_jar(app, &jdtls);
    let mut jars: Vec<PathBuf> = std::fs::read_dir(&plugins)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jar"))
        .collect();
    jars.sort(); // 顺序进 classpath：JVM 找类的顺序稳定，排查才能复现
    Some(ResolverEnv {
        java: PathBuf::from(&home.java),
        bridge,
        plugins: jars,
        config_dir: config_dir.to_path_buf(),
        workspace_root: root.to_path_buf(),
        nc_root: PathBuf::from(&home.root),
    })
}

/// `Hit` → `Location[]`。四种 kind 各走一条路：
///
/// - `local`：声明就在本文件里，索引不收录局部 ⇒ 用 `fast_member::local_decl_line`
///   （与 Phase 1 局部跳转同一判据）。
/// - `type` / `method` / `field`：查 `decl_index.find(fqcn)`，成员行取
///   `method_line` / `field_line`，源码侧再用磁盘校正（索引可能是旧的）。
///
/// 查不到一律回空（前端退内容搜索）：跳到类型的声明行冒充成员行，比不跳更糟。
fn to_locations(hit: &Hit, index: &DeclIndex, file: &Path, cursor_line: u32) -> Vec<Value> {
    match hit.kind.as_str() {
        "local" => {
            let Ok(bytes) = std::fs::read(file) else {
                return Vec::new();
            };
            // lossy 就够：要找的标识符是 ASCII，GBK 字节被替换不影响行结构与判据
            let text = String::from_utf8_lossy(&bytes);
            let Some(decl_line) =
                crate::fast_member::local_decl_line(&text, &hit.name, cursor_line)
            else {
                return Vec::new();
            };
            let uri = crate::lsp::path_to_uri(&file.to_string_lossy());
            vec![loc_json(&uri, decl_line, &hit.name, false)]
        }
        "type" | "method" | "field" => {
            let Some(fqcn) = hit.fqcn.as_deref() else {
                return Vec::new();
            };
            let Some(decl) = index.find(fqcn) else {
                return Vec::new();
            };
            let from_jar = decl.from_jar;
            let uri = if from_jar {
                // jar 目标：jdt:// 地址，前端 openJdt 分流到反编译标签页
                crate::fast_decl::jar_uri(&decl.path, fqcn)
            } else {
                crate::lsp::path_to_uri(&decl.path)
            };
            let member = match hit.kind.as_str() {
                "method" => decl.method_line(&hit.name),
                "field" => decl.field_line(&hit.name),
                _ => None,
            };
            let line = if from_jar {
                // jar 侧成员被 load_meta 跳过（行号恒 0），指到类顶部即可
                0
            } else if hit.kind == "type" {
                let l = decl.line.max(0) as u32;
                if l == 0 {
                    return Vec::new();
                }
                crate::fast_decl::fixed_line(&decl.path, fqcn, l)
            } else {
                // 源码侧成员行：索引里没有（新建的方法还没进索引）就回空
                let Some(l) = member.filter(|l| *l > 0) else {
                    return Vec::new();
                };
                crate::fast_decl::fixed_member_line(&decl.path, &hit.name, l as u32)
            };
            vec![loc_json(&uri, line, &hit.name, from_jar)]
        }
        _ => Vec::new(),
    }
}

fn loc_json(uri: &str, line: u32, name: &str, from_jar: bool) -> Value {
    json!({
        "uri": uri,
        "range": {
            "start": { "line": line.saturating_sub(1), "character": 0 },
            "end":   { "line": line.saturating_sub(1), "character": 0 },
        },
        // 非 LSP 字段：前端区分「源码」与「jar 内」，也方便排查
        "name": name,
        "fromJar": from_jar,
    })
}

// ───────────────────────── offset 口径 ─────────────────────────

/// 按 **Java 侧同规则**解码：UTF-8 严格试，失败整份回 GBK。
///
/// 与 `BindingResolver.decode` 逐字对应（那边 `CodingErrorAction.REPORT`）。
/// 🔴 不能改用前端 `workspace::decode` 那套（UTF-16 / BOM / 多字节形状启发式）：
/// 偏移量是给 Java 的 `char[]` 用的，那边不认这些，两边规则差一个字符就是跳错位置。
fn decode_like_java(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::GBK.decode(bytes).0.into_owned(),
    }
}

/// LSP 的 (line 1 基, character 0 基) → Java `char[]` 的绝对下标。
///
/// 🔴 四个口径必须与 Java 侧对齐，差一个字符就是跳到别的符号上：
/// 1. **解码**：`decode_like_java`（UTF-8 严格 → GBK），不是前端那套。
/// 2. **行尾**：char[] 里 CRLF 是两个字符，Monaco 模型里 `read_text_file` 把
///    `\r\n` 归一成一个 `\n` ⇒ 每个前置行按磁盘真实行尾计（`split('\n')` 留下的
///    `\r` 正好算进去）。
/// 3. **BOM**：UTF-8 BOM 在 char[] 里是一个 `\uFEFF` 字符、在模型里没有 ⇒ 它落在
///    第 1 行的长度里，公式自动 +1，不用特判。
/// 4. **character 是 UTF-16 code unit 口径**（LSP 规定、Monaco 列同口径）⇒ 行内
///    按字符逐个累加 `len_utf16()`，够数即停。**不能 `take(character)` 个字符**：
///    光标前有 emoji（代理对，1 字符 = 2 unit）时会按字符数少数一个，整体串位。
///
/// `character` 超出该行长度时钳到行尾（Monaco 点行尾就会给这个值）：落到换行符上
/// 没有绑定，Java 侧回 null，前端退内容搜索——比窜到下一行安全。
fn utf16_offset(bytes: &[u8], line: u32, character: u32) -> Option<usize> {
    if line == 0 {
        return None;
    }
    let text = decode_like_java(bytes);
    let mut start = 0usize;
    for (i, l) in text.split('\n').enumerate() {
        if i as u32 + 1 == line {
            // 累加到 character 个 UTF-16 unit 即停；落在大宽度字符中间（编辑器不该
            // 给这种值）钳到它前面。行尾自然兜住：character 超长时就是把整行走完。
            let mut units = 0usize;
            for c in l.chars() {
                let w = c.len_utf16();
                if units + w > character as usize {
                    break;
                }
                units += w;
            }
            return Some(start + units);
        }
        // len_utf16 求和而非 count：UTF-8 里的 emoji 在 Java char[] 里是两个字符
        start += l.chars().map(|c| c.len_utf16()).sum::<usize>() + 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 含中文的 GBK 行（设计要求「单测钉一个含中文的行」）：
    /// offset 必须按 **GBK 解码后的字符数** 算，不是字节数（「中文」2 字符 = 4 字节）。
    /// 行宽手算钉死：第 1 行 `public class A {` = 16 字符，第 2 行 = 20，第 3 行 = 14。
    #[test]
    fn gbk_中文行按字符数算_offset() {
        let text = "public class A {\n    String s = \"中文\";\n    int x = 1;\n}\n";
        let (bytes, _, _) = encoding_rs::GBK.encode(text);
        assert_eq!(
            "    String s = \"中文\";".chars().count(),
            20,
            "行宽钉死：4 空格 + String + s + = + 引号包 2 个中文字符 + 分号"
        );
        assert_eq!(
            utf16_offset(&bytes, 2, 4),
            Some(16 + 1 + 4),
            "第 2 行起点 17"
        );
        assert_eq!(
            utf16_offset(&bytes, 3, 8),
            Some(16 + 1 + 20 + 1 + 8),
            "第 3 行起点 = 17 + 20 + 1 = 38"
        );
        assert_eq!(utf16_offset(&bytes, 3, 0), Some(16 + 1 + 20 + 1));
    }

    /// UTF-8 文件（Java 侧 strict 解得开）与 GBK 走同一条字符口径：
    /// 同样内容编成 UTF-8，offset 一致——中文在两种编码下都是 1 个字符。
    #[test]
    fn utf8_文件同一字符口径() {
        let text = "class A {\n    String s = \"中文\";\n}\n";
        let gbk = encoding_rs::GBK.encode(text).0;
        let utf8 = text.as_bytes().to_vec();
        assert_eq!(utf16_offset(&gbk, 2, 4), utf16_offset(&utf8, 2, 4));
        assert_eq!(utf16_offset(&utf8, 2, 4), Some(9 + 1 + 4));
    }

    /// CRLF：char[] 里 `\r\n` 是两个字符，Monaco 模型里是一个 ⇒ 每个前置行 +1。
    /// 用错行尾口径，光标越靠后跳得越偏。
    #[test]
    fn crlf_每个前置行多一个字符() {
        let lf = "class A {\n    int x = 1;\n    int y = 2;\n}\n";
        let crlf = lf.replace('\n', "\r\n");
        let a = utf16_offset(lf.as_bytes(), 3, 8).unwrap();
        let b = utf16_offset(crlf.as_bytes(), 3, 8).unwrap();
        assert_eq!(a, 9 + 1 + 14 + 1 + 8, "LF 口径");
        assert_eq!(b, a + 2, "两个前置行各多一个 \\r");
    }

    /// UTF-8 BOM：char[0] 是 `\uFEFF`，模型里没有 ⇒ 第 1 行的 offset 整体 +1。
    #[test]
    fn utf8_bom_整体偏移一位() {
        let text = "class A {\n    int x = 1;\n}\n";
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice(text.as_bytes());
        assert_eq!(utf16_offset(text.as_bytes(), 2, 4), Some(9 + 1 + 4));
        assert_eq!(utf16_offset(&with_bom, 2, 4), Some(9 + 1 + 1 + 4));
    }

    /// `character` 是 **UTF-16 code unit** 口径（LSP 规定、Monaco 列同此）：光标前的
    /// emoji 是 1 字符 2 unit。按字符数 `take(character)` 会少数一个 unit、整体向后
    /// 串位——点收尾引号会落到分号上（2026-11-22 审查抓到的原实现，回归钉住）。
    #[test]
    fn 行内emoji按utf16单位累加不串位() {
        // 第 2 行 `  String s = "🎉";` = 17 字符 / 18 UTF-16 unit；第 2 行起点 10
        let text = "class A {\n  String s = \"🎉\";\n  int y = 2;\n}\n";
        let bytes = text.as_bytes();
        // emoji 之前的起始引号：14 个单位全是 BMP，两种数法一致
        assert_eq!(utf16_offset(bytes, 2, 14), Some(10 + 14), "emoji 之前");
        // 点收尾引号：真实 unit = 16（emoji 占 2）；按字符数会算成 17，串到分号上
        assert_eq!(utf16_offset(bytes, 2, 16), Some(10 + 16), "emoji 之后");
        // 落在代理对中间（正常编辑器不会给）：钳到 emoji 前，不窜位
        assert_eq!(utf16_offset(bytes, 2, 15), Some(10 + 14), "代理对中间钳前");
        // character 超长：走完整行（18 个 unit）
        assert_eq!(utf16_offset(bytes, 2, 999), Some(10 + 18), "超长钳到行尾");
    }

    /// 行号 0 / 超范围 / character 超行尾：None 或钳到行尾，都不许窜到下一行。
    #[test]
    fn 越界与钳位() {
        let text = "class A {\n    int x = 1;\n}\n";
        assert_eq!(utf16_offset(text.as_bytes(), 0, 0), None, "line 0 非法");
        assert_eq!(utf16_offset(text.as_bytes(), 9, 0), None, "超出文件行数");
        // 第 2 行 `    int x = 1;` = 14 字符，起点 10；给 999 钳到行尾 = 24
        assert_eq!(utf16_offset(text.as_bytes(), 2, 999), Some(10 + 14));
    }

    /// 本地变量：声明就在本文件里，走 `local_decl_line` 指回声明行。
    #[test]
    fn 本地变量跳本文件声明行() {
        let work = crate::test_support::tmp("bind-cmd-local");
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let file = work.join("A.java");
        std::fs::write(
            &file,
            "public class A {\n    void m() {\n        String vo = \"x\";\n        System.out.println(vo);\n    }\n}\n",
        )
        .unwrap();
        let hit = Hit {
            kind: "local".to_string(),
            fqcn: None,
            name: "vo".to_string(),
            problems: 0,
        };
        let locs = to_locations(&hit, &DeclIndex::default(), &file, 4);
        assert_eq!(locs.len(), 1);
        let loc = &locs[0];
        assert_eq!(loc["name"], "vo");
        assert_eq!(loc["fromJar"], false);
        assert_eq!(loc["range"]["start"]["line"], 2, "声明在第 3 行（0 基 2）");
        assert!(
            loc["uri"].as_str().unwrap().ends_with("A.java"),
            "uri 指向本文件：{}",
            loc["uri"]
        );
        let _ = std::fs::remove_dir_all(&work);
    }

    /// 索引里查不到（空索引 / 类型不在索引）⇒ 回空，让前端退内容搜索。
    #[test]
    fn 索引查不到回空() {
        let work = crate::test_support::tmp("bind-cmd-miss");
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let file = work.join("A.java");
        std::fs::write(&file, "public class A {}\n").unwrap();
        let hit = Hit {
            kind: "method".to_string(),
            fqcn: Some("nc.vo.A".to_string()),
            name: "getCode".to_string(),
            problems: 0,
        };
        assert!(to_locations(&hit, &DeclIndex::default(), &file, 1).is_empty());
        let _ = std::fs::remove_dir_all(&work);
    }
}
