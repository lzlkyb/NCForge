//! 「索引 vs 磁盘」的偏差处理：判过期 + 校正行号。
//!
//! 声明索引是**持久**的（跨重启复用），而源码天天在改。两者一旦不同步，
//! 最坏的结果不是「跳不到」而是**跳到旧行号** —— 用户会以为代码就是那样。本模块就干两件事：
//!
//! 1. [`scan_sources`] / [`stale_reason`]：启动时判断索引还配不配得上当前工作区（不配就重建）
//! 2. [`fixed_line`]：真正跳转前用目标文件核对一次行号（索引行号是建索引那一刻的）
//!
//! 分成独立模块而不是塞进 `fast_decl`：一是体量（那边已经 400+ 行），二是这两件事
//! 与「索引持有/构建」没有关系 —— 它们只认路径和行号。

use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::decl_index::IndexStats;

/// 与 `NcIndexer.SRC_DIRS` / `compile::SRC_DIRS` 同源的三条源根。
///
/// 只用于「判过期」的走盘，**必须与索引器一致**：多一条会把索引没包含的文件算进
/// 最新 mtime（导致每次启动都重建），少一条会漏判（旧索引继续用）。
const SRC_DIRS: [&str; 3] = ["src/public", "src/client", "src/private"];
/// 与 `NcIndexer.NOT_MODULE` / `shadow::NOT_MODULE` 同源：这些不是模块。
const NOT_MODULE: [&str; 4] = ["out", "META-INF", "nclogs", "bin"];

/// 源码侧走盘结果。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SourceScan {
    /// 扫到的 `.java` 个数。**提前退出时是下限而不是总数**，只用于日志。
    pub files: usize,
    /// 扫到的最新 mtime（Unix 毫秒；0 = 一个文件都没有）。
    pub newest_ms: u64,
    /// 发现任何比参照时刻新的文件/目录就为真（并立即停止扫描）。
    pub stale: bool,
}

/// 扫 `<root>/<模块>/src/{public,client,private}` 下的 `.java`，问「有没有比 `newer_than_ms` 更新的」。
///
/// 🔴 遍历规则必须与 `NcIndexer.java` 的 `listModules` + `collectSources` **逐条等价**
/// （同一个 `SRC_DIRS`、同一份 `NOT_MODULE`、连「不跳过点开头的目录」都一样）：
/// 因为 [`stale_reason`] 会比「扫到的文件数」与「索引记录数」，两边差一个文件就会每次启动都重建。
///
/// 目录的 mtime 也一起看：新增文件会改父目录 mtime。但**不能只靠它** ——
/// Windows 上删除文件后目录 mtime 不一定立刻更新，所以「删除」由文件数兜底。
///
/// 一遍走盘的成本实测 **3.7s / 7419 文件**（debug 构建，后台线程），换来的是
/// 「绝不跳到旧行号」。这个交换是划算的 —— 错的跳转比慢的跳转伤害大得多。
pub fn scan_sources(root: &Path, newer_than_ms: u64) -> SourceScan {
    let mut out = SourceScan::default();
    let Ok(rd) = std::fs::read_dir(root) else {
        // 工作区都读不到：当作过期，让上层去重建（重建会给出真实错误）
        out.stale = true;
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if !p.is_dir() || NOT_MODULE.contains(&name.as_str()) {
            continue;
        }
        for d in SRC_DIRS {
            let dir = p.join(d);
            if dir.is_dir() {
                walk_sources(&dir, newer_than_ms, &mut out);
                if out.stale {
                    return out;
                }
            }
        }
    }
    out
}

fn walk_sources(dir: &Path, newer_than_ms: u64, out: &mut SourceScan) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(md) = e.metadata() else { continue };
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if mtime > newer_than_ms {
            out.newest_ms = out.newest_ms.max(mtime);
            out.stale = true;
            return;
        }
        out.newest_ms = out.newest_ms.max(mtime);
        if md.is_dir() {
            walk_sources(&e.path(), newer_than_ms, out);
            if out.stale {
                return;
            }
        } else if e.file_name().to_string_lossy().ends_with(".java") {
            // 大小写敏感，与 `NcIndexer.collectSources` 的 `endsWith(".java")` 完全一致：
            // 差一个 `Foo.JAVA` 就会让两侧计数永久不等，每次启动白重建一遍。
            out.files += 1;
        }
    }
}

/// 过期判据本体（抽出来是为了能单测「什么情况算过期」而不必真建一份索引）。
///
/// 两条互补的判据：
/// 1. **mtime**：有文件/目录比索引新 ⇒ 内容改过（覆盖「改了行号」这个最危险的场景）。
/// 2. **文件数**：扫描数与索引记录数不一致 ⇒ 有增删。
///
/// 为什么两条都要：Windows 上**删文件后父目录的 mtime 不一定立刻更新**（实测：删完 20ms
/// 内读目录 mtime 仍是旧值），少了第二条，「删掉一个类」这种过期就永远发现不了。
///
/// 代价是两侧的遍历规则必须完全一致（见 [`scan_sources`]），否则会每次启动都判定过期。
pub fn stale_reason(scan: &SourceScan, st: &IndexStats) -> Option<String> {
    if scan.stale {
        return Some(format!(
            "工作区有比索引新的文件（最新 {} > 索引 {}）",
            scan.newest_ms, st.built_at_ms
        ));
    }
    if scan.files != st.source_files {
        return Some(format!(
            "源文件数 {} ≠ 索引记录的 {}（有增删）",
            scan.files, st.source_files
        ));
    }
    None
}

/// 用目标文件校正声明行号；校正不了就原样返回（不丢目标）。
///
/// 三种情况：
/// - 索引行仍然对（最常见）→ 原样
/// - 索引行不对但能在文件里找到 `class Foo` → 用找到的那行（文件被编辑后行号漂移）
/// - 两种都对不上（声明跨行/极不常见写法）→ 原样，宁可落到附近也别把目标弄丢
pub fn fixed_line(path: &str, fqcn: &str, line: u32) -> u32 {
    let Ok(bytes) = std::fs::read(path) else {
        return line;
    };
    // 与 `fast_decl::definition` 同一个理由：NC 源码 87% 是 GBK，但标识符全是 ASCII，
    // lossy 解码不影响找 `class Foo`。
    let text = String::from_utf8_lossy(&bytes);
    let simple = fqcn.rsplit(['.', '$']).next().unwrap_or(fqcn);
    let lines: Vec<&str> = text.split('\n').collect();
    if let Some(l) = lines.get(line.saturating_sub(1) as usize) {
        if declares(l, simple) {
            return line;
        }
    }
    for (i, l) in lines.iter().enumerate() {
        if declares(l, simple) {
            return i as u32 + 1;
        }
    }
    line
}

/// 这一行是不是 `simple` 的类型声明（`class` / `interface` / `enum`，含 `@interface`）。
///
/// 注释与 import 行直接排除：`// class Foo` 和 `import x.Foo;` 都不是声明。
fn declares(line: &str, simple: &str) -> bool {
    let t = line.trim_start();
    if t.starts_with("//")
        || t.starts_with('*')
        || t.starts_with("import ")
        || t.starts_with("package ")
    {
        return false;
    }
    for kw in ["class ", "interface ", "enum "] {
        let mut from = 0usize;
        while let Some(p) = t[from..].find(kw) {
            let rest = &t[from + p + kw.len()..];
            if let Some(after) = rest.strip_prefix(simple) {
                // 词边界：`class Foo` 不能命中 `class FooBar`
                let boundary = after
                    .chars()
                    .next()
                    .is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == '$'));
                if boundary {
                    return true;
                }
            }
            from += p + kw.len();
        }
    }
    false
}

/// 用目标文件校正**成员**的声明行号；校正不了就原样返回。
///
/// 与 [`fixed_line`] 同源的问题：索引里的行号是建索引那一刻的，会话内改了文件就漂了。
/// 判据不同 —— 成员没有 `class` 关键字，得按「声明形态」认：
/// - 方法：`[修饰符] 返回类型 name(`（排除 `vo.name(` / `return name(` / 单独成行的调用）
/// - 字段：`Type name` 后跟 `=` / `;`（与 `fast_member::declared_type_in` 同一判据）
///
/// `name` 是简单名（`getCode` / `code`），不带参数也不带类型。
pub fn fixed_member_line(path: &str, name: &str, line: u32) -> u32 {
    let Ok(bytes) = std::fs::read(path) else {
        return line;
    };
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.split('\n').collect();
    if let Some(l) = lines.get(line.saturating_sub(1) as usize) {
        if declares_member(l, name) {
            return line;
        }
    }
    // 只在原行之外找**第一个**匹配。成员声明在文件里是唯一的（同类型不会有两个同名无参方法），
    // 所以「第一个」比「最近的那个」更稳 —— 后者在文件中间插入代码后会偏。
    for (i, l) in lines.iter().enumerate() {
        if declares_member(l, name) {
            return i as u32 + 1;
        }
    }
    line
}

/// 这一行是 `name` 的方法或字段声明吗。
fn declares_member(line: &str, name: &str) -> bool {
    let t = line.trim_start();
    if t.starts_with("//") || t.starts_with('*') {
        return false;
    }
    let mut from = 0usize;
    while let Some(p) = t[from..].find(name) {
        let s = from + p;
        let e = s + name.len();
        from = e;
        if !word_bounds(t, s, e) {
            continue;
        }
        let after = t[e..].trim_start();
        if after.starts_with('(') && declares_method(t, s) {
            return true;
        }
        // 字段：`private String code = null;` / `String code;`
        if (after.starts_with('=') || after.starts_with(';')) && field_type_before(t, s).is_some() {
            return true;
        }
    }
    false
}

/// `name(` 前面得有返回类型，且不是成员访问 / 构造调用 / 控制语句。
fn declares_method(t: &str, at: usize) -> bool {
    let before = t[..at].trim_end();
    if before.is_empty() || before.ends_with('.') || before.ends_with('=') {
        return false;
    }
    // 上一个词是返回类型；`new Foo(` 的 `new`、`return foo(` 的 `return` 都要排除
    let prev = before.split_whitespace().next_back().unwrap_or("");
    !matches!(
        prev,
        "" | "new" | "return" | "throw" | "if" | "while" | "for" | "switch"
    )
}

/// `name` 前面那个类型词。与 `fast_member::declared_type_in` 同一套判据，
/// 但这里只需要「有没有」，不关心具体类型名。
fn field_type_before(t: &str, at: usize) -> Option<&str> {
    let mut head = t[..at].trim_end();
    // 数组后缀可能有多层：`int[][] x`
    while head.ends_with(']') {
        head = head[..head.rfind('[')?].trim_end();
    }
    let b = head.as_bytes();
    let mut start = head.len();
    while start > 0
        && (b[start - 1].is_ascii_alphanumeric()
            || b[start - 1] == b'_'
            || b[start - 1] == b'$'
            || b[start - 1] == b'.')
    {
        start -= 1;
    }
    let tok = &head[start..];
    let simple = tok.rsplit('.').next().unwrap_or(tok);
    let ok = simple
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_uppercase())
        || matches!(
            simple,
            "int" | "long" | "short" | "byte" | "char" | "boolean" | "float" | "double"
        );
    ok.then_some(tok)
}

fn word_bounds(l: &str, s: usize, e: usize) -> bool {
    let b = l.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    (s == 0 || !ident(b[s - 1])) && (e >= b.len() || !ident(b[e]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn put(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn 源码比索引新就判过期() {
        let root = crate::test_support::tmp("drift-scan");
        put(
            &root.join("m1/src/public/a/A.java"),
            "package a; public class A {}",
        );
        put(&root.join("m1/src/public/a/readme.txt"), "不是 java");

        // 索引「刚建好」（未来时刻）⇒ 不算过期；只数 .java
        let s = scan_sources(&root, now_ms() + 100_000);
        assert!(!s.stale, "{s:?}");
        assert_eq!(s.files, 1);

        // 索引是一小时前建的 ⇒ 文件比它新，必须判过期
        let s = scan_sources(&root, now_ms().saturating_sub(3_600_000));
        assert!(s.stale, "旧索引必须判过期：{s:?}");
    }

    /// 删掉的类：靠**文件数不一致**发现。
    ///
    /// 这条测试的第一版指望「删文件 → 父目录 mtime 变新」，在 Windows 上直接红了：
    /// 删完 20ms 读目录 mtime 还是旧值（NTFS 目录时间戳是惰性更新）。所以判据里
    /// 有第二条 —— 扫描数与索引记录数比对，它是确定性的。
    #[test]
    fn 删除源文件靠数量不一致发现过期() {
        let root = crate::test_support::tmp("drift-del");
        let f = root.join("m1/src/private/a/B.java");
        put(&f, "package a; class B {}");
        let built = now_ms() + 100_000; // 索引「比文件新」，让 mtime 判据闭嘴
        let before = scan_sources(&root, built);
        assert!(!before.stale, "{before:?}");
        assert_eq!(before.files, 1);

        std::fs::remove_file(&f).unwrap();
        let after = scan_sources(&root, built);
        assert_eq!(after.files, 0, "删掉后应扫不到文件");
        // mtime 判据在 Windows 上可能确实看不到删除 —— 这正是要数量兜底的原因
        let st = IndexStats {
            source_files: 1,
            built_at_ms: built,
            ..Default::default()
        };
        assert!(
            stale_reason(&after, &st).is_some(),
            "数量不一致必须判过期：{after:?}"
        );
        // 数量对得上、mtime 也不新 ⇒ 才能复用
        assert!(stale_reason(&before, &st).is_none());
    }

    /// 工作区读不到（被删/权限）时按「过期」处理：让上层走重建，重建会给出真实错误。
    #[test]
    fn 工作区不存在按过期处理() {
        let root = crate::test_support::tmp("drift-gone").join("nope");
        let s = scan_sources(&root, now_ms());
        assert!(s.stale);
    }

    // ───────── 行号自愈 ─────────
    //
    // 索引的行号是「建索引那一刻」的；会话内不重扫，所以跳转前用目标文件本身校正一次。
    // 这组测试钉的是「宁可落到附近，也不能跳到别的地方」。

    #[test]
    fn 行号漂移时按目标文件校正() {
        let dir = crate::test_support::tmp("drift-line");
        let f = dir.join("Foo.java");
        std::fs::write(
            &f,
            "package a;\n\n// 两行注释\n/* 块注释 */\npublic class Foo {\n  int x;\n}\n",
        )
        .unwrap();
        let path = f.to_string_lossy().to_string();
        // 索引说第 2 行（已过期），实际在第 5 行
        assert_eq!(fixed_line(&path, "a.Foo", 2), 5);
        // 索引本来是对的 → 原样返回
        assert_eq!(fixed_line(&path, "a.Foo", 5), 5);
        // 内部类用短名找
        std::fs::write(&f, "package a;\nclass Outer {\n  class Inner {}\n}\n").unwrap();
        assert_eq!(fixed_line(&path, "a.Outer$Inner", 1), 3);
    }

    #[test]
    fn 校正不把注释与同名前缀当成声明() {
        let dir = crate::test_support::tmp("drift-declare");
        let f = dir.join("Bar.java");
        std::fs::write(
            &f,
            "package a;\n// class Foo 只是注释\nimport x.FooBar;\nclass FooBar {}\nclass Foo {}\n",
        )
        .unwrap();
        let path = f.to_string_lossy().to_string();
        assert_eq!(fixed_line(&path, "a.Foo", 2), 5, "注释与前缀同名都不算");
        // 声明跨行（极少见）时找不到 → 原样返回，不能把目标弄丢
        std::fs::write(&f, "package a;\npublic class\n  Foo {}\n").unwrap();
        assert_eq!(fixed_line(&path, "a.Foo", 2), 2);
        // 文件不存在 → 原样
        assert_eq!(
            fixed_line(&dir.join("nope.java").to_string_lossy(), "a.Foo", 7),
            7
        );
    }

    /// 文件里没有那个类（被删/改名）时同样原样返回：目标文件仍然是对的，落点由用户判断。
    #[test]
    fn 找不到声明时保留索引行号() {
        let dir = crate::test_support::tmp("drift-miss");
        let f = dir.join("Z.java");
        std::fs::write(&f, "package a;\n\n\n").unwrap();
        assert_eq!(fixed_line(&f.to_string_lossy(), "a.Z", 2), 2);
    }

    #[test]
    fn 成员行号按声明形态校正() {
        let dir = crate::test_support::tmp("drift-member");
        let f = dir.join("Vo.java");
        std::fs::write(
            &f,
            "package a;\n\
             class Vo {\n\
             \x20 private String code;\n\
             \x20 void f() {\n\
             \x20   vo.getCode();\n\
             \x20   return buildVo(code);\n\
             \x20 }\n\
             \x20 public String getCode() {\n\
             \x20   return this.code;\n\
             \x20 }\n\
             }\n",
        )
        .unwrap();
        let path = f.to_string_lossy().to_string();
        // 索引说第 10 行（漂了）→ 找到真声明第 8 行
        assert_eq!(fixed_member_line(&path, "getCode", 10), 8);
        // 索引行本来就对 → 原样
        assert_eq!(fixed_member_line(&path, "getCode", 8), 8);
        // 字段：`private String code;` 是第 3 行
        assert_eq!(fixed_member_line(&path, "code", 9), 3);
        // 方法里没这个名字 → 原样
        assert_eq!(fixed_member_line(&path, "nope", 5), 5);
        // 文件不存在 → 原样
        assert_eq!(
            fixed_member_line(&dir.join("no.java").to_string_lossy(), "x", 4),
            4
        );
    }

    /// `vo.getCode()` / `return buildVo(code)` 里的同名出现不是声明，不能把行号拉过去。
    #[test]
    fn 调用不算成员声明() {
        assert!(!declares_member("    vo.getCode();", "getCode"));
        assert!(!declares_member("    return buildVo(x);", "buildVo"));
        assert!(
            !declares_member("    getCode();", "getCode"),
            "同类调用没有返回类型"
        );
        assert!(!declares_member("    new Vo();", "Vo"));
        assert!(declares_member("  public String getCode() {", "getCode"));
        assert!(declares_member("  private String code;", "code"));
        assert!(declares_member("  int[] codes = null;", "codes"));
    }
}
