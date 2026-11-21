//! Phase 1 声明索引（`types.idx`）的读取器。
//!
//! 文件由 `ecj-bridge/NcIndexer.java` 写出，格式刻意做成「一遍顺序读完」：
//!
//! ```text
//! magic "NCFIDX01"(8) | version i32 | typeCount i32 | pathCount i32
//! | srcCount i32 | sourceBytes i64 | jarTypes i64 | builtAtMs i64
//! pathCount × str                       ← 路径表（按下标顺序）
//! typeCount × 记录                       ← name 升序
//!   u8 kind | u8 fromJar | i32 pathIdx | i32 line | str name
//!   | i32 methodCount | methodCount × (str sig | i32 line)
//!   | i32 fieldCount  | fieldCount  × (str name:Type | i32 line)
//! ```
//!
//! `str` = `u16` 字节长 + UTF-8（Java 侧 `writeShort`/`writeUTF` 的手写版，不用
//! `writeUTF` 是因为它用 modified-UTF8 且有 64KB 限制的坑）。所有整数**大端**。
//!
//! 为什么不走 JSON：204380 个类型 / 176 万个方法签名，JSON 会到几百 MB 且要在
//! 启动路径上解析。这个格式读得进来就能直接二分查。
//!
//! 谁在用：`lang` 的 Phase 1 快通道（见 `docs/NCForge-智能代码-实施方案-2026-11-21.md` §4.2.1）。

use std::io::{self, Read};
use std::path::Path;

/// 与 `NcIndexer.MAGIC` 必须逐字节一致。改格式两边一起改。
const MAGIC: &[u8; 8] = b"NCFIDX01";
/// 2 = 头部带 `builtAtMs`；3 = 成员带声明行（v1/v2 读到即报版本不一致 → 强制重建）。
const VERSION: i32 = 3;
/// 头部定长：8 魔数 + 4 版本 + 4 类型数 + 4 路径数 + 4 源文件数 + 8 源字节 + 8 jar 类型 + 8 落盘时刻。
const HEADER_LEN: u64 = 48;

/// 一个方法或字段。**只用于跳转到声明行**，不参与补全。
///
/// `name` 是索引器给的原文：方法是 `getCode(nc.vo.Req)` 这种带参数的类型名，
/// 字段是 `code:String`。跳转时按「`(` 之前」/「`:` 之前」取简单名比对 ——
/// 重载不区分（跳到第一个声明就行），所以没必要在读取期就切好。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub name: String,
    /// 声明行（1 基）。**jar 侧恒 0**：字节码行号指向原始 `.java`，与反编译视图无关。
    pub line: i32,
}

/// 单个类型声明。`from_jar` 为真时 `path` 是 jar 路径、`line` 为 0。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decl {
    /// 全限定名，内部类用 `$` 连接（与 `ClassFileReader.getName()` 一致）。
    pub name: String,
    /// 1 class / 2 interface / 3 enum / 4 annotation。
    pub kind: u8,
    pub from_jar: bool,
    pub path: String,
    /// 声明所在行（1 基）；jar 侧为 0。
    pub line: i32,
    /// 方法，`name(SimpleParam,...)` + 声明行。
    pub methods: Vec<Member>,
    /// 字段，`name:SimpleType` + 声明行。
    pub fields: Vec<Member>,
}

impl Decl {
    pub fn is_interface(&self) -> bool {
        self.kind == 2
    }

    /// 方法声明行。`name` 传简单名（不带参数）。
    pub fn method_line(&self, name: &str) -> Option<i32> {
        self.methods
            .iter()
            .find(|m| sig_name(&m.name) == name)
            .map(|m| m.line)
            .filter(|l| *l > 0)
    }

    /// 字段声明行。`name` 传简单名（不带类型）。
    pub fn field_line(&self, name: &str) -> Option<i32> {
        self.fields
            .iter()
            .find(|f| sig_name(&f.name) == name)
            .map(|f| f.line)
            .filter(|l| *l > 0)
    }
}

/// `getCode(nc.vo.Req)` → `getCode`；`code:String` → `code`。
pub fn sig_name(sig: &str) -> &str {
    let end = sig.find(['(', ':']).unwrap_or(sig.len());
    &sig[..end]
}

/// 解析后的整份索引。按 `name` 升序，`find` 走二分。
#[derive(Debug, Default)]
pub struct DeclIndex {
    decls: Vec<Decl>,
    /// 简单名 → 下标。跳转时用户手里只有 `DeliveryVO` 这种简单名，
    /// 没有它就得多候选全表扫（20 万条）。
    /// 内部类额外登记一次短名：`a.b.Foo$Inner` 同时记 `Foo$Inner` 和 `Inner`。
    simple: std::collections::HashMap<String, Vec<u32>>,
}

/// 索引头部的规模信息，给日志和设置页看。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexStats {
    pub types: usize,
    pub paths: usize,
    pub source_files: usize,
    pub source_bytes: u64,
    pub jar_types: u64,
    /// 索引落盘时刻（Unix 毫秒，0 = 旧格式或未写）。
    /// 判「过期」唯一的锚点：工作区里有比它更新的源码就重建，见 `fast_decl::ensure`。
    pub built_at_ms: u64,
}

impl DeclIndex {
    /// 从磁盘读整份索引（含方法/字段签名）。78 MB / 24 万类型实测约 200ms（解析 + 分配）。
    ///
    /// **跳转用 `load_meta`**：成员签名占全文件 90% 且没人用，全量载入只是为了将来的
    /// 补全。两处都保留，是为了不让「以后要签名」变成重写读取器。
    pub fn load(path: &Path) -> io::Result<(Self, IndexStats)> {
        let buf = std::fs::read(path)?;
        Self::parse(&buf)
    }

    /// 只载名字、位置、来源，**跳过 jar 侧成员**。
    ///
    /// 跳转只要「标识符 → 文件:行」，但**源码侧成员必须留着** —— 成员级跳转
    /// （`vo.getCode()` → 声明行）全靠它。jar 侧成员跳过：它们体积占大头
    /// （145 万条）且行号恒 0，跳过去也用不上。
    pub fn load_meta(path: &Path) -> io::Result<(Self, IndexStats)> {
        let buf = std::fs::read(path)?;
        Self::parse_with(&buf, false)
    }

    /// 只读头部，不碰记录区。
    ///
    /// 复用判据要用：重建一次 21s，而「这份索引还新不新」只看 `builtAtMs`。
    /// 为了看一眼头部就把 20MB 整份读进来，是启动路径上白花的 IO。
    pub fn read_stats(path: &Path) -> io::Result<IndexStats> {
        let f = std::fs::File::open(path)?;
        let mut buf = Vec::with_capacity(HEADER_LEN as usize);
        f.take(HEADER_LEN).read_to_end(&mut buf)?;
        let mut r = Reader { buf: &buf, pos: 0 };
        Ok(read_header(&mut r)?.stats)
    }

    /// 解析内存镜像（含全部成员）。抽出来是为了单测不必碰磁盘。
    pub fn parse(buf: &[u8]) -> io::Result<(Self, IndexStats)> {
        Self::parse_with(buf, true)
    }

    /// `keep_jar_members = false` 时不分配 jar 侧成员的字符串（只把字节跳过去）；
    /// **源码侧成员照读**，成员级跳转要用。
    pub fn parse_with(buf: &[u8], keep_jar_members: bool) -> io::Result<(Self, IndexStats)> {
        let mut r = Reader { buf, pos: 0 };
        let head = read_header(&mut r)?;
        let type_count = head.types;
        let path_count = head.paths;

        let mut paths = Vec::with_capacity(path_count);
        for _ in 0..path_count {
            paths.push(r.str()?.to_string());
        }

        let mut decls = Vec::with_capacity(type_count);
        for _ in 0..type_count {
            let kind = r.u8()?;
            let from_jar = r.u8()? != 0;
            let path_idx = r.i32()?;
            let line = r.i32()?;
            let name = r.str()?.to_string();
            let path = match paths.get(path_idx.max(0) as usize) {
                Some(p) => p.clone(),
                None => {
                    return Err(bad(&format!(
                        "类型 {name} 的路径下标 {path_idx} 越界（路径表 {path_count} 条）"
                    )));
                }
            };
            // jar 侧成员只在全量加载时才读：它们的行号恒 0，跳转用不上。
            let keep = keep_jar_members || !from_jar;
            let method_count = r.i32()?.max(0) as usize;
            let mut methods = Vec::new();
            if keep {
                methods.reserve_exact(method_count);
                for _ in 0..method_count {
                    let name = r.str()?.to_string();
                    methods.push(Member {
                        name,
                        line: r.i32()?,
                    });
                }
            } else {
                for _ in 0..method_count {
                    r.skip_str()?;
                    r.i32()?; // 行号也要吃掉，否则游标错位
                }
            }
            let field_count = r.i32()?.max(0) as usize;
            let mut fields = Vec::new();
            if keep {
                fields.reserve_exact(field_count);
                for _ in 0..field_count {
                    let name = r.str()?.to_string();
                    fields.push(Member {
                        name,
                        line: r.i32()?,
                    });
                }
            } else {
                for _ in 0..field_count {
                    r.skip_str()?;
                    r.i32()?;
                }
            }
            decls.push(Decl {
                name,
                kind,
                from_jar,
                path,
                line,
                methods,
                fields,
            });
        }

        // 写的时候是排好序的；这里只断言不排序——排序会掩盖 producer 的 bug。
        debug_assert!(
            decls.windows(2).all(|w| w[0].name <= w[1].name),
            "types.idx 的记录不是按 name 升序，二分查询会漏"
        );
        let mut simple = build_simple(&decls);
        let stats = IndexStats {
            types: decls.len(),
            ..head.stats
        };
        simple.shrink_to_fit();
        Ok((Self { decls, simple }, stats))
    }

    pub fn len(&self) -> usize {
        self.decls.len()
    }

    pub fn is_empty(&self) -> bool {
        self.decls.is_empty()
    }

    /// 按全限定名精确查（内部类用 `$`）。多次命中时返回第一个（同名类以 jar 顺序为准）。
    pub fn find(&self, name: &str) -> Option<&Decl> {
        self.decls
            .binary_search_by(|d| d.name.as_str().cmp(name))
            .ok()
            .map(|i| &self.decls[i])
    }

    /// 按**简单名**枚举候选（`DeliveryVO`、内部类的 `Inner`）。
    ///
    /// 跳转链路的常态：用户光标下只有简单名，全限定名要靠 import 推。返回顺序是索引顺序
    /// （同名类按全限定名字典序），调用方按「同包 > 同模块 > 其余」重排。
    pub fn by_simple(&self, simple: &str) -> impl Iterator<Item = &Decl> {
        self.simple
            .get(simple)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
            .iter()
            .map(move |i| &self.decls[*i as usize])
    }

    /// 名字前缀枚举，给「跳到补全项」之类用（`a.b.Foo` 与 `a.b.Foo$Inner` 都会出来）。
    pub fn with_prefix<'a>(&'a self, prefix: &'a str) -> impl Iterator<Item = &'a Decl> + 'a {
        let start = self.decls.partition_point(|d| d.name.as_str() < prefix);
        self.decls[start..]
            .iter()
            .take_while(move |d| d.name.starts_with(prefix))
    }

    pub fn all(&self) -> &[Decl] {
        &self.decls
    }
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

/// 头部解析结果。`types` / `paths` 是后续记录区的规模，`stats` 是给上层看的。
struct Header {
    types: usize,
    paths: usize,
    stats: IndexStats,
}

/// 读并校验文件头。
///
/// `parse_with` 与 `read_stats` 共用这一份 —— 校验逻辑不能抄两遍，否则「只读头」那条
/// 迟早会漏掉魔数/版本检查，把垃圾文件当成可用索引。
fn read_header(r: &mut Reader) -> io::Result<Header> {
    if r.take(8)? != MAGIC {
        return Err(bad("魔数不匹配：不是 NcIndexer 产出的文件"));
    }
    let version = r.i32()?;
    if version != VERSION {
        return Err(bad(&format!(
            "格式版本 {version} 与读取器 {VERSION} 不一致（改格式要两边一起改）"
        )));
    }
    let type_count = r.i32()?;
    let path_count = r.i32()?;
    let src_count = r.i32()?;
    let source_bytes = r.i64()?;
    let jar_types = r.i64()?;
    let built_at = r.i64()?;
    if type_count < 0 || path_count < 0 {
        return Err(bad("头部计数为负：文件被截断或不是本格式"));
    }
    Ok(Header {
        types: type_count as usize,
        paths: path_count as usize,
        stats: IndexStats {
            types: type_count as usize,
            paths: path_count as usize,
            source_files: src_count.max(0) as usize,
            source_bytes: source_bytes.max(0) as u64,
            jar_types: jar_types.max(0) as u64,
            // 负数（旧格式/写坏）按 0 处理：0 表示「不知道」，上层据此判过期并重建。
            built_at_ms: built_at.max(0) as u64,
        },
    })
}

/// 简单名 → 下标。内部类登记两次：`a.b.Foo$Inner` 既是 `Foo$Inner` 也是 `Inner`。
fn build_simple(decls: &[Decl]) -> std::collections::HashMap<String, Vec<u32>> {
    let mut m: std::collections::HashMap<String, Vec<u32>> =
        std::collections::HashMap::with_capacity(decls.len());
    for (i, d) in decls.iter().enumerate() {
        let after_dot = match d.name.rfind('.') {
            Some(p) => &d.name[p + 1..],
            None => d.name.as_str(),
        };
        m.entry(after_dot.to_string()).or_default().push(i as u32);
        if let Some(p) = after_dot.rfind('$') {
            let leaf = &after_dot[p + 1..];
            if !leaf.is_empty() {
                m.entry(leaf.to_string()).or_default().push(i as u32);
            }
        }
    }
    m
}

/// 只给单测用：直接从声明列表造索引，省掉手写字节。
///
/// 🔴 必须先排序：`find` 走 `binary_search_by`，乱序数组上会**静默查不到**（返回 None
/// 而不是报错）。真实数据由 Java 侧 `Collections.sort` 保证，这里模拟同样的前置条件。
#[cfg(test)]
pub(crate) fn from_decls(mut decls: Vec<Decl>) -> DeclIndex {
    decls.sort_by(|a, b| a.name.cmp(&b.name));
    let simple = build_simple(&decls);
    DeclIndex { decls, simple }
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> io::Result<&'a [u8]> {
        if self.pos + n > self.buf.len() {
            return Err(bad("索引文件意外结束（可能写盘中断）"));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn u8(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn i32(&mut self) -> io::Result<i32> {
        let b = self.take(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn i64(&mut self) -> io::Result<i64> {
        let b = self.take(8)?;
        Ok(i64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    fn str(&mut self) -> io::Result<&'a str> {
        let n = {
            let b = self.take(2)?;
            u16::from_be_bytes([b[0], b[1]]) as usize
        };
        let bytes = self.take(n)?;
        std::str::from_utf8(bytes).map_err(|_| bad("字符串不是合法 UTF-8"))
    }

    /// 跳过一条字符串，不做 UTF-8 校验也不分配。
    ///
    /// 轻量加载要跳 176 万条签名；`str(...)` 的返回值会被丢掉，但校验和切片构造
    /// 仍要逐条走一遍。这里只推进游标。
    fn skip_str(&mut self) -> io::Result<()> {
        let n = {
            let b = self.take(2)?;
            u16::from_be_bytes([b[0], b[1]]) as usize
        };
        self.take(n)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小合法索引：两个类型、两条路径。手写字节是为了把格式钉在测试里 ——
    /// 改 `NcIndexer.java` 的写法则这里必须跟着改，不会「两边一起错」。
    fn sample() -> Vec<u8> {
        fn s(out: &mut Vec<u8>, v: &str) {
            out.extend_from_slice(&(v.len() as u16).to_be_bytes());
            out.extend_from_slice(v.as_bytes());
        }
        let mut v = Vec::new();
        v.extend_from_slice(MAGIC);
        v.extend_from_slice(&VERSION.to_be_bytes());
        v.extend_from_slice(&2i32.to_be_bytes()); // typeCount
        v.extend_from_slice(&2i32.to_be_bytes()); // pathCount
        v.extend_from_slice(&1i32.to_be_bytes()); // srcCount
        v.extend_from_slice(&123i64.to_be_bytes()); // sourceBytes
        v.extend_from_slice(&7i64.to_be_bytes()); // jarTypes
        v.extend_from_slice(&1_700_000_000_000i64.to_be_bytes()); // builtAtMs
                                                                  // 路径表
        s(&mut v, "C:/ws/a/src/private/a/b/Foo.java");
        s(&mut v, "D:/ncc/lib/x.jar");
        // 记录 1：源码里的类，1 方法 1 字段
        v.push(1);
        v.push(0);
        v.extend_from_slice(&0i32.to_be_bytes());
        v.extend_from_slice(&10i32.to_be_bytes());
        s(&mut v, "a.b.Foo");
        v.extend_from_slice(&1i32.to_be_bytes());
        s(&mut v, "bar(int)");
        v.extend_from_slice(&42i32.to_be_bytes()); // 方法声明行
        v.extend_from_slice(&1i32.to_be_bytes());
        s(&mut v, "x:int");
        v.extend_from_slice(&7i32.to_be_bytes()); // 字段声明行
                                                  // 记录 2：jar 里的接口，带 1 个方法（用来验证「轻量加载跳 jar 成员」）
        v.push(2);
        v.push(1);
        v.extend_from_slice(&1i32.to_be_bytes());
        v.extend_from_slice(&0i32.to_be_bytes());
        s(&mut v, "a.b.Zeta");
        v.extend_from_slice(&1i32.to_be_bytes());
        s(&mut v, "run()");
        v.extend_from_slice(&0i32.to_be_bytes());
        v.extend_from_slice(&0i32.to_be_bytes());
        v
    }

    #[test]
    fn 解析最小索引() {
        let (idx, st) = DeclIndex::parse(&sample()).expect("应解析成功");
        assert_eq!(st.types, 2);
        assert_eq!(st.paths, 2);
        assert_eq!(st.source_files, 1);
        assert_eq!(st.source_bytes, 123);
        assert_eq!(st.jar_types, 7);
        assert_eq!(st.built_at_ms, 1_700_000_000_000, "落盘时刻要读得回");

        let foo = idx.find("a.b.Foo").expect("应命中 a.b.Foo");
        assert_eq!(foo.kind, 1);
        assert!(!foo.from_jar);
        assert_eq!(foo.line, 10);
        assert_eq!(foo.path, "C:/ws/a/src/private/a/b/Foo.java");
        assert_eq!(
            foo.methods,
            vec![Member {
                name: "bar(int)".to_string(),
                line: 42
            }]
        );
        assert_eq!(
            foo.fields,
            vec![Member {
                name: "x:int".to_string(),
                line: 7
            }]
        );
        // 成员级跳转的入口：按简单名取声明行
        assert_eq!(foo.method_line("bar"), Some(42));
        assert_eq!(foo.field_line("x"), Some(7));
        assert_eq!(foo.method_line("nope"), None);

        let zeta = idx.find("a.b.Zeta").expect("应命中 a.b.Zeta");
        assert!(zeta.is_interface());
        assert!(zeta.from_jar);
        assert_eq!(zeta.path, "D:/ncc/lib/x.jar");
        assert!(idx.find("a.b.Nope").is_none());
    }

    /// 轻量加载（跳转用）只跳 **jar 侧**成员：源码成员是成员级跳转的数据源，必须留着。
    ///
    /// 钉这条是因为两个方向都错过：全跳 → `vo.getCode()` 永远跳不到；
    /// 全留 → 145 万条 jar 签名白白常驻几十 MB。
    #[test]
    fn 轻量加载只跳jar成员_源码成员保留() {
        let (full, st_full) = DeclIndex::parse(&sample()).expect("全量应解析成功");
        let (meta, st_meta) = DeclIndex::parse_with(&sample(), false).expect("轻量应解析成功");
        assert_eq!(st_full, st_meta, "规模统计不能因为跳成员而变化");
        assert_eq!(full.all().len(), meta.all().len());
        for (a, b) in full.all().iter().zip(meta.all()) {
            assert_eq!(a.name, b.name);
            assert_eq!((a.kind, a.from_jar, a.line), (b.kind, b.from_jar, b.line));
            assert_eq!(a.path, b.path, "路径表照读，不能因为跳成员错位");
        }
        // 源码侧成员：两边一模一样
        assert_eq!(
            meta.find("a.b.Foo").unwrap().methods,
            full.find("a.b.Foo").unwrap().methods
        );
        // jar 侧成员：全量有、轻量空（关键：游标仍然走过，后面的记录不会错位）
        assert!(!full.find("a.b.Zeta").unwrap().methods.is_empty());
        assert_eq!(meta.find("a.b.Zeta").unwrap().methods, Vec::new());
        assert_eq!(meta.find("a.b.Zeta").unwrap().path, "D:/ncc/lib/x.jar");
        // 简单名索引照样建好（跳转全靠它）
        assert_eq!(meta.by_simple("Zeta").count(), 1);
    }

    /// 复用判据只读头部：不解析记录区也必须拿到规模和落盘时刻。
    ///
    /// 钉这条是因为「读头部」与「读全文」是两条代码路径 —— 只测后者的话，
    /// `read_stats` 一旦算错偏移（比如少读一个字段），会表现为「永远判定过期、每次启动重建 21s」。
    #[test]
    fn 只读头部就能拿到规模与落盘时刻() {
        let dir = crate::test_support::tmp("decl-index-header");
        let p = dir.join("types.idx");
        std::fs::write(&p, sample()).unwrap();
        let st = DeclIndex::read_stats(&p).expect("只读头部应成功");
        assert_eq!(st.types, 2);
        assert_eq!(st.paths, 2);
        assert_eq!(st.source_files, 1);
        assert_eq!(st.source_bytes, 123);
        assert_eq!(st.jar_types, 7);
        assert_eq!(st.built_at_ms, 1_700_000_000_000);

        // 头部被截断的文件要报错，不能返回「0 个类型」被当成空索引用
        std::fs::write(&p, &sample()[..20]).unwrap();
        assert!(DeclIndex::read_stats(&p).is_err());
    }

    #[test]
    fn 魔数不对要报错而不是猜() {
        let mut bad_buf = sample();
        bad_buf[0] = b'X';
        let err = DeclIndex::parse(&bad_buf).expect_err("魔数坏了必须失败");
        assert!(err.to_string().contains("魔数"), "{}", err);
    }

    #[test]
    fn 版本不一致要报错() {
        let mut v = sample();
        // 版本字段紧跟在 8 字节魔数之后
        v[8..12].copy_from_slice(&99i32.to_be_bytes());
        let err = DeclIndex::parse(&v).expect_err("版本不同必须失败");
        assert!(err.to_string().contains("版本"), "{}", err);
    }

    #[test]
    fn 截断的文件要报错而不是返回半个索引() {
        let v = sample();
        let err = DeclIndex::parse(&v[..v.len() - 3]).expect_err("截断必须失败");
        assert!(err.to_string().contains("意外结束"), "{}", err);
    }

    #[test]
    fn 前缀枚举覆盖内部类且不串到邻名() {
        fn s(out: &mut Vec<u8>, x: &str) {
            out.extend_from_slice(&(x.len() as u16).to_be_bytes());
            out.extend_from_slice(x.as_bytes());
        }
        // 复用 sample 的布局，换三个名字：a.b.Foo / a.b.Foo$Inner / a.bZoo
        let mut v = Vec::new();
        v.extend_from_slice(MAGIC);
        v.extend_from_slice(&VERSION.to_be_bytes());
        v.extend_from_slice(&3i32.to_be_bytes());
        v.extend_from_slice(&1i32.to_be_bytes());
        v.extend_from_slice(&0i32.to_be_bytes());
        v.extend_from_slice(&0i64.to_be_bytes());
        v.extend_from_slice(&0i64.to_be_bytes());
        v.extend_from_slice(&0i64.to_be_bytes()); // builtAtMs
        s(&mut v, "p/Foo.java");
        for name in ["a.b.Foo", "a.b.Foo$Inner", "a.bZoo"] {
            v.push(1);
            v.push(0);
            v.extend_from_slice(&0i32.to_be_bytes());
            v.extend_from_slice(&1i32.to_be_bytes());
            s(&mut v, name);
            v.extend_from_slice(&0i32.to_be_bytes());
            v.extend_from_slice(&0i32.to_be_bytes());
        }
        let (idx, _) = DeclIndex::parse(&v).expect("应解析成功");
        let hit: Vec<&str> = idx
            .with_prefix("a.b.Foo")
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(
            hit,
            vec!["a.b.Foo", "a.b.Foo$Inner"],
            "不能把 a.bZoo 带进来"
        );
        assert_eq!(idx.with_prefix("a.b.Z").count(), 0);

        // 简单名索引：内部类两种写法都要查到（源码里写 `Inner`，全限定名里是 `Foo$Inner`）
        let by_leaf: Vec<&str> = idx.by_simple("Inner").map(|d| d.name.as_str()).collect();
        assert_eq!(by_leaf, vec!["a.b.Foo$Inner"]);
        let by_qual: Vec<&str> = idx
            .by_simple("Foo$Inner")
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(by_qual, vec!["a.b.Foo$Inner"]);
        assert_eq!(idx.by_simple("Foo").count(), 1);
        assert_eq!(idx.by_simple("Nope").count(), 0);
    }
}
