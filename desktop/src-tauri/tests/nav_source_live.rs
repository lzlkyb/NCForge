//! 真机对照：用户报的「跨模块 Ctrl+点击落到 jar」那条链路，改写前后到底差在哪。
//!
//! 不拉 jdt.ls（本机 jdt.ls 不导入临时 Eclipse 工程，见 `refactor_live` 同样红），
//! 而是用**真实工作区**的类型索引 + **真实形态**的 `jdt://` 地址做对照：
//! 输入就是 jdt.ls 在只链当前模块时会给出的那种单条 LocationLink。
//!
//! 默认不跑（`#[ignore]`）：要本机有 `C:\work\aier\newar` 这个工作区。
//! 用 `NCFORGE_TEST_WORKSPACE` 可指向别的工作区，但类名断言随之失效。
//!
//! ```bash
//! cargo test --test nav_source_live -- --ignored --nocapture --test-threads=1
//! ```

#![allow(non_snake_case)]

use std::path::PathBuf;

use nc_forge::nav_source::{is_nav_method, rewrite};
use nc_forge::workspace_types;
use serde_json::json;

// 与 `java_editing_live.rs` 同一写法：integration 测试拿不到 crate 内部的 `cfg(test)`
// 模块，直接包含源文件。用它而不是裸 `temp_dir()`：`tmp` 返回 canonicalize
// 过的路径，macOS 的 `/var`→`/private/var` 与 Windows CI 的 8.3 短名都不会把索引路径搞错。
#[path = "../src/test_support.rs"]
mod test_support;

fn workspace() -> PathBuf {
    std::env::var("NCFORGE_TEST_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"C:\work\aier\newar"))
}

/// 用户报的那一条：在 `ic` 模块里点 `so` 模块的 DeliveryVO。
///
/// `jdt://` 的形态取自 `decompile.rs` 的既有夹具与实测：`contents/<jar>/<包路径>/<类>.class?=<私有附件>`。
/// jar 名写 `so.jar` 只为构造可读；改写只看包路径与类名，与 jar 名无关。
const DELIVERY_JDT: &str =
    "jdt://contents/so.jar/nc/vo/so/m4331/entity/DeliveryVO.class?=nc-forge-shadow%3D";

#[test]
#[ignore = "需要真实工作区 C:\\work\\aier\\newar"]
fn 跨模块jdt目标改写为工作区源码_对照未改写() {
    let root = workspace();
    assert!(root.is_dir(), "工作区不存在：{}", root.display());
    let cache = test_support::tmp("nav-live");
    let index = workspace_types::shared(&root, &cache);
    assert!(index.len() > 0, "工作区类型索引为空，无法对照");
    println!("索引类型数：{}", index.len());

    // 前提 1：工作区里真的有这个类的源码（否则「显示 jar」是正确行为，本测试无意义）
    let hits = index.exact("nc.vo.so.m4331.entity.DeliveryVO");
    assert!(
        !hits.is_empty(),
        "工作区索引里没有 DeliveryVO —— 本用例的前提不成立"
    );
    let hit = &hits[0];
    println!("源码命中：{} ({}:{})", hit.file, hit.line, hit.column);
    assert_eq!(hit.module, "so", "DeliveryVO 应属 so 模块");
    assert!(
        hit.file.to_lowercase().ends_with("deliveryvo.java"),
        "命中的应是 .java 源码：{}",
        hit.file
    );
    // 磁盘上确实存在（索引可能过期）
    assert!(
        PathBuf::from(&hit.file).is_file(),
        "索引给的路径在磁盘上不存在：{}",
        hit.file
    );

    // 前提 2：jdt.ls 在只链当前模块时给的就是这一条 jdt://（单条，无 file:// 备选）
    let before = json!([{
        "originSelectionRange": {"start":{"line":20,"character":10},"end":{"line":20,"character":20}},
        "targetUri": DELIVERY_JDT,
        "targetRange": {"start":{"line":0,"character":0},"end":{"line":0,"character":0}},
        "targetSelectionRange": {"start":{"line":0,"character":0},"end":{"line":0,"character":0}}
    }]);
    assert!(is_nav_method("textDocument/definition"));

    let (after, n) = rewrite(&before, "ic", &|fqcn| index.exact(fqcn));
    println!("改写条数：{n}");
    println!("改写前：{}", before[0]["targetUri"]);
    println!("改写后：{}", after[0]["targetUri"]);

    // 核心断言：必须真的改了，且落到工作区那份 .java
    assert_eq!(n, 1, "跨模块 jdt 目标必须被改写，否则用户报的 bug 没修好");
    let uri = after[0]["targetUri"].as_str().unwrap();
    assert!(
        uri.starts_with("file://"),
        "改写后应是 file:// ，实际 {uri}"
    );
    assert!(
        uri.to_lowercase().ends_with("deliveryvo.java"),
        "改写后应指向 .java 源码，实际 {uri}"
    );
    assert!(
        uri.to_lowercase().contains("/so/src/public/"),
        "应落在 so 模块的源码目录，实际 {uri}"
    );
    // 位置来自索引（1 基 → 0 基），不再是 jdt.ls 给的 0:0
    let line = after[0]["targetSelectionRange"]["start"]["line"]
        .as_u64()
        .unwrap();
    assert_eq!(line, (hit.line - 1) as u64, "跳转行应是类声明行");
    assert!(line > 0, "不该还停在第 0 行");
    // 来源范围不能被改
    assert_eq!(
        after[0]["originSelectionRange"],
        before[0]["originSelectionRange"]
    );
}

/// 另一半：工作区**没有**的类必须原样回落 jar，不能被改写弄丢。
#[test]
#[ignore = "需要真实工作区 C:\\work\\aier\\newar"]
fn 工作区没有的类原样回落jar() {
    let root = workspace();
    assert!(root.is_dir(), "工作区不存在：{}", root.display());
    let cache = test_support::tmp("nav-live-fb");
    let index = workspace_types::shared(&root, &cache);

    // NC 平台类：只存在于 NCHOME 的 jar 里，工作区没有源码
    let fqcn = "nc.bs.dao.BaseDAO";
    assert!(
        index.exact(fqcn).is_empty(),
        "前提变了：工作区现在有 {fqcn} 的源码，请换一个只存在于 jar 的类"
    );
    let input = json!([{
        "targetUri": "jdt://contents/pubapp.jar/nc/bs/dao/BaseDAO.class?=x",
        "targetRange": {"start":{"line":3,"character":2},"end":{"line":9,"character":4}}
    }]);
    let (out, n) = rewrite(&input, "ic", &|q| index.exact(q));
    println!("回落改写条数：{n}（应为 0）");
    assert_eq!(n, 0, "工作区没有的类不该被改写");
    assert_eq!(out, input, "回落必须原样保留 jdt:// 目标");
}

/// 已经是源码的目标不能被索引位置覆盖：jdt.ls 解析到的位置比索引准。
#[test]
#[ignore = "需要真实工作区 C:\\work\\aier\\newar"]
fn 已是源码的目标不被改写() {
    let root = workspace();
    let cache = test_support::tmp("nav-live-src");
    let index = workspace_types::shared(&root, &cache);
    let hits = index.exact("nc.vo.so.m4331.entity.DeliveryVO");
    assert!(!hits.is_empty());
    // 用真实源码路径构造一个 file:// 目标，位置故意与索引不同
    let real = nc_forge::lsp::path_to_uri(&hits[0].file);
    let input = json!([{
        "targetUri": real,
        "targetRange": {"start":{"line":99,"character":4},"end":{"line":99,"character":14}},
        "targetSelectionRange": {"start":{"line":99,"character":4},"end":{"line":99,"character":14}}
    }]);
    let (out, n) = rewrite(&input, "ic", &|q| index.exact(q));
    assert_eq!(n, 0, "file:// 目标不该被改写");
    assert_eq!(
        out[0]["targetSelectionRange"]["start"]["line"], 99,
        "jdt.ls 给的位置必须保留"
    );
}
