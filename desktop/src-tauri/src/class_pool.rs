//! class 文件常量池的纯字节解析：不启动 JVM，抽出可搜索的符号。
//!
//! # 为什么单独一层
//!
//! Eclipse 的 jar 内搜索靠预建倒排（本机实测 5502 个 `.index` / 345MB），而我们手里的
//! `java_types::TypeCatalog` 只读 ZIP 中央目录的类名——中间缺的正是「类里有什么」。
//! 常量池是定长表项的二进制结构，纯字节可解：实测 120 个 jar 1.22 秒出 89 万条符号，
//! 全量 3341 个 jar 约一分钟，且**中文字符串取到的是原文**——`数据源ID重复` 这类
//! 报错文案因此可搜（这一条连 Eclipse 的索引都没覆盖）。
//!
//! # 物理边界（已写进 UI 常驻说明）
//!
//! class 文件**不含注释**：javac 编译时就剥离了。所以这里能抽出的是类名、方法名、
//! 字段名、常量名、引用类型与字符串字面量——**永远抽不出 jar 里的中文注释**。
//! 用户拿注释关键词搜 jar 必然 0 命中，这不是实现问题。
//!
//! # 去噪
//!
//! 常量池里混着大量编译器结构名（`Code`/`LineNumberTable`/`StackMapTable`…）、
//! JVM 关键字与方法描述符（`(Ljava/lang/String;)V`）。原样进索引只会把体积撑爆、
//! 还把真符号淹掉，所以按白名单思路反向过滤：纯 ASCII 项必须是合法标识符，
//! 含非 ASCII 的项（中文文案、SQL）只要求不含控制字符。

use std::borrow::Cow;

/// 常量池标签。与 `java_types::access_kind` 同一套编号（JVMS §4.4）。
const TAG_UTF8: u8 = 1;
const TAG_INTEGER: u8 = 3;
const TAG_FLOAT: u8 = 4;
const TAG_LONG: u8 = 5;
const TAG_DOUBLE: u8 = 6;
const TAG_CLASS: u8 = 7;
const TAG_STRING: u8 = 8;
const TAG_FIELDREF: u8 = 9;
const TAG_METHODREF: u8 = 10;
const TAG_INTERFACE_METHODREF: u8 = 11;
const TAG_NAME_AND_TYPE: u8 = 12;
const TAG_METHOD_HANDLE: u8 = 15;
const TAG_METHOD_TYPE: u8 = 16;
const TAG_DYNAMIC: u8 = 17;
const TAG_INVOKE_DYNAMIC: u8 = 18;
const TAG_MODULE: u8 = 19;
const TAG_PACKAGE: u8 = 20;

/// 常量池里混进来的编译器结构名。进了索引只会撑体积、淹掉真符号。
const STRUCTURAL: &[&str] = &[
    "Code",
    "LineNumberTable",
    "LocalVariableTable",
    "LocalVariableTypeTable",
    "SourceFile",
    "StackMapTable",
    "Signature",
    "InnerClasses",
    "BootstrapMethods",
    "MethodParameters",
    "RuntimeVisibleAnnotations",
    "RuntimeInvisibleAnnotations",
    "RuntimeVisibleParameterAnnotations",
    "RuntimeInvisibleParameterAnnotations",
    "RuntimeVisibleTypeAnnotations",
    "RuntimeInvisibleTypeAnnotations",
    "AnnotationDefault",
    "EnclosingMethod",
    "Deprecated",
    "Synthetic",
    "ConstantValue",
    "Exceptions",
    "NestHost",
    "NestMembers",
];

/// Java 语言关键字与字面量：搜 `if` / `this` 没有意义。
const KEYWORDS: &[&str] = &[
    "this",
    "super",
    "null",
    "true",
    "false",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "default",
    "break",
    "continue",
    "return",
    "new",
    "instanceof",
    "try",
    "catch",
    "finally",
    "throw",
    "throws",
    "class",
    "interface",
    "enum",
    "extends",
    "implements",
    "public",
    "private",
    "protected",
    "static",
    "final",
    "abstract",
    "void",
    "int",
    "long",
    "short",
    "byte",
    "char",
    "boolean",
    "float",
    "double",
    "import",
    "package",
    "synchronized",
];

/// 单个符号的字节长度上限（ASCII 项）。下限 2 滤掉单字符噪声，上限挡掉极长的二进制块。
const MAX_TERM_BYTES: usize = 128;

/// 含非 ASCII 的项（中文文案 / SQL）单独放宽上限：一个汉字占 3 字节，128 字节只装得下
/// 42 个汉字，而 NC 的报错文案普遍比这长——按 ASCII 的上限整条丢掉，UI 宣称的
/// 「中文文案可搜」就落空了。
const MAX_TERM_BYTES_WIDE: usize = 512;

/// 判断一个常量池字符串是否值得进索引。
///
/// ASCII 项允许 `/` 与 `.`：常量池里的类名是 internal form（`nc/vo/VoucherBillOrder`），
/// 这正是用户最常搜的东西。描述符（`Ljava/lang/String;`、`(I)V`）与泛型签名靠
/// `(`/`[`/`<` 前缀和 `;` 尾字符挡掉——含 `;` 的一律是 JVM 内部记法，用户不会拿它搜。
fn keep(term: &str) -> bool {
    let ascii = term.is_ascii();
    let cap = if ascii {
        MAX_TERM_BYTES
    } else {
        MAX_TERM_BYTES_WIDE
    };
    if term.len() < 2 || term.len() > cap {
        return false;
    }
    // 方法描述符 / 字段描述符 / 泛型签名：JVM 内部记法，用户不会拿它搜。
    if term.starts_with('(') || term.starts_with('[') || term.starts_with('<') {
        return false;
    }
    if term.ends_with(';') || term.contains(';') {
        return false;
    }
    if STRUCTURAL.contains(&term) || KEYWORDS.contains(&term) {
        return false;
    }
    if ascii {
        // 标识符 / internal form 类名：包段之间只允许 `/` 与 `.`，至少一个字母，
        // 避免把纯数字常量当符号。
        term.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b == b'/' || b == b'.')
            && term.bytes().any(|b| b.is_ascii_alphabetic())
    } else {
        // 中文文案 / SQL：任意可打印字符都算，只排控制字符（含 \0 \n \t）。
        !term.chars().any(char::is_control)
    }
}

/// 改性 UTF-8 的一个编码单元：返回（码点, 下一位置）。字节不合规则 `None`。
fn mutf8_unit(raw: &[u8], i: usize) -> Option<(u32, usize)> {
    let b = *raw.get(i)?;
    if b < 0x80 {
        return Some((u32::from(b), i + 1));
    }
    if b & 0xE0 == 0xC0 {
        let b2 = *raw.get(i + 1)?;
        if b2 & 0xC0 != 0x80 {
            return None;
        }
        return Some((u32::from(b & 0x1F) << 6 | u32::from(b2 & 0x3F), i + 2));
    }
    if b & 0xF0 == 0xE0 {
        let b2 = *raw.get(i + 1)?;
        let b3 = *raw.get(i + 2)?;
        if b2 & 0xC0 != 0x80 || b3 & 0xC0 != 0x80 {
            return None;
        }
        return Some((
            u32::from(b & 0x0F) << 12 | u32::from(b2 & 0x3F) << 6 | u32::from(b3 & 0x3F),
            i + 3,
        ));
    }
    None
}

/// 按 Java 改性 UTF-8（JVMS §4.4.7）解码：NUL 编成 `C0 80`，增补字符编成两对 3 字节
/// 代理。标准 UTF-8 校验会把这些字节整条拒绝，而 NC 的常量里真有它们。
fn decode_mutf8(raw: &[u8]) -> Option<String> {
    let mut out = String::new();
    let mut i = 0usize;
    while i < raw.len() {
        let (cp, next) = mutf8_unit(raw, i)?;
        i = next;
        let cp = if (0xD800..=0xDBFF).contains(&cp) {
            let (low, after) = mutf8_unit(raw, i)?;
            if !(0xDC00..=0xDFFF).contains(&low) {
                return None;
            }
            i = after;
            0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00)
        } else {
            cp
        };
        out.push(char::from_u32(cp)?);
    }
    Some(out)
}

/// 把一个 class 的常量池里可搜索的符号追加进 `terms`（**类内去重**）。
///
/// 返回 `false` 表示这个 class 解析不了（截断、非常数池、未知标签）：调用方直接
/// 跳过它，不能 panic——NC 的 jar 里真有畸形 class，一个坏类不能让整个索引建不起来。
///
/// `terms` 里的项绝大多数借用自 `bytes`（零分配）；只有改性 UTF-8 解出来的项是
/// owned。调用方要在这块内存存活期间用掉它们。
pub fn class_terms<'a>(bytes: &'a [u8], terms: &mut Vec<Cow<'a, str>>) -> bool {
    terms.clear();
    if bytes.len() < 10 || bytes[..4] != [0xca, 0xfe, 0xba, 0xbe] {
        return false;
    }
    let u16at = |i: usize| -> Option<usize> {
        Some(u16::from_be_bytes([*bytes.get(i)?, *bytes.get(i + 1)?]) as usize)
    };
    let count = match u16at(8) {
        Some(c) if c > 0 => c,
        _ => return false,
    };
    let mut pos = 10usize;
    let mut i = 1usize;
    while i < count {
        let tag = match bytes.get(pos) {
            Some(t) => *t,
            None => return false,
        };
        pos += 1;
        // 每种标签的载荷长度（JVMS §4.4.1~§4.4.14）。Long/Double 占两个槽位。
        pos += match tag {
            TAG_UTF8 => {
                let len = match u16at(pos) {
                    Some(l) => l,
                    None => return false,
                };
                pos += 2;
                let end = match pos.checked_add(len) {
                    Some(e) if e <= bytes.len() => e,
                    _ => return false,
                };
                let raw = &bytes[pos..end];
                pos = end;
                let item = match std::str::from_utf8(raw) {
                    Ok(text) => Some(Cow::Borrowed(text)),
                    Err(_) => decode_mutf8(raw).map(Cow::Owned),
                };
                if let Some(item) = item {
                    if keep(&item) && !terms.contains(&item) {
                        terms.push(item);
                    }
                }
                // 🔴 这里必须自己推进槽位：底部的 `i += 1` 被 `continue` 跳过了，
                // 漏掉会让每个 Utf8 项都重复占用 #1 槽位，一路读到文件尾判畸形
                // （真实后果：整个 jar 的 class 全部解析失败）。
                i += 1;
                continue;
            }
            TAG_CLASS | TAG_STRING | TAG_METHOD_TYPE | TAG_MODULE | TAG_PACKAGE => 2,
            TAG_FIELDREF
            | TAG_METHODREF
            | TAG_INTERFACE_METHODREF
            | TAG_NAME_AND_TYPE
            | TAG_DYNAMIC
            | TAG_INVOKE_DYNAMIC
            | TAG_INTEGER
            | TAG_FLOAT => 4,
            TAG_LONG | TAG_DOUBLE => {
                i += 1;
                8
            }
            TAG_METHOD_HANDLE => 3,
            _ => return false,
        };
        i += 1;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手搓一个只有常量池的 class：`utf8s` 依次进池，标签前后补合法项。
    fn class_with(utf8s: &[&str]) -> Vec<u8> {
        let mut items: Vec<u8> = Vec::new();
        // #1 起：每个字符串一项
        for s in utf8s {
            items.push(TAG_UTF8);
            items.extend_from_slice(&(s.len() as u16).to_be_bytes());
            items.extend_from_slice(s.as_bytes());
        }
        // 收尾一个 Class 项，让池子看起来像个真 class
        items.push(TAG_CLASS);
        items.extend_from_slice(&1u16.to_be_bytes());
        let count = (utf8s.len() + 2) as u16;
        let mut out = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52];
        out.extend_from_slice(&count.to_be_bytes());
        out.extend_from_slice(&items);
        out
    }

    #[test]
    fn 抽出标识符与中文字符串原文() {
        let bytes = class_with(&[
            "nc/vo/VoucherBillOrder",
            "getVoucherNo",
            "数据源ID重复",
            "查询系统模板失败！",
        ]);
        let mut terms = Vec::new();
        assert!(class_terms(&bytes, &mut terms));
        assert_eq!(
            terms,
            vec![
                "nc/vo/VoucherBillOrder",
                "getVoucherNo",
                "数据源ID重复",
                "查询系统模板失败！"
            ]
        );
    }

    #[test]
    fn 类内去重() {
        let bytes = class_with(&["getVoucherNo", "getVoucherNo", "pk_corp"]);
        let mut terms = Vec::new();
        assert!(class_terms(&bytes, &mut terms));
        assert_eq!(terms, vec!["getVoucherNo", "pk_corp"]);
    }

    #[test]
    fn 滤掉结构名_关键字_描述符与噪声() {
        let bytes = class_with(&[
            "Code",
            "LineNumberTable",
            "StackMapTable",
            "this",
            "return",
            "(Ljava/lang/String;)V",
            "[I",
            "<init>",
            // 带分号的 JVM 记法：`L...;` 字段描述符与泛型签名都靠 `;` 挡掉
            "Ljava/lang/String;",
            "Ljava/util/List<Ljava/lang/String;>;",
            "a",
            "42",
            "valueOf",
        ]);
        let mut terms = Vec::new();
        assert!(class_terms(&bytes, &mut terms));
        assert_eq!(terms, vec!["valueOf"]);
    }

    #[test]
    fn 长串与短串的边界() {
        let long = "x".repeat(MAX_TERM_BYTES + 1);
        let just = "x".repeat(MAX_TERM_BYTES);
        let bytes = class_with(&[&long, &just, "pk"]);
        let mut terms = Vec::new();
        assert!(class_terms(&bytes, &mut terms));
        assert_eq!(terms, vec![just.as_str(), "pk"]);
    }

    #[test]
    fn 畸形_class_不_panic_直接跳过() {
        let mut terms = Vec::new();
        // 空、太短、魔数错
        assert!(!class_terms(&[], &mut terms));
        assert!(!class_terms(&[0xca, 0xfe], &mut terms));
        assert!(!class_terms(
            &[0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 52, 0, 1],
            &mut terms
        ));
        // 常量池计数越界
        assert!(!class_terms(
            &[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0xff, 0xff],
            &mut terms
        ));
        // UTF8 长度超出文件尾
        let mut truncated = class_with(&["getVoucherNo"]);
        truncated.truncate(truncated.len() - 3);
        assert!(!class_terms(&truncated, &mut terms));
        // 未知标签
        let mut unknown = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 2];
        unknown.push(99);
        unknown.push(0);
        unknown.push(0);
        assert!(!class_terms(&unknown, &mut terms));
        // 非法 UTF-8 的字符串项：跳过该项但继续解后面的
        let mut mixed = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 3];
        mixed.push(TAG_UTF8);
        mixed.extend_from_slice(&2u16.to_be_bytes());
        mixed.extend_from_slice(&[0xff, 0xfe]);
        mixed.push(TAG_UTF8);
        mixed.extend_from_slice(&(b"pk_corp".len() as u16).to_be_bytes());
        mixed.extend_from_slice(b"pk_corp");
        assert!(class_terms(&mixed, &mut terms));
        assert_eq!(terms, vec!["pk_corp"]);
    }

    #[test]
    fn long_与_double_占两个槽位() {
        // 手搓：Utf8(#1)、Long(#2，占 #2+#3)、Utf8(#4)。
        // 计数必须是 5：槽位范围 1..4，写成 4 会把 #4 的 Utf8 挡在循环外。
        let mut bytes = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52];
        bytes.extend_from_slice(&5u16.to_be_bytes());
        bytes.push(TAG_UTF8);
        bytes.extend_from_slice(&2u16.to_be_bytes());
        bytes.extend_from_slice(b"pk");
        bytes.push(TAG_LONG);
        bytes.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 1]);
        bytes.push(TAG_UTF8);
        bytes.extend_from_slice(&(b"corp".len() as u16).to_be_bytes());
        bytes.extend_from_slice(b"corp");
        let mut terms = Vec::new();
        assert!(class_terms(&bytes, &mut terms));
        assert_eq!(terms, vec!["pk", "corp"]);
    }

    #[test]
    fn 长中文文案不被_ascii_上限整条丢掉() {
        // 60 个汉字 = 180 字节：按 ASCII 的 128 上限会整条丢掉，而 UI 宣称中文文案可搜
        let text = "凭".repeat(60);
        assert!(text.len() > MAX_TERM_BYTES, "样本必须超过 ASCII 上限");
        let over = "凭".repeat(MAX_TERM_BYTES_WIDE / 3 + 1);
        let bytes = class_with(&[&text, &over, "pk_corp"]);
        let mut terms = Vec::new();
        assert!(class_terms(&bytes, &mut terms));
        assert_eq!(terms, vec![text.as_str(), "pk_corp"]);
    }

    #[test]
    fn 改性_utf8_的增补字符能解出来() {
        // U+20000（CJK 扩展 B）在改性 UTF-8 里是两对 3 字节代理：ED A1 80 / ED B0 80。
        // 标准 UTF-8 校验整条拒绝，以前这类常量一个都进不了索引。
        let mut raw = "凭证".as_bytes().to_vec();
        raw.extend_from_slice(&[0xED, 0xA1, 0x80, 0xED, 0xB0, 0x80]);
        let mut bytes = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52];
        bytes.extend_from_slice(&3u16.to_be_bytes());
        bytes.push(TAG_UTF8);
        bytes.extend_from_slice(&(raw.len() as u16).to_be_bytes());
        bytes.extend_from_slice(&raw);
        bytes.push(TAG_UTF8);
        bytes.extend_from_slice(&(b"pk_corp".len() as u16).to_be_bytes());
        bytes.extend_from_slice(b"pk_corp");
        let mut terms = Vec::new();
        assert!(class_terms(&bytes, &mut terms));
        assert_eq!(terms, vec!["凭证\u{20000}", "pk_corp"]);
    }

    #[test]
    fn 改性_utf8_的_nul_与孤立代理不进索引也不崩() {
        // `C0 80` 是改性 UTF-8 的 NUL：解得出来但属控制字符，按既有规则滤掉；
        // 孤立高代理是坏字节，整项跳过。两者都不能让后面的项解析不下去。
        let nul = [b'a', 0xC0, 0x80, b'b'];
        let lone = [0xED, 0xA1, 0x80];
        let mut bytes = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52];
        bytes.extend_from_slice(&4u16.to_be_bytes());
        for raw in [nul.as_slice(), lone.as_slice(), b"pk_corp".as_slice()] {
            bytes.push(TAG_UTF8);
            bytes.extend_from_slice(&(raw.len() as u16).to_be_bytes());
            bytes.extend_from_slice(raw);
        }
        let mut terms = Vec::new();
        assert!(class_terms(&bytes, &mut terms));
        assert_eq!(terms, vec!["pk_corp"]);
    }
}
