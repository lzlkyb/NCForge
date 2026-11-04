//! 工程根的 `manifest.xml`：NC 的**业务组件登记表**（`BusinessComponet`）。
//!
//! 它只登记、不描述工程结构：
//! - 每条给 5 类源码根（`src/public`、`src/client`、`src/private`、`src/test`、`resources`），
//!   但同一个名字可以登记两次（newar 的 `medpub` 就是）；
//! - 覆盖率远不到全部模块——2026-11-03 实测 newar 磁盘上有 59 个带 `src/` 的模块目录，
//!   manifest 只登记 32 个（`aim`、`ali`、`invp` 这些二开模块都不在里面）。
//!
//! 所以这里**只给文件树提供「这个模块是业务组件」的标注**，绝不当作树结构、
//! 类路径或编译范围的来源（那三处的真源分别是磁盘、`.classpath`、磁盘）。
//!
//! 解析器是手写的最小实现，不是通用 XML：格式固定到只有 `BusinessComponet` 和
//! `src` 两种带属性的标签，为此引一个 XML crate 不划算，而且它必须**永不 panic**
//! （manifest 坏了最多是没徽章，不能让文件树打不开）。

use std::path::Path;

use encoding_rs::GBK;
use serde::Serialize;

/// 工程根下的文件名（大写固定的单数形式，不要改成 `MANIFESTS` 之类）。
pub const MANIFEST_FILE: &str = "manifest.xml";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NcComponent {
    /// 目录名，与工程根下的模块目录同名。
    pub name: String,
    /// 显示名。manifest 里常写成与 `name` 相同或空串，前端不要依赖它非空。
    pub dispname: String,
    /// `src/public` 这类源码根，保持 manifest 里的顺序并去重。
    pub roots: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NcManifest {
    pub components: Vec<NcComponent>,
    /// 解析中遇到的异常（同名重复、缺 `name`）。只用于日志与提示，不影响结果。
    pub notes: Vec<String>,
}

/// 登记缺口：磁盘上像模块的目录里，manifest 没登记的那些。
///
/// 只回答「差了哪几个名字」，不判断「该不该登记」：登记表由 NC 设计器维护，
/// `platform` / `pubapputil` 这类平台模块本来就不会在里面。所以这是一个**解释性**
/// 结果（「为什么 `aim` 不在组件范围里」），不是错误清单，界面上只说事实、不报警。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestAudit {
    /// 登记表里有效（去重、非空）的组件名个数。
    pub registered: usize,
    /// 磁盘上像模块的目录个数（`eclipse_cp::module_dirs_of` 的口径：有 `src` 或 `.classpath`）。
    pub on_disk: usize,
    /// 有目录、没登记的名字。**磁盘为准**：缺登记不代表这个模块不能用。
    pub unregistered: Vec<String>,
}

/// 读 `{root}/manifest.xml`。文件不存在就是错误——调用方按「没有徽章」处理。
pub fn read(root: &Path) -> Result<NcManifest, String> {
    let path = root.join(MANIFEST_FILE);
    let bytes = std::fs::read(&path).map_err(|e| format!("读取 {MANIFEST_FILE} 失败: {e}"))?;
    Ok(parse(&decode(&bytes)))
}

/// 把「磁盘上的模块目录」和「登记表」对一遍，算出没登记的那些。
///
/// 磁盘那一半由调用方给（`eclipse_cp::module_dirs_of`，那里判 `src` / `.classpath`），
/// 这里只做名字比对——两边都按小写比：manifest 写 `Bill`、磁盘上是 `bill` 也得算同一个。
pub fn audit(manifest: &NcManifest, on_disk: &[String]) -> ManifestAudit {
    let mut registered: Vec<String> = Vec::new();
    for c in &manifest.components {
        let key = c.name.trim().to_lowercase();
        if !key.is_empty() && !registered.contains(&key) {
            registered.push(key);
        }
    }
    let unregistered = on_disk
        .iter()
        .filter(|d| !registered.contains(&d.trim().to_lowercase()))
        .cloned()
        .collect();
    ManifestAudit {
        registered: registered.len(),
        on_disk: on_disk.len(),
        unregistered,
    }
}

/// manifest 一般是 UTF-8，但 NC 工具产物可能带 BOM，也可能是 GBK
/// （同工程的 `META-INF/module.xml` 就是 gb2312）。先按 UTF-8 解，解不开才回退 GBK：
/// 反过来先试 GBK 会把合法的 UTF-8 中文读成乱码。
fn decode(bytes: &[u8]) -> String {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    match std::str::from_utf8(body) {
        Ok(s) => s.to_string(),
        Err(_) => GBK.decode(body).0.into_owned(),
    }
}

pub fn parse(text: &str) -> NcManifest {
    let clean = strip_comments(text);
    let mut out = NcManifest::default();
    let mut cur: Option<NcComponent> = None;

    // 按 '<' 切段：每段到第一个 '>' 之间的内容就是一个标签（属性里的文本不会出现在这里）。
    for raw in clean.split('<').skip(1) {
        let Some(end) = raw.find('>') else { continue };
        let tag = &raw[..end];
        let closing = tag.starts_with('/');
        let (tag_name, attrs) = split_tag_name(tag.trim_start_matches('/'));

        if closing {
            if tag_name.eq_ignore_ascii_case("BusinessComponet") {
                if let Some(c) = cur.take() {
                    push_component(&mut out, c);
                }
            }
            continue;
        }

        if tag_name.eq_ignore_ascii_case("BusinessComponet") {
            if let Some(c) = cur.take() {
                push_component(&mut out, c);
            }
            cur = Some(NcComponent {
                name: attr(attrs, "name").unwrap_or_default(),
                dispname: attr(attrs, "dispname").unwrap_or_default(),
                roots: Vec::new(),
            });
        } else if tag_name.eq_ignore_ascii_case("src") {
            // 组件之外的 `<src>` 不属于任何业务组件，丢掉
            if let (Some(c), Some(v)) = (cur.as_mut(), attr(attrs, "name")) {
                if !v.is_empty() && !c.roots.iter().any(|r| r.eq_ignore_ascii_case(&v)) {
                    c.roots.push(v);
                }
            }
        }
    }
    if let Some(c) = cur.take() {
        push_component(&mut out, c);
    }
    out
}

/// 同名组件合并（保留第一条的显示名，roots 取并集）。空名的丢弃并记一笔。
fn push_component(out: &mut NcManifest, c: NcComponent) {
    let name = c.name.trim().to_string();
    if name.is_empty() {
        out.notes
            .push("有一个 BusinessComponet 没写 name，已忽略".to_string());
        return;
    }
    if let Some(prev) = out
        .components
        .iter_mut()
        .find(|p| p.name.eq_ignore_ascii_case(&name))
    {
        for r in c.roots {
            if !prev.roots.iter().any(|p| p.eq_ignore_ascii_case(&r)) {
                prev.roots.push(r);
            }
        }
        out.notes
            .push(format!("业务组件 {name} 登记了多次，已合并"));
        return;
    }
    out.components.push(NcComponent { name, ..c });
}

/// 去掉 XML 注释。注释里被注释掉的组件不该算数——NC 工程里真的有注释块。
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("<!--") {
        out.push_str(&rest[..i]);
        match rest[i + 4..].find("-->") {
            // 注释没闭合就到此为止：保留已解析部分，剩下的当垃圾
            Some(j) => rest = &rest[i + 4 + j + 3..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// 标签体拆成「名字 + 剩余属性文本」。遇空白 / `/` / `>` 结束。
fn split_tag_name(tag: &str) -> (&str, &str) {
    let end = tag
        .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
        .unwrap_or(tag.len());
    (&tag[..end], &tag[end..])
}

/// 取属性值。必须校验 key 前面是空白，否则 `dispname="bill"` 里的 `name`
/// 会被当成 `name="bill"`（这是本模块最容易写错的一处，有单测盯着）。
fn attr(tag: &str, key: &str) -> Option<String> {
    for (start, _) in tag.match_indices(key) {
        // 前一个字节是 ASCII 空白才算独立的属性名；多字节字符的尾字节不会是空白，
        // 所以按字节判断在 UTF-8 上也安全。
        let prev_ok = start == 0 || tag.as_bytes()[start - 1].is_ascii_whitespace();
        if !prev_ok {
            continue;
        }
        let rest = tag[start + key.len()..].trim_start();
        if let Some(rest) = rest.strip_prefix('=') {
            let rest = rest.trim_start();
            let quote = rest.chars().next()?;
            if quote == '"' || quote == '\'' {
                let body = &rest[1..];
                return body.find(quote).map(|end| body[..end].to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::eclipse_cp::module_dirs_of;
    use std::path::Path;

    const ROOT: &str = r"C:\work\aier\newar";

    /// 真机快照（`#[ignore]`）：`newar` 上登记表 32 个、磁盘 59 个模块、缺口 27 个。
    ///
    /// 这条盯的是**两个口径都不能漂**：解析器漏标签会让登记数变小（徽章、组件搜索跟着少），
    /// `module_dirs_of` 放宽/收紧判据会让磁盘数变。缺口本身不是错误（`platform` 这类
    /// 平台模块本来就不登记），所以这里只断言数字，不断言「应该补登记」。
    ///
    /// ```bash
    /// node scripts/rust-gate.mjs test --lib -- --ignored 登记缺口_
    /// ```
    #[test]
    #[ignore = "真机：依赖 C:\\work\\aier\\newar"]
    fn 登记缺口_newar快照() {
        let root = Path::new(ROOT);
        if !root.is_dir() {
            eprintln!("跳过：本机没有 {ROOT}");
            return;
        }
        let m = read(root).expect("manifest.xml 应该能读");
        let a = audit(&m, &module_dirs_of(root));
        println!(
            "登记 {} / 磁盘 {} / 未登记 {} 个：{:?}",
            a.registered,
            a.on_disk,
            a.unregistered.len(),
            a.unregistered
        );

        assert_eq!(
            a.registered, 32,
            "newar 的 manifest 登记 32 个（33 条，medpub 重复）"
        );
        assert_eq!(a.on_disk, 59, "newar 根下 59 个目录有 src 或 .classpath");
        assert_eq!(a.unregistered.len(), 27);
        // 已登记的不能出现在缺口里（大小写不敏感）
        for name in ["bill", "gl", "ic", "medpub"] {
            assert!(
                !a.unregistered.iter().any(|n| n.eq_ignore_ascii_case(name)),
                "{name} 是登记过的，不该进缺口"
            );
        }
        // 二开模块确实没登记：这正是界面上那行提示要解释的事实
        for name in ["aim", "ali", "cmp"] {
            assert!(
                a.unregistered.iter().any(|n| n.eq_ignore_ascii_case(name)),
                "{name} 没登记，应该在缺口里"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实 manifest 的片段：缩进不规则、`dispname` 有空值、`<src>` 自闭合。
    const SAMPLE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Manifest>
  <BusinessComponet name="bill" dispname="">
    <public>
      <src name="src/public"/>
    </public>
    <client>
      <src name="src/client"/>
    </client>
    <private>
      <src name="src/private"/>
    </private>
    <test>
      <src name="src/test"/>
    </test>
    <resource>
      <src name="resources"/>
    </resource>
    <funnodes/>
  </BusinessComponet>
  <BusinessComponet  name="baseapp"  dispname="baseapp">
    <public><src name="src/public"/></public>
  </BusinessComponet>
</Manifest>"#;

    #[test]
    fn parses_components_and_roots_in_order() {
        let m = parse(SAMPLE);
        assert_eq!(m.components.len(), 2);
        assert_eq!(m.components[0].name, "bill");
        assert_eq!(
            m.components[0].roots,
            [
                "src/public",
                "src/client",
                "src/private",
                "src/test",
                "resources"
            ]
            .map(String::from)
        );
        assert_eq!(m.components[1].name, "baseapp");
        assert_eq!(m.components[1].dispname, "baseapp");
        assert!(m.notes.is_empty());
    }

    /// `dispname="baseapp"` 里也含 `name`，属性解析必须按完整 key 匹配。
    #[test]
    fn dispname_is_not_mistaken_for_name() {
        let m = parse(r#"<BusinessComponet dispname="foo" name="bar"/>"#);
        assert_eq!(m.components[0].name, "bar");
        assert_eq!(m.components[0].dispname, "foo");
    }

    /// newar 里 `medpub` 真的登记了两次：合并而不是产出两条。
    #[test]
    fn duplicate_component_is_merged_with_note() {
        let m = parse(
            r#"<Manifest>
                 <BusinessComponet name="medpub"><public><src name="src/public"/></public></BusinessComponet>
                 <BusinessComponet name="medpub"><client><src name="src/client"/></client></BusinessComponet>
               </Manifest>"#,
        );
        assert_eq!(m.components.len(), 1);
        assert_eq!(
            m.components[0].roots,
            ["src/public", "src/client"].map(String::from)
        );
        assert_eq!(m.notes.len(), 1);
    }

    #[test]
    fn comments_and_nameless_components_are_dropped() {
        let m = parse(
            r#"<Manifest>
                 <!-- <BusinessComponet name="ghost"><public><src name="src/public"/></public></BusinessComponet> -->
                 <BusinessComponet dispname="无名"><public><src name="src/public"/></public></BusinessComponet>
                 <BusinessComponet name="ok"/>
               </Manifest>"#,
        );
        assert_eq!(m.components.len(), 1);
        assert_eq!(m.components[0].name, "ok");
        assert_eq!(m.notes.len(), 1);
    }

    /// 坏文件不能让调用方炸：没闭合标签、空文件都只得到空清单。
    #[test]
    fn broken_input_yields_empty_not_panic() {
        for bad in ["", "<Manifest>", "<BusinessComponet name=", "<<<>>>"] {
            assert!(
                parse(bad).components.is_empty(),
                "输入 {bad:?} 不该解析出组件"
            );
        }
    }

    /// GBK 写的 manifest（NC 工具产物）要能读；UTF-8 带 BOM 也要能读。
    #[test]
    fn reads_gbk_and_bom_files() {
        let dir = tmpdir("manifest");
        let gbk_text = r#"<Manifest><BusinessComponet name="bill" dispname="票据"/></Manifest>"#;
        let (gbk, _, _) = GBK.encode(gbk_text);
        std::fs::write(dir.join(MANIFEST_FILE), gbk.as_ref()).unwrap();
        let m = read(&dir).unwrap();
        assert_eq!(m.components[0].dispname, "票据");

        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(b"<Manifest><BusinessComponet name=\"bill\"/></Manifest>");
        std::fs::write(dir.join(MANIFEST_FILE), &bom).unwrap();
        assert_eq!(read(&dir).unwrap().components[0].name, "bill");
    }

    /// 文件不存在是 Err（调用方据此退化成「没有徽章」），不是空清单。
    #[test]
    fn missing_manifest_is_an_error() {
        let dir = tmpdir("no-manifest");
        assert!(read(&dir).is_err());
    }

    /// 登记缺口只列「磁盘上有、登记表里没有」的目录。
    ///
    /// 边界都在这里：`Bill` 与 `bill` 是同一个名字（Windows 目录不区分大小写），
    /// 重复登记只算一个，空名字不算；磁盘顺序原样保留（`module_dirs_of` 已排序）。
    #[test]
    fn audit_lists_only_unregistered_modules() {
        let m = parse(
            r#"<Manifest>
                 <BusinessComponet name="Bill"/>
                 <BusinessComponet name="bill"/>
                 <BusinessComponet name="gl"/>
                 <BusinessComponet name=" "/>
               </Manifest>"#,
        );
        let disk: Vec<String> = ["aim", "bill", "gl", "platform"].map(String::from).to_vec();
        let a = audit(&m, &disk);
        assert_eq!(a.registered, 2, "`bill` 登记了两次、空名字不计入");
        assert_eq!(a.on_disk, 4);
        assert_eq!(a.unregistered, ["aim", "platform"].map(String::from));
    }

    /// 全登记时缺口为空数组——前端据此决定「不显示那行提示」。
    #[test]
    fn audit_is_empty_when_everything_is_registered() {
        let m = parse(r#"<BusinessComponet name="gl"/>"#);
        let a = audit(&m, &["gl".to_string()]);
        assert!(a.unregistered.is_empty());
        assert_eq!((a.registered, a.on_disk), (1, 1));
    }

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-ncm-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
