//! BMF（NC 元数据组件）的只读解析与语义模型。
//!
//! **为什么不用 XML crate**：写回（M2）要「只改用户编辑的那几个属性，其余字节原样
//! 保留」。serde 式全量往返会把属性顺序、空白、未知节点、命名空间前缀全重排一遍，
//! 生成出来的 diff 没法审核。这里手写一个只认语法的扫描器，每个节点记下自己占的
//! 字节区间；未编辑节点写回时直接拷贝原字节。顺带省掉一个新依赖。
//!
//! 解析纪律：
//! - 不认识的一律**保留**：未知标签、未知属性、注释、`<![CDATA[]]>` 都不丢，只不解释。
//! - 解析失败不吞：错误带字节偏移，索引层把它变成一条可见的问题。
//! - 139 个零实体组件是合法形态（纯枚举 / 纯接口 / 历史残留），不是解析失败。
//!
//! 属性值按 UTF-8 解码（本机实测 3711 个 BMF：3691 声明 UTF-8、20 个无声明，
//! 0 个 GBK）。展示层用有损解码，写回层从不反序列化整份文档，所以不影响字节保真。

use std::ops::Range;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::workspace::{detect_encoding, decode_lossy, Eol, TextEncoding};

/// 一个 XML 属性。`value_span` 指向引号**之间**的原始字节，M2 改属性时只替换这一段。
#[derive(Debug, Clone)]
pub struct XmlAttr {
    pub name: String,
    pub value: String,
    pub value_span: Range<usize>,
}

/// 一个 XML 元素。`end` 指向结束标签（或自闭合 `/`）之后的第一个字节。
#[derive(Debug, Clone)]
pub struct XmlNode {
    pub name: String,
    pub attrs: Vec<XmlAttr>,
    /// `<` 的偏移。
    pub start: usize,
    /// 起始标签 `>` 之后的偏移。
    pub start_tag_end: usize,
    pub end: usize,
    pub self_closing: bool,
    pub children: Vec<XmlNode>,
}

impl XmlNode {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case(name))
            .map(|a| a.value.as_str())
    }

    pub fn attr_or(&self, name: &str, dflt: &str) -> String {
        self.attr(name).unwrap_or(dflt).to_string()
    }

    pub fn child(&self, name: &str) -> Option<&XmlNode> {
        self.children.iter().find(|c| c.name == name)
    }

    /// 该节点在源文件里的原始字节（含标签），用于检查器展示。
    pub fn raw(&self, bytes: &[u8]) -> String {
        decode_lossy(&bytes[self.start..self.end.min(bytes.len())])
    }
}

/// 只读解析 XML 字节，返回根节点。
///
/// 支持：XML 声明、注释、`<![CDATA[]]>`、DOCTYPE（跳过）、自闭合标签、单/双引号属性。
/// 不支持（也用不到）：DTD 实体展开、命名空间语义。遇到语法错误返回带偏移的说明。
pub fn parse(bytes: &[u8]) -> Result<XmlNode, String> {
    let mut i = skip_misc(bytes, 0)?;
    if i >= bytes.len() {
        return Err("空文件：没有 XML 根节点".to_string());
    }
    let (node, next) = parse_element(bytes, i)?;
    i = skip_misc(bytes, next)?;
    // 根之后只允许空白/注释；有第二个根节点说明文件被拼接坏了
    if i < bytes.len() {
        return Err(format!("根节点之后还有内容（字节偏移 {i}）"));
    }
    Ok(node)
}

fn skip_misc(b: &[u8], mut i: usize) -> Result<usize, String> {
    // UTF-8 BOM：不是空白，但也不是根节点的一部分
    if i == 0 && b.starts_with(&[0xEF, 0xBB, 0xBF]) {
        i = 3;
    }
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return Ok(i);
        }
        if b[i] != b'<' {
            // 元素之间的文本（BMF 里少见，但 description 之类可能带内容）。
            // 不解释，直接跳过——模型只用属性，写回也不碰文本节点。
            match b[i..].iter().position(|c| *c == b'<') {
                Some(k) => {
                    i += k;
                    continue;
                }
                None => return Ok(b.len()),
            }
        }
        if b[i..].starts_with(b"<!--") {
            i = find_after(b, i + 4, b"-->")?;
        } else if b[i..].starts_with(b"<?") {
            i = find_after(b, i + 2, b"?>")?;
        } else if b[i..].starts_with(b"<!") {
            // DOCTYPE 等；内部子集里可能有 '>'，但 BMF 不使用 DTD
            i = find_after(b, i + 2, b">")?;
        } else {
            return Ok(i);
        }
    }
}

fn find_after(b: &[u8], from: usize, pat: &[u8]) -> Result<usize, String> {
    if let Some(k) = b[from.min(b.len())..].windows(pat.len()).position(|w| w == pat) {
        Ok(from + k + pat.len())
    } else {
        Err(format!("未闭合的标记，起点字节偏移 {from}"))
    }
}

fn is_name_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b':' | b'.' | b'-')
}

fn parse_element(b: &[u8], start: usize) -> Result<(XmlNode, usize), String> {
    let mut i = start;
    if b.get(i) != Some(&b'<') {
        return Err(format!("期望 <，实际字节偏移 {i}"));
    }
    i += 1;
    let name_start = i;
    while i < b.len() && is_name_byte(b[i]) {
        i += 1;
    }
    if i == name_start {
        return Err(format!("标签名为空（字节偏移 {start}）"));
    }
    let name = String::from_utf8_lossy(&b[name_start..i]).into_owned();
    let mut attrs = Vec::new();
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        match b.get(i) {
            Some(b'>') => {
                i += 1;
                let tag_end = i;
                let mut children = Vec::new();
                loop {
                    i = skip_misc(b, i)?;
                    if i >= b.len() {
                        return Err(format!("<{name}> 没有闭合（起点字节偏移 {start}）"));
                    }
                    if b[i..].starts_with(b"</") {
                        let close_start = i;
                        i += 2;
                        let ns = i;
                        while i < b.len() && is_name_byte(b[i]) {
                            i += 1;
                        }
                        let close_name = String::from_utf8_lossy(&b[ns..i]).into_owned();
                        if close_name != name {
                            return Err(format!(
                                "闭合标签 </{close_name}> 与 <{name}> 不匹配（字节偏移 {close_start}）"
                            ));
                        }
                        i = find_after(b, i, b">")?;
                        return Ok((
                            XmlNode {
                                name,
                                attrs,
                                start,
                                start_tag_end: tag_end,
                                end: i,
                                self_closing: false,
                                children,
                            },
                            i,
                        ));
                    }
                    let (child, next) = parse_element(b, i)?;
                    children.push(child);
                    i = next;
                }
            }
            Some(b'/') if b.get(i + 1) == Some(&b'>') => {
                i += 2;
                return Ok((
                    XmlNode {
                        name,
                        attrs,
                        start,
                        start_tag_end: i,
                        end: i,
                        self_closing: true,
                        children: Vec::new(),
                    },
                    i,
                ));
            }
            Some(_) => {
                let astart = i;
                while i < b.len() && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'/' | b'>')
                {
                    i += 1;
                }
                let aname = String::from_utf8_lossy(&b[astart..i]).into_owned();
                while i < b.len() && b[i].is_ascii_whitespace() {
                    i += 1;
                }
                if b.get(i) != Some(&b'=') {
                    return Err(format!("属性 `{aname}` 缺少 =（字节偏移 {astart}）"));
                }
                i += 1;
                while i < b.len() && b[i].is_ascii_whitespace() {
                    i += 1;
                }
                let quote = match b.get(i) {
                    Some(q @ (b'"' | b'\'')) => *q,
                    _ => return Err(format!("属性 `{aname}` 的值没有引号（字节偏移 {i}）")),
                };
                i += 1;
                let vstart = i;
                while i < b.len() && b[i] != quote {
                    i += 1;
                }
                if i >= b.len() {
                    return Err(format!("属性 `{aname}` 的值没有闭合引号"));
                }
                let value = decode_entities(&decode_lossy(&b[vstart..i]));
                attrs.push(XmlAttr {
                    name: aname,
                    value,
                    value_span: vstart..i,
                });
                i += 1;
            }
            None => return Err(format!("<{name}> 起始标签没有结束")),
        }
    }
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(j) = tail.find(';').filter(|j| *j <= 12) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let ent = &tail[1..j];
        let ch = match ent {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if ent.starts_with("#x") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
            _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &tail[j + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn num(s: &str) -> Option<u32> {
    s.trim().parse::<u32>().ok()
}

fn bool_attr(s: &str) -> bool {
    s.eq_ignore_ascii_case("true")
}

// ─────────────────────────── 语义模型 ───────────────────────────

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BmfComponent {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub namespace: String,
    pub own_module: String,
    pub gen_code_style: String,
    pub version: i32,
    pub main_entity: String,
    pub industry: String,
    pub meta_type: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attr {
    pub id: String,
    pub name: String,
    pub field: String,
    pub display_name: String,
    pub type_name: String,
    pub type_display_name: String,
    pub data_type: String,
    pub style: String,
    pub db_type: String,
    pub field_type: String,
    pub length: Option<u32>,
    pub precision: Option<u32>,
    pub is_key: bool,
    pub nullable: bool,
    pub default_value: String,
    pub ref_model: String,
    pub sequence: i32,
    /// `dataType` 指向的实体/枚举名（同组件内解析；基础类型为空）。
    pub ref_target: String,
    /// 原始 `<attribute …/>` 字节（检查器用）。
    pub raw: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub full_class: String,
    pub table: String,
    pub accessor: String,
    pub is_primary: bool,
    pub key_attr_id: String,
    pub attrs: Vec<Attr>,
    pub raw: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumItem {
    pub id: String,
    pub value: String,
    pub display: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumDef {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub type_name: String,
    pub data_type: String,
    pub full_class: String,
    pub items: Vec<EnumItem>,
    pub raw: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub source: String,
    pub target: String,
    pub src_attr_id: String,
    pub target_attr_id: String,
}

/// 解析成功的一份 BMF。`bytes` 保留原样，写回时以它为底。
#[derive(Debug, Clone)]
pub struct BmfDoc {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
    pub encoding: TextEncoding,
    pub eol: Eol,
    pub has_bom: bool,
    pub root: XmlNode,
    pub component: BmfComponent,
    pub entities: Vec<Entity>,
    pub enums: Vec<EnumDef>,
    pub relations: Vec<Relation>,
    /// 顶层出现过的、我们不认识的标签（原样保留，只在检查器提示）。
    pub unknown_tags: Vec<String>,
}

impl BmfDoc {
    pub fn open(path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("读取失败：{e}"))?;
        Self::from_bytes(path.to_path_buf(), bytes)
    }

    pub fn from_bytes(path: PathBuf, bytes: Vec<u8>) -> Result<Self, String> {
        let root = parse(&bytes)?;
        if root.name != "component" {
            return Err(format!("根节点是 <{}>，不是 <component>", root.name));
        }
        let encoding = detect_encoding(&bytes);
        let has_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
        let eol = detect_eol(&bytes);
        let component = BmfComponent {
            id: root.attr_or("id", ""),
            name: root.attr_or("name", ""),
            display_name: root.attr_or("displayName", ""),
            namespace: root.attr_or("namespace", ""),
            own_module: root.attr_or("ownModule", ""),
            gen_code_style: root.attr_or("gencodestyle", ""),
            version: root.attr("version").and_then(num).map(|v| v as i32).unwrap_or(0),
            main_entity: root.attr_or("mainEntity", ""),
            industry: root.attr_or("industry", ""),
            meta_type: root.attr_or("metaType", ""),
        };

        let mut entities = Vec::new();
        let mut enums = Vec::new();
        let mut relations = Vec::new();
        let mut unknown_tags = Vec::new();
        for child in &root.children {
            match child.name.as_str() {
                "celllist" => {
                    for cell in &child.children {
                        match cell.name.as_str() {
                            "entity" => entities.push(read_entity(cell, &bytes)),
                            "Enumerate" => enums.push(read_enum(cell, &bytes)),
                            other => push_unique(&mut unknown_tags, other),
                        }
                    }
                }
                "connectlist" => {
                    for c in &child.children {
                        if matches!(
                            c.name.as_str(),
                            "AggregationRelation" | "busiitfconnection" | "Reference"
                        ) {
                            relations.push(Relation {
                                id: c.attr_or("id", ""),
                                kind: c.name.clone(),
                                name: c.attr_or("name", ""),
                                source: c.attr_or("source", ""),
                                target: c.attr_or("target", ""),
                                src_attr_id: c.attr_or("srcAttributeid", c.attr("srcAttributeId").unwrap_or("")),
                                target_attr_id: c.attr_or("targetAttributeid", ""),
                            });
                        } else {
                            push_unique(&mut unknown_tags, &c.name);
                        }
                    }
                }
                "refdepends" | "refdependLoseIDs" | "cellRemoveLog" | "rulers" => {}
                other => push_unique(&mut unknown_tags, other),
            }
        }

        // dataType 指向实体/枚举的，补出可读名字：检查器里只看到一串 GUID 没法判断
        // 「这个参照到底指向谁」。
        let mut targets: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for e in &entities {
            targets.insert(e.id.clone(), e.name.clone());
        }
        for e in &enums {
            targets.insert(e.id.clone(), e.name.clone());
        }
        for e in &mut entities {
            for a in &mut e.attrs {
                if let Some(t) = targets.get(&a.data_type) {
                    a.ref_target = t.clone();
                }
            }
        }

        Ok(Self {
            path,
            bytes,
            encoding,
            eol,
            has_bom,
            root,
            component,
            entities,
            enums,
            relations,
            unknown_tags,
        })
    }

    /// 组件主实体；`mainEntity` 悬空时返回第一个 `isPrimary`，再退回第一个实体。
    pub fn primary_entity(&self) -> Option<&Entity> {
        self.entities
            .iter()
            .find(|e| e.id == self.component.main_entity)
            .or_else(|| self.entities.iter().find(|e| e.is_primary))
            .or_else(|| self.entities.first())
    }

    /// 按行号定位字节偏移（问题列表的「文件第 N 行」）。1 起算。
    pub fn line_of(&self, offset: usize) -> u32 {
        let end = offset.min(self.bytes.len());
        self.bytes[..end].iter().filter(|b| **b == b'\n').count() as u32 + 1
    }

    pub fn find_node(&self, id: &str) -> Option<&XmlNode> {
        fn walk<'a>(n: &'a XmlNode, id: &str) -> Option<&'a XmlNode> {
            if n.attr("id") == Some(id) {
                return Some(n);
            }
            n.children.iter().find_map(|c| walk(c, id))
        }
        walk(&self.root, id)
    }

    pub fn node_xml(&self, id: &str) -> Option<String> {
        self.find_node(id).map(|n| n.raw(&self.bytes))
    }
}

fn read_entity(n: &XmlNode, bytes: &[u8]) -> Entity {
    let mut attrs = Vec::new();
    if let Some(list) = n.child("attributelist") {
        for a in &list.children {
            if a.name != "attribute" {
                continue;
            }
            let style = a.attr_or("dataTypeStyle", "SINGLE");
            attrs.push(Attr {
                id: a.attr_or("id", ""),
                name: a.attr_or("name", ""),
                field: a.attr_or("fieldName", ""),
                display_name: a.attr_or("displayName", ""),
                type_name: a.attr_or("typeName", ""),
                type_display_name: a.attr_or("typeDisplayName", ""),
                data_type: a.attr_or("dataType", ""),
                style,
                db_type: a.attr_or("dbtype", ""),
                field_type: a.attr_or("fieldType", ""),
                length: a.attr("length").and_then(num),
                precision: a.attr("precise").and_then(num),
                is_key: bool_attr(a.attr_or("isKey", "false").as_str()),
                nullable: bool_attr(a.attr_or("isNullable", "true").as_str()),
                default_value: a.attr_or("defaultValue", ""),
                ref_model: a.attr_or("refModelName", ""),
                sequence: a.attr("sequence").and_then(|s| s.parse::<i32>().ok()).unwrap_or(0),
                ref_target: String::new(),
                raw: a.raw(bytes),
            });
        }
    }
    attrs.sort_by_key(|a| a.sequence);
    Entity {
        id: n.attr_or("id", ""),
        name: n.attr_or("name", ""),
        display_name: n.attr_or("displayName", ""),
        full_class: n.attr_or("fullClassName", ""),
        table: n.attr_or("tableName", ""),
        accessor: n.attr_or("accessorClassName", ""),
        is_primary: bool_attr(n.attr_or("isPrimary", "false").as_str()),
        key_attr_id: n.attr_or("keyAttributeId", ""),
        attrs,
        raw: n.raw(bytes),
    }
}

fn read_enum(n: &XmlNode, bytes: &[u8]) -> EnumDef {
    let mut items = Vec::new();
    if let Some(list) = n.child("enumitemlist") {
        for i in &list.children {
            if i.name != "enumitem" {
                continue;
            }
            items.push(EnumItem {
                id: i.attr_or("id", ""),
                value: i.attr_or("enumValue", ""),
                display: i.attr_or("enumDisplay", ""),
                hidden: bool_attr(i.attr_or("hidden", "false").as_str()),
            });
        }
    }
    items.sort_by(|a, b| {
        a.value
            .parse::<i64>()
            .ok()
            .cmp(&b.value.parse::<i64>().ok())
            .then(a.value.cmp(&b.value))
    });
    EnumDef {
        id: n.attr_or("id", ""),
        name: n.attr_or("name", ""),
        display_name: n.attr_or("displayName", ""),
        type_name: n.attr_or("typeName", ""),
        data_type: n.attr_or("dataType", ""),
        full_class: n.attr_or("fullClassName", ""),
        items,
        raw: n.raw(bytes),
    }
}

fn push_unique(v: &mut Vec<String>, s: &str) {
    if !v.iter().any(|x| x == s) {
        v.push(s.to_string());
    }
}

fn detect_eol(bytes: &[u8]) -> Eol {
    let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 1;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    if cr > 0 || (crlf > 0 && lf > 0) {
        Eol::Mixed
    } else if lf > 0 {
        Eol::Lf
    } else {
        Eol::Crlf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<component id="c1" name="sz02" displayName="任务接口" namespace="uapbd" ownModule="uapbd" gencodestyle="NC传统样式" version="5" mainEntity="e1" industry="0" metaType=".bmf">
  <celllist>
    <entity id="e1" name="Sz02HVO" displayName="表头" fullClassName="nc.vo.uapbd.sz02.Sz02HVO" tableName="uapbd_sz02_h" accessorClassName="x" isPrimary="true" keyAttributeId="a1">
      <attributelist>
        <attribute id="a1" name="pk_head" fieldName="pk_head" displayName="主键" typeName="UFID" dataType="BS000010000100001051" dataTypeStyle="SINGLE" dbtype="char" fieldType="char" length="20" isKey="true" isNullable="false" sequence="0"/>
        <attribute id="a2" name="pk_body" fieldName="pk_head" displayName="表体" typeName="Sz02BVO" dataType="e2" dataTypeStyle="ARRAY" sequence="1"/>
      </attributelist>
    </entity>
    <entity id="e2" name="Sz02BVO" tableName="uapbd_sz02_b">
      <attributelist><attribute id="a3" name="pk_body" fieldName="pk_body" typeName="UFID" length="20" isKey="true" sequence="0"/></attributelist>
    </entity>
    <Enumerate id="en1" name="state" displayName="状态" dataType="BS000010000100001001" typeName="String">
      <enumitemlist>
        <enumitem id="i1" enumValue="1" enumDisplay="停用"/>
        <enumitem id="i2" enumValue="0" enumDisplay="启用"/>
      </enumitemlist>
    </Enumerate>
  </celllist>
  <connectlist>
    <AggregationRelation id="r1" source="e1" target="e2" srcAttributeid="a2"/>
  </connectlist>
  <refdepends/>
  <rulers><ruler><guideList/></ruler></rulers>
  <FutureNode foo="bar"><inner/></FutureNode>
</component>"#;

    fn doc() -> BmfDoc {
        BmfDoc::from_bytes(PathBuf::from("sample.bmf"), SAMPLE.as_bytes().to_vec()).unwrap()
    }

    #[test]
    fn parses_component_entities_enums_and_spans() {
        let d = doc();
        assert_eq!(d.component.name, "sz02");
        assert_eq!(d.component.version, 5);
        assert_eq!(d.entities.len(), 2);
        assert_eq!(d.entities[0].attrs.len(), 2);
        assert_eq!(d.entities[0].attrs[0].name, "pk_head");
        assert!(d.entities[0].attrs[0].is_key);
        assert_eq!(d.enums.len(), 1);
        // 枚举按值排序，显示名不错位
        assert_eq!(d.enums[0].items[0].value, "0");
        assert_eq!(d.enums[0].items[0].display, "启用");
        // 引用目标按 dataType 解析成了实体名
        assert_eq!(d.entities[0].attrs[1].ref_target, "Sz02BVO");
        assert_eq!(d.relations.len(), 1);
        assert_eq!(d.unknown_tags, vec!["FutureNode".to_string()]);
    }

    #[test]
    fn byte_spans_point_at_attribute_values() {
        let d = doc();
        let node = d.find_node("e1").unwrap();
        let a = node.attr("name").unwrap();
        assert_eq!(a, "Sz02HVO");
        let at = &d.bytes[node.attrs.iter().find(|x| x.name == "name").unwrap().value_span.clone()];
        assert_eq!(std::str::from_utf8(at).unwrap(), "Sz02HVO");
        assert_eq!(d.line_of(node.start), 4);
    }

    #[test]
    fn raw_xml_is_a_prefix_of_the_file() {
        let d = doc();
        let raw = d.node_xml("a1").unwrap();
        assert!(raw.starts_with("<attribute"));
        assert!(raw.ends_with("/>"));
        assert!(SAMPLE.contains(&raw));
    }

    #[test]
    fn rejects_truncated_or_mismatched_xml() {
        assert!(parse(b"<component><entity></component>").is_err());
        assert!(BmfDoc::from_bytes(PathBuf::new(), b"<entity/>".to_vec()).is_err());
    }

    #[test]
    fn zero_entity_component_is_valid() {
        let d = BmfDoc::from_bytes(
            PathBuf::new(),
            br#"<component name="enumOnly"><celllist/></component>"#.to_vec(),
        )
        .unwrap();
        assert!(d.entities.is_empty());
    }

    #[test]
    fn entities_without_attributelist_do_not_panic() {
        let d = BmfDoc::from_bytes(
            PathBuf::new(),
            br#"<component><celllist><entity name="X"/></celllist></component>"#.to_vec(),
        )
        .unwrap();
        assert_eq!(d.entities[0].attrs.len(), 0);
    }

    #[test]
    fn entity_text_children_are_skipped() {
        let d = BmfDoc::from_bytes(
            PathBuf::new(),
            b"<component><celllist><entity name=\"X\"><description>hi</description></entity></celllist></component>".to_vec(),
        )
        .unwrap();
        assert_eq!(d.entities[0].name, "X");
    }
}
