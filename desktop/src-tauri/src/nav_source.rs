//! 跳转结果的「工作区源码优先」改写。
//!
//! 🔴 为什么需要这一层（2026-11-17 实测定位）：影子工程**只 junction 当前模块**
//! （`shadow::generate` 的 `src_dirs` 只由 `spec.module` 拼出）。在 `ic` 模块里
//! Ctrl+点击 `so` 模块的 `DeliveryVO`，jdt.ls 眼里那个类只有 `out/so` 里的字节码
//! （`kind="lib"` 的 class 目录），于是 `textDocument/definition` 只返回**一条**
//! `jdt://` 目标——前端再怎么排序也排不出第二条源码。
//!
//! 而工作区类型索引本来就覆盖全部模块（newar 实测 59 个模块 / 7522 个 `.java`），
//! 「这个类在磁盘哪一行」毫秒级就能答。这里把 jdt.ls 给的 `jdt://` 目标按索引换成
//! 真实 `.java` 位置；索引里没有的类**原样保留**，照旧走 jar 源码 / 反编译。
//!
//! 与 `commands::type_search_cmds` 里「工作区命中就把 jar 同名类滤掉」是同一个口径，
//! 只是那条用在搜索面板，这条用在跳转链路。
//!
//! 纯逻辑模块：不含 tauri 类型，不读磁盘（索引由调用方取好传进来）。

use serde_json::Value;

use crate::decompile::parse_jdt_uri;
use crate::lsp::path_to_uri;
use crate::workspace_types::TypeHit;

/// 一条改写结果：真实源码 URI + 声明位置（0 基，LSP 口径）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceTarget {
    pub uri: String,
    pub line: u32,
    pub character: u32,
}

/// 需要改写的 LSP 方法。定义 / 引用 / 实现三条链路口径必须一致，
/// 否则「跳定义对了、查引用还是 class」。
pub fn is_nav_method(method: &str) -> bool {
    matches!(
        method,
        "textDocument/definition"
            | "textDocument/declaration"
            | "textDocument/typeDefinition"
            | "textDocument/implementation"
            | "textDocument/references"
    )
}

/// 索引命中里挑哪一条。
///
/// 同名类分布在多个模块时（NC 二开常见：`out/xxx` 有产物、`src` 有源码，甚至两个
/// 模块各有一份），优先级：**当前模块 > 路径字典序**。当前模块优先是因为用户正在
/// 那儿干活；其余按字典序只是为了**结果稳定**，不代表哪个更"对"。
pub fn pick_hit(hits: &[TypeHit], current_module: &str) -> Option<SourceTarget> {
    let best = hits
        .iter()
        .min_by_key(|h| (h.module != current_module, h.file.as_str(), h.line))?;
    Some(SourceTarget {
        uri: path_to_uri(&best.file),
        // 索引是 1 基（`TypeHit::line` 注释），LSP 是 0 基。饱和减避免 0 行下溢。
        line: best.line.saturating_sub(1),
        character: best.column.saturating_sub(1),
    })
}

/// 把一条 `jdt://` URI 换成工作区源码目标；不是 jdt 地址或索引没命中则返回 `None`。
pub fn source_target_for(
    uri: &str,
    current_module: &str,
    lookup: &dyn Fn(&str) -> Vec<TypeHit>,
) -> Option<SourceTarget> {
    if !uri.starts_with("jdt://") {
        return None;
    }
    let class = parse_jdt_uri(uri)?;
    let hits = lookup(&class.fqcn);
    pick_hit(&hits, current_module)
}

/// LSP 位置对象：`{ "start": {"line":n,"character":n}, "end":{...} }`。
///
/// 选中范围取「类名长度」而不是整行：peek / 高亮落在类名上，与 jdt.ls 原本给的
/// `targetSelectionRange` 语义一致。
fn range_of(t: &SourceTarget, name_len: u32) -> Value {
    let start = serde_json::json!({"line": t.line, "character": t.character});
    let end = serde_json::json!({"line": t.line, "character": t.character + name_len});
    serde_json::json!({"start": start, "end": end})
}

/// 声明的简单名长度（`nc.vo.X$Inner` → `Inner`）。索引给的是声明列，
/// 选中范围要覆盖类名本身。
fn simple_len(fqcn: &str) -> u32 {
    let tail = fqcn.rsplit(['.', '$']).next().unwrap_or(fqcn);
    // 按字符数而不是字节数：类名理论上是 ASCII，但别在异常输入上给出字节长度。
    tail.chars().count() as u32
}

/// 改写一个 LSP 跳转结果。
///
/// 形态兼容三种（jdt.ls 都会给）：`Location[]`、`LocationLink[]`、单个对象。
/// 🔴 **只改 `jdt://` 目标**：`file://` 的一律不碰——那是 jdt.ls 已经解析到源码的
/// 结果，比索引更准（索引不解析继承与局部变量）。
///
/// 返回 `(新结果, 改写条数)`。一条都没改时返回原值的克隆，调用方可据条数决定要不要
/// 记日志。
pub fn rewrite(
    result: &Value,
    current_module: &str,
    lookup: &dyn Fn(&str) -> Vec<TypeHit>,
) -> (Value, usize) {
    let mut count = 0;
    let out = rewrite_value(result, current_module, lookup, &mut count);
    (out, count)
}

fn rewrite_value(
    v: &Value,
    current_module: &str,
    lookup: &dyn Fn(&str) -> Vec<TypeHit>,
    count: &mut usize,
) -> Value {
    match v {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|it| rewrite_value(it, current_module, lookup, count))
                .collect(),
        ),
        Value::Object(_) => rewrite_one(v, current_module, lookup, count),
        _ => v.clone(),
    }
}

fn rewrite_one(
    obj: &Value,
    current_module: &str,
    lookup: &dyn Fn(&str) -> Vec<TypeHit>,
    count: &mut usize,
) -> Value {
    // LocationLink 用 targetUri/targetRange/targetSelectionRange；Location 用 uri/range。
    let link = obj.get("targetUri").and_then(Value::as_str);
    let plain = obj.get("uri").and_then(Value::as_str);
    let Some(uri) = link.or(plain) else {
        return obj.clone();
    };
    let Some(target) = source_target_for(uri, current_module, lookup) else {
        return obj.clone();
    };
    let Some(class) = parse_jdt_uri(uri) else {
        return obj.clone();
    };
    let range = range_of(&target, simple_len(&class.fqcn));
    let mut out = obj.clone();
    if link.is_some() {
        out["targetUri"] = Value::String(target.uri);
        out["targetRange"] = range.clone();
        out["targetSelectionRange"] = range;
        // originSelectionRange 是「从哪儿跳过来的」，属于源文档，不能动。
    } else {
        out["uri"] = Value::String(target.uri);
        out["range"] = range;
    }
    *count += 1;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(name: &str, module: &str, file: &str, line: u32, column: u32) -> TypeHit {
        TypeHit {
            name: name.to_string(),
            simple: name.rsplit('.').next().unwrap_or(name).to_string(),
            package: name
                .rsplit_once('.')
                .map(|(p, _)| p.to_string())
                .unwrap_or_default(),
            kind: 5,
            file: file.to_string(),
            module: module.to_string(),
            jar: String::new(),
            line,
            column,
        }
    }

    /// 只认 DeliveryVO 的查表：模拟索引里只有这一个类。
    fn only_delivery(fqcn: &str) -> Vec<TypeHit> {
        if fqcn == "nc.vo.so.m4331.entity.DeliveryVO" {
            vec![hit(
                "nc.vo.so.m4331.entity.DeliveryVO",
                "so",
                "c:/work/aier/newar/so/src/public/nc/vo/so/m4331/entity/DeliveryVO.java",
                9,
                14,
            )]
        } else {
            Vec::new()
        }
    }

    const JDT: &str = "jdt://contents/so.jar/nc/vo/so/m4331/entity/DeliveryVO.class?=abc%3D";

    #[test]
    fn nav_methods_cover_definition_references_implementation() {
        for m in [
            "textDocument/definition",
            "textDocument/declaration",
            "textDocument/typeDefinition",
            "textDocument/implementation",
            "textDocument/references",
        ] {
            assert!(is_nav_method(m), "{m} 应当改写");
        }
        // 补全 / 诊断 / 重命名不在其列：改它们会破坏别的语义
        for m in [
            "textDocument/completion",
            "textDocument/rename",
            "textDocument/hover",
            "workspace/executeCommand",
        ] {
            assert!(!is_nav_method(m), "{m} 不该改写");
        }
    }

    /// 用户报的那一条：跨模块 jdt:// 必须换成工作区 .java，行列换成 0 基。
    #[test]
    fn location_link_jdt_becomes_workspace_source() {
        let input = serde_json::json!([{
            "originSelectionRange": {"start":{"line":3,"character":8},"end":{"line":3,"character":18}},
            "targetUri": JDT,
            "targetRange": {"start":{"line":0,"character":0},"end":{"line":0,"character":0}},
            "targetSelectionRange": {"start":{"line":0,"character":0},"end":{"line":0,"character":0}}
        }]);
        let (out, n) = rewrite(&input, "ic", &only_delivery);
        assert_eq!(n, 1);
        assert_eq!(
            out[0]["targetUri"],
            "file:///c:/work/aier/newar/so/src/public/nc/vo/so/m4331/entity/DeliveryVO.java"
        );
        // 索引 9 行 14 列（1 基）→ LSP 8 行 13 列（0 基）
        assert_eq!(out[0]["targetSelectionRange"]["start"]["line"], 8);
        assert_eq!(out[0]["targetSelectionRange"]["start"]["character"], 13);
        // 选中范围覆盖类名 10 个字符（DeliveryVO）
        assert_eq!(out[0]["targetSelectionRange"]["end"]["character"], 23);
        assert_eq!(out[0]["targetRange"], out[0]["targetSelectionRange"]);
        // 来源范围属于当前文档，不能被改
        assert_eq!(
            out[0]["originSelectionRange"],
            input[0]["originSelectionRange"]
        );
    }

    /// 老式 Location（uri/range）也要改，references 给的就是这种。
    #[test]
    fn plain_location_is_rewritten() {
        let input = serde_json::json!({"uri": JDT, "range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}}});
        let (out, n) = rewrite(&input, "ic", &only_delivery);
        assert_eq!(n, 1);
        assert!(out["uri"].as_str().unwrap().ends_with("DeliveryVO.java"));
        assert_eq!(out["range"]["start"]["line"], 8);
        // 不该凭空长出 LocationLink 的字段
        assert!(out.get("targetUri").is_none());
    }

    /// 🔴 工作区没有的类必须原样回落 jar —— 这是「没有才是 jar 包里面的」那半句。
    #[test]
    fn unknown_class_falls_back_to_jdt_untouched() {
        let input = serde_json::json!([{
            "targetUri": "jdt://contents/pub.jar/nc/bs/dao/BaseDAO.class?=x",
            "targetRange": {"start":{"line":1,"character":2},"end":{"line":3,"character":4}}
        }]);
        let (out, n) = rewrite(&input, "ic", &only_delivery);
        assert_eq!(n, 0);
        assert_eq!(out, input);
    }

    /// 🔴 已经是 file:// 的目标一个字都不能动：jdt.ls 解析到源码比索引更准。
    ///
    /// ⚠️ 夹具必须用**索引里真有**的类（`DeliveryVO`）。第一版用的是索引里没有的
    /// `A.java`/`B.java`，于是「只改 jdt://」那道守卫被拆掉后测试照样全绿——
    /// 查表本来就返回空，守卫失效与否看不出差别（2026-11-17 红灯验证实测）。
    /// 这里让 file:// 指向同一个 DeliveryVO：守卫一旦失效，位置就会被索引值覆盖。
    #[test]
    fn file_targets_are_never_touched() {
        let input = serde_json::json!([
            {"targetUri":"file:///c:/work/aier/newar/so/src/public/nc/vo/so/m4331/entity/DeliveryVO.java",
             "targetRange":{"start":{"line":5,"character":1},"end":{"line":5,"character":9}},
             "targetSelectionRange":{"start":{"line":5,"character":1},"end":{"line":5,"character":9}}},
            {"uri":"file:///c:/work/aier/newar/so/src/public/nc/vo/so/m4331/entity/DeliveryVO.java",
             "range":{"start":{"line":7,"character":0},"end":{"line":7,"character":3}}}
        ]);
        let (out, n) = rewrite(&input, "ic", &only_delivery);
        assert_eq!(n, 0);
        assert_eq!(out, input);
        // 位置必须还是 jdt.ls 给的那份，不是索引里的 8/13
        assert_eq!(out[0]["targetSelectionRange"]["start"]["line"], 5);
        assert_eq!(out[1]["range"]["start"]["line"], 7);
    }

    /// 同上，直接钉 `source_target_for` 的协议守卫：file:// 即便索引命中也不改写。
    #[test]
    fn file_uri_never_rewritten_even_when_index_hits() {
        let real = "file:///c:/work/aier/newar/so/src/public/nc/vo/so/m4331/entity/DeliveryVO.java";
        assert_eq!(source_target_for(real, "ic", &only_delivery), None);
    }

    /// 混合结果：只换 jdt 那条，file 那条保持原位原序（不能重排，Monaco 取第一条）。
    #[test]
    fn mixed_targets_keep_order_and_only_jdt_changes() {
        let input = serde_json::json!([
            {"uri":"file:///c:/ws/ic/A.java","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}},
            {"uri": JDT,"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}}
        ]);
        let (out, n) = rewrite(&input, "ic", &only_delivery);
        assert_eq!(n, 1);
        assert_eq!(out[0], input[0]);
        assert!(out[1]["uri"].as_str().unwrap().ends_with("DeliveryVO.java"));
        assert_eq!(out.as_array().unwrap().len(), 2);
    }

    /// 同名类分布在多个模块：当前模块优先。
    #[test]
    fn current_module_wins_over_other_modules() {
        let hits = vec![
            hit("p.Same", "aaa", "c:/ws/aaa/src/public/p/Same.java", 3, 14),
            hit("p.Same", "ic", "c:/ws/ic/src/public/p/Same.java", 5, 14),
        ];
        let t = pick_hit(&hits, "ic").unwrap();
        assert!(t.uri.contains("/ic/"), "{t:?}");
        assert_eq!(t.line, 4);
        // 换个当前模块，选择跟着变
        let t2 = pick_hit(&hits, "aaa").unwrap();
        assert!(t2.uri.contains("/aaa/"));
    }

    /// 都不在当前模块时按路径字典序，且**多次调用结果一致**（稳定性）。
    #[test]
    fn fallback_order_is_stable() {
        let hits = vec![
            hit("p.Same", "zzz", "c:/ws/zzz/src/public/p/Same.java", 1, 1),
            hit("p.Same", "aaa", "c:/ws/aaa/src/public/p/Same.java", 1, 1),
        ];
        let first = pick_hit(&hits, "ic").unwrap();
        for _ in 0..5 {
            assert_eq!(pick_hit(&hits, "ic").unwrap(), first);
        }
        assert!(first.uri.contains("/aaa/"));
    }

    #[test]
    fn empty_hits_give_no_target() {
        assert_eq!(pick_hit(&[], "ic"), None);
        assert_eq!(source_target_for(JDT, "ic", &|_| Vec::new()), None);
    }

    /// 非 jdt 协议、非 class 条目都不该进查表（省一次无谓的索引扫描）。
    #[test]
    fn non_jdt_uri_never_queries_index() {
        let called = std::cell::Cell::new(false);
        let lookup = |_: &str| {
            called.set(true);
            Vec::new()
        };
        assert_eq!(source_target_for("file:///c:/a.java", "ic", &lookup), None);
        assert_eq!(
            source_target_for("jdt://contents/a.jar/p/A.java", "ic", &lookup),
            None
        );
        assert!(!called.get(), "不该为不可改写的地址查索引");
    }

    /// 嵌套类：选中范围按**内层简单名**算长度（`Outer$Inner` → `Inner` 5 个字符）。
    /// 名字怎么回落到索引由 `WorkspaceTypes::exact` 负责，这里只管范围。
    #[test]
    fn nested_class_selection_uses_inner_name() {
        let uri = "jdt://contents/a.jar/p/Outer$Inner.class?=x";
        let lookup = |fqcn: &str| {
            if fqcn == "p.Outer$Inner" {
                vec![hit(
                    "p.Inner",
                    "so",
                    "c:/ws/so/src/public/p/Outer.java",
                    12,
                    20,
                )]
            } else {
                Vec::new()
            }
        };
        let t = source_target_for(uri, "ic", &lookup).unwrap();
        assert_eq!(t.line, 11);
        assert_eq!(t.character, 19);
        let (out, n) = rewrite(&serde_json::json!({"uri":uri,"range":{}}), "ic", &lookup);
        assert_eq!(n, 1);
        // Inner 5 个字符
        assert_eq!(out["range"]["end"]["character"], 24);
    }

    /// 1 基的 0 / 1 不能下溢成 u32::MAX。
    #[test]
    fn zero_based_conversion_saturates() {
        let h = hit("p.A", "so", "c:/ws/so/src/public/p/A.java", 0, 0);
        let t = pick_hit(&[h], "ic").unwrap();
        assert_eq!(t.line, 0);
        assert_eq!(t.character, 0);
    }

    /// 空结果 / null / 标量都不能 panic。
    #[test]
    fn odd_shapes_are_passed_through() {
        for v in [
            Value::Null,
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!("text"),
            serde_json::json!(42),
            serde_json::json!([null, 3, {"noUri": true}]),
        ] {
            let (out, n) = rewrite(&v, "ic", &only_delivery);
            assert_eq!(n, 0);
            assert_eq!(out, v);
        }
    }
}
