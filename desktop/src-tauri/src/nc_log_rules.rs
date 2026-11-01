//! 日志归因规则表 —— 纯函数，输入一条记录的文本，输出「这是什么问题 + 该看哪里」。
//!
//! ## 为什么是常量表而不是 if 分支
//!
//! 加一条规则不该动逻辑代码。表里每行独立，顺序即优先级（先命中先返回），
//! 想加规则只加一行；想调顺序只挪一行。逻辑（`judge`）只负责「拿文本去查表 + 抽参数」。
//!
//! ## 规则从哪来
//!
//! 全部有实测或社区证据，不是猜的（详见 `docs/补丁应用回滚与日志归因-方案设计-20261101.md` §3.4）：
//! 本机日志里就有 `DuplicateException: deviceregister` 与 `ORA-00942` 的真实样本；
//! `newar` vs `pm` 同名类 18 处、游标第 298 次耗尽这些坑也都在别处出现过。
//!
//! ## 一条铁律：不看 `debuglevel`
//!
//! NC 的 `$$debuglevel=` 是 logger 的**门限**，不是这一行的严重性 ——
//! 实测 `$$debuglevel=ERROR` 后面跟的是 `###udapte table success`。所以归因只认内容。

use serde::Serialize;

/// 命中后界面能给的动作。序列化成 `{"kind":"table","table":"…"}`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Jump {
    /// 去数据库里查这张表（接现有的表结构悬停/数据页）。
    Table { table: String },
    /// 跳到源码里的这个类（`remotecall` 或异常类名）。
    Source { class: String },
    /// 跳到这个 `.upm`（组件重复注册的现场）。
    Upm { path: String },
}

/// 归因结论。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// 规则 id，前端按它选图标/颜色（也是「同类问题合并计数」的键）。
    pub rule: &'static str,
    /// `error` / `warn` / `slow`。
    pub severity: &'static str,
    /// 已代入参数的一句话结论（如「表或视图不存在：bi_conf_cache」）。
    pub title: String,
    /// 为什么会这样（大白话，不是复述异常）。
    pub cause: &'static str,
    /// 下一步该干什么。
    pub action: &'static str,
    pub jump: Option<Jump>,
}

struct Rule {
    id: &'static str,
    /// **必须小写**：匹配前 haystack 会整体 ASCII 小写化（中文不受影响）。
    needle: &'static str,
    severity: &'static str,
    title: &'static str,
    cause: &'static str,
    action: &'static str,
}

/// 规则表。顺序即优先级 —— 越具体的越靠前。
const RULES: &[Rule] = &[
    Rule {
        id: "ora-00942",
        needle: "ora-00942",
        severity: "error",
        title: "表或视图不存在",
        cause: "八成不是代码写错，而是元数据已发布但建库脚本没跑 —— 表根本没建出来。",
        action: "在数据库里核对这张表是否存在；不存在就回元数据检查发布结果，别先去改代码。",
    },
    Rule {
        id: "ora-00001",
        needle: "ora-00001",
        severity: "error",
        title: "唯一约束冲突",
        cause: "往唯一键上写了重复值：常见于复制单据、并发提交、主键生成器重号。",
        action: "按约束名找到表和索引，核对冲突的那几行；并发场景查主键生成器配置。",
    },
    Rule {
        id: "ora-01000",
        needle: "ora-01000",
        severity: "error",
        title: "游标超限（maximum open cursors exceeded）",
        cause: "游标没关闭，越攒越多。以前有条路径在第 298 次调用时才炸，不是每次都炸。",
        action: "找这段代码里的 ResultSet/Statement 是否每条路径都关闭；先调大 open_cursors 只能续命。",
    },
    Rule {
        id: "ora-tablespace",
        needle: "ora-0165",
        severity: "error",
        title: "表空间不足",
        cause: "表空间或临时表空间写满了（01652 临时段、01653 表段、01654 索引段）。",
        action: "让 DBA 扩表空间或加数据文件；顺带看一眼是不是有失控的大查询在刷临时表。",
    },
    Rule {
        id: "ora-01001",
        needle: "ora-01001",
        severity: "error",
        title: "游标无效（invalid cursor）",
        cause: "游标被提前关闭或复用。嵌套游标场景常见，和 REF CURSOR 的关闭顺序有关。",
        action: "核对游标关闭顺序：父游标关掉时子游标还在用，就会报这个。",
    },
    Rule {
        id: "ora-01008",
        needle: "ora-01008",
        severity: "error",
        title: "并非所有变量都已绑定",
        cause: "SQL 里的占位符个数和绑定值的个数不一致。",
        action: "核对 SQL 文本与参数列表；动态拼 SQL 时最容易被条件分支漏掉一个。",
    },
    Rule {
        id: "pls-00707",
        needle: "pls-00707",
        severity: "error",
        title: "PL/SQL 表达式类型不支持（REF CURSOR）",
        cause: "库侧返回 REF CURSOR，当前执行引擎不支持这种返回。",
        action: "走 Java 桥兜底（能力路由已能自动转，见「执行引擎」）；报错说明兜底也没成，看第二条原因。",
    },
    Rule {
        id: "class-not-found",
        needle: "classnotfoundexception",
        severity: "error",
        title: "找不到类",
        cause: "类路径里缺这个类所在的 jar：补丁没装全、模块依赖没进 classpath，或 jar 版本不对。",
        action: "用「工程关联」的依赖闭包查这个类该属于哪个模块，再核对 HOME 下有没有对应的 class/jar。",
    },
    Rule {
        id: "no-such-method",
        needle: "nosuchmethoderror",
        severity: "error",
        title: "方法不存在（编译期与运行期两个版本）",
        cause: "编译用的类版本和运行时的类版本不一致 —— 同名类在类路径里有两份，先加载的那份赢了。",
        action: "查这个类的所有来源（newar 与 pm 有 18 处同名不同内容的前科），按类路径顺序确认谁先生效。",
    },
    Rule {
        id: "no-such-field",
        needle: "nosuchfielderror",
        severity: "error",
        title: "字段不存在（版本不一致）",
        cause: "同「方法不存在」：两份同名类，编译期那份有字段，运行期那份没有。",
        action: "同上，先找同名类的多个来源。",
    },
    Rule {
        id: "duplicate-register",
        needle: "duplicateexception",
        severity: "error",
        title: "组件重复注册",
        cause: "同一个组件名被注册了两遍：`.upm` 被重复部署，或补丁里的 upm 覆盖时留下了旧副本。",
        action: "打开报错里的 `.upm` 核对组件名；对比模块 META-INF 下有没有备份/残留的旧 upm。",
    },
    Rule {
        id: "oom-heap",
        needle: "java heap space",
        severity: "error",
        title: "堆内存不足",
        cause: "一次查询或导入把堆吃满了（大结果集一次全取、报表全量加载最常见）。",
        action: "先在「NC 服务」里看堆上限；业务侧确认是不是把整表读进了内存，改成分页。",
    },
    Rule {
        id: "oom-metaspace",
        needle: "metaspace",
        severity: "warn",
        title: "元空间不足（类加载泄漏）",
        cause: "反复热部署/重启补丁，旧类加载器回收不掉，元空间一路涨。",
        action: "看这套环境打补丁重启过多少次；根治要重启服务并查是不是有不释放的类加载器。",
    },
    Rule {
        id: "oom-permgen",
        needle: "permgen",
        severity: "warn",
        title: "永久代不足（类加载泄漏）",
        cause: "Java 7 及以下没有 Metaspace，类元数据放在永久代，反复部署会耗尽。",
        action: "同上，先重启；长期要控制热部署次数。",
    },
    Rule {
        id: "sqlserver-in-oracle",
        needle: "charindex",
        severity: "warn",
        title: "SQL 方言混用（SQL Server 函数跑在 Oracle 上）",
        cause: "数据源配错了，或是从 SQL Server 版本迁移过来的 SQL 没改。`charindex` 是 SQL Server 的函数。",
        action: "核对这条连接指向的库；Oracle 上应使用 `instr`。",
    },
    Rule {
        id: "metadata-file-missing",
        needle: "找不到元数据文件",
        severity: "warn",
        title: "找不到元数据文件",
        cause: "模块的元数据（bmf/upm）没打进补丁，或部署到了错误的模块目录。",
        action: "核对补丁里该模块的 META-INF 内容与 HOME 下实际落位是否一致。",
    },
];

/// 兜底规则：没有命中具体规则，但内容像异常。放最后，靠 `judge` 单独处理。
const FALLBACK_NEEDLE: &str = "exception";

/// 归因一条记录。`stack` 只取前几行参与匹配（异常类型常在第一行）。
pub fn judge(msg: &str, stack: &[String]) -> Option<Verdict> {
    if msg.trim().is_empty() && stack.is_empty() {
        return None;
    }
    let mut hay = String::with_capacity(msg.len() + 256);
    hay.push_str(msg);
    for line in stack.iter().take(6) {
        hay.push('\n');
        hay.push_str(line);
    }
    // 只小写 ASCII：中文规则（「找不到元数据文件」）不受影响，且不改变字节长度
    let low = hay.to_ascii_lowercase();

    for rule in RULES {
        if low.contains(rule.needle) {
            return Some(Verdict {
                rule: rule.id,
                severity: rule.severity,
                title: title_for(rule, &hay),
                cause: rule.cause,
                action: rule.action,
                jump: jump_for(rule.id, &hay),
            });
        }
    }

    // 只认 exception，不认 "error"：NC 的 info 行里也常出现 `error at <路径>`，
    // 拿 "error" 当兜底会把大量正常日志标成「未归因异常」，噪声比命中多。
    if low.contains(FALLBACK_NEEDLE) {
        return Some(Verdict {
            rule: "unattributed",
            severity: "warn",
            title: "未归因异常".to_string(),
            cause: "内容里有异常/错误，但没命中已知规则。",
            action:
                "先看堆栈最内层那一帧；常逛的入口是「追踪这次请求」看同一 callid 前后发生了什么。",
            jump: None,
        });
    }
    None
}

/// 慢 SQL 的结论（不是规则命中，是按耗时阈值合成）。
pub fn slow_sql(cost_ms: u64, rows: Option<u64>) -> Verdict {
    let title = match rows {
        Some(n) => format!("慢 SQL：{cost_ms}ms，影响 {n} 行"),
        None => format!("慢 SQL：{cost_ms}ms"),
    };
    Verdict {
        rule: "slow-sql",
        severity: "slow",
        title,
        cause: "NC 自己在 warningsql 里登记了耗时与行数 —— 不用算，直接排序看最慢的。",
        action: "把 SQL 复制到数据库页 EXPLAIN 一下；影响行数大的先看索引和分页。",
        jump: None,
    }
}

fn title_for(rule: &Rule, hay: &str) -> String {
    let suffix = match rule.id {
        "ora-00942" => extract_table(hay),
        "ora-00001" => constraint_name(hay),
        "ora-tablespace" => extract_after(hay, "tablespace "),
        "class-not-found" => extract_class(hay, "classnotfoundexception"),
        "no-such-method" | "no-such-field" => extract_member_class(hay),
        "duplicate-register" => extract_component(hay),
        _ => None,
    };
    match suffix {
        Some(s) if !s.is_empty() => format!("{}：{}", rule.title, s),
        _ => rule.title.to_string(),
    }
}

fn jump_for(id: &str, hay: &str) -> Option<Jump> {
    match id {
        "ora-00942" | "ora-00001" => extract_table(hay).map(|table| Jump::Table { table }),
        "class-not-found" => {
            extract_class(hay, "classnotfoundexception").map(|class| Jump::Source { class })
        }
        "no-such-method" | "no-such-field" => {
            extract_member_class(hay).map(|class| Jump::Source { class })
        }
        "duplicate-register" => extract_upm(hay).map(|path| Jump::Upm { path }),
        "no-such-method-remote" => None,
        _ => None,
    }
}

// ---------------------------------------------------------------- 抽取

/// 从 SQL 里取第一张表：`< SELECT * FROM bi_conf_cache>throws …` → `bi_conf_cache`。
///
/// 只做「` from ` 之后第一个标识符」这一条规则 —— 这是个提示，不是 SQL 解析器，
/// 遇到子查询会先拿到子查询的表，仍然比没有强。
fn extract_table(text: &str) -> Option<String> {
    let low = text.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(offset) = low[from..].find(" from ") {
        let start = from + offset + " from ".len();
        let name: String = text[start..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '.' || *c == '"')
            .collect();
        let name = name.trim_matches('"').trim().to_string();
        if !name.is_empty() && !name.eq_ignore_ascii_case("dual") {
            return Some(name);
        }
        from = start;
    }
    None
}

/// `ORA-00001: unique constraint (AIER633.PK_SM_USER) violated` → `AIER633.PK_SM_USER`。
fn constraint_name(text: &str) -> Option<String> {
    let at = text.to_ascii_lowercase().find("unique constraint")?;
    let rest = &text[at..];
    let open = rest.find('(')?;
    let close = rest[open..].find(')')? + open;
    let name = rest[open + 1..close].trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// `java.lang.ClassNotFoundException: nc.bs.foo.Bar` → `nc.bs.foo.Bar`。
fn extract_class(text: &str, keyword: &str) -> Option<String> {
    let at = text.to_ascii_lowercase().find(keyword)? + keyword.len();
    let rest = text[at..].trim_start_matches([':', ' ', '\t']);
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '$'))
        .collect();
    (!name.trim_matches('.').is_empty()).then(|| name.trim_end_matches('.').to_string())
}

/// `NoSuchMethodError: nc.bs.foo.Bar.baz()V` → 类名 `nc.bs.foo.Bar`。
fn extract_member_class(text: &str) -> Option<String> {
    let keyword = if text.to_ascii_lowercase().contains("nosuchfielderror") {
        "nosuchfielderror"
    } else {
        "nosuchmethoderror"
    };
    let member = extract_class_member(text, keyword)?;
    // 去掉最后一个点之后的方法名/字段名
    match member.rfind('.') {
        Some(i) if i > 0 => Some(member[..i].to_string()),
        _ => Some(member),
    }
}

/// 与 [`extract_class`] 相同，但保留到 `(` 之前（含方法名）。内部用，允许 `::`。
fn extract_class_member(text: &str, keyword: &str) -> Option<String> {
    let at = text.to_ascii_lowercase().find(keyword)? + keyword.len();
    let rest = text[at..].trim_start_matches([':', ' ', '\t']);
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '$' | ':'))
        .collect();
    (!name.is_empty()).then_some(name)
}

/// `component=deviceregister` → `deviceregister`。
fn extract_component(text: &str) -> Option<String> {
    extract_after(text, "component=").map(|s| s.trim_end_matches([',', ';']).to_string())
}

/// 取 `key` 之后的一段「像名字的东西」。
fn extract_after(text: &str, key: &str) -> Option<String> {
    let at = text.to_ascii_lowercase().find(&key.to_ascii_lowercase())? + key.len();
    let name: String = text[at..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '$'))
        .collect();
    (!name.is_empty()).then_some(name)
}

/// 从一段文本里取 `.upm` 的完整路径（反斜杠/正斜杠原样保留）。
fn extract_upm(text: &str) -> Option<String> {
    let at = text.to_ascii_lowercase().find(".upm")?;
    let end = at + 4;
    let bytes = text.as_bytes();
    let mut start = end;
    // 只在 ASCII 分隔符处断开；多字节字符的续字节 ≥0x80，不会误判
    while start > 0 {
        let c = bytes[start - 1];
        if matches!(c, b' ' | b'\n' | b'\r' | b'\t' | b'<' | b'>' | b',' | b';') {
            break;
        }
        start -= 1;
    }
    (start < end).then(|| text[start..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict(msg: &str) -> Verdict {
        judge(msg, &[]).expect("应当命中规则")
    }

    #[test]
    fn ora00942指向未建表而不是代码错() {
        // 本机真实样本（GBK 解码后）
        let v = verdict("< SELECT * FROM bi_conf_cache>throws ORA-00942: 表或视图不存在");
        assert_eq!(v.rule, "ora-00942");
        assert_eq!(v.severity, "error");
        assert!(
            v.title.contains("bi_conf_cache"),
            "标题要带表名: {}",
            v.title
        );
        assert!(v.cause.contains("元数据"), "结论必须点明「不是代码错」");
        assert_eq!(
            v.jump,
            Some(Jump::Table {
                table: "bi_conf_cache".to_string()
            })
        );
    }

    #[test]
    fn ora00001带约束名() {
        let v = verdict("ORA-00001: unique constraint (AIER633.PK_SM_USER) violated");
        assert_eq!(v.rule, "ora-00001");
        assert!(v.title.contains("PK_SM_USER"), "{}", v.title);
    }

    #[test]
    fn 表空间三兄弟都命中同一条规则() {
        for code in ["ORA-01652", "ORA-01653", "ORA-01654"] {
            let v = verdict(&format!(
                "{code}: unable to extend segment by 128 in tablespace NC_DATA"
            ));
            assert_eq!(v.rule, "ora-tablespace", "{code}");
            assert!(v.title.contains("NC_DATA"), "{}: {}", code, v.title);
        }
    }

    #[test]
    fn 类找不到能跳源码() {
        let v = verdict("java.lang.ClassNotFoundException: nc.bs.ic.eye.EyeService");
        assert_eq!(v.rule, "class-not-found");
        assert_eq!(
            v.jump,
            Some(Jump::Source {
                class: "nc.bs.ic.eye.EyeService".to_string()
            })
        );
    }

    #[test]
    fn 方法不存在取到类而不是方法() {
        let v = verdict("java.lang.NoSuchMethodError: nc.bs.ic.eye.EyeService.run(J)V");
        assert_eq!(v.rule, "no-such-method");
        assert_eq!(
            v.jump,
            Some(Jump::Source {
                class: "nc.bs.ic.eye.EyeService".to_string()
            }),
            "跳源码要落到类上"
        );
    }

    #[test]
    fn 组件重复注册取到upm路径() {
        // 本机 nc-log.log 第 1 条的真实内容
        let msg = "info: module=mmbcm-scm component=deviceregister, error at \
                   D:\\ncc\\1909home\\modules\\mmbcm-scm\\META-INF\\accessright.upm \
                   <module/public/component>, catch root <module/public/com";
        let stack = vec![
            "nc.bs.framework.exception.DuplicateException: Detail Message: deviceregister"
                .to_string(),
        ];
        let v = judge(msg, &stack).unwrap();
        assert_eq!(v.rule, "duplicate-register");
        assert!(v.title.contains("deviceregister"), "{}", v.title);
        assert_eq!(
            v.jump,
            Some(Jump::Upm {
                path: "D:\\ncc\\1909home\\modules\\mmbcm-scm\\META-INF\\accessright.upm"
                    .to_string()
            })
        );
    }

    #[test]
    fn 堆里的oom与元空间的oom分得开() {
        let heap = verdict("java.lang.OutOfMemoryError: Java heap space");
        assert_eq!(heap.rule, "oom-heap");
        let meta = verdict("java.lang.OutOfMemoryError: Metaspace");
        assert_eq!(meta.rule, "oom-metaspace");
        assert_eq!(meta.severity, "warn", "元空间泄漏是隐患不是当场炸");
    }

    #[test]
    fn 规则优先于兜底() {
        // 同时含 exception 与具体 ORA，必须走具体规则
        let v = verdict("java.sql.SQLException: ORA-01000: maximum open cursors exceeded");
        assert_eq!(v.rule, "ora-01000");
        assert_eq!(v.jump, None);
    }

    #[test]
    fn 中文规则能命中() {
        let v = verdict("加载模块元数据失败：找不到元数据文件 mmbcm-scm/META-INF/bmf");
        assert_eq!(v.rule, "metadata-file-missing");
    }

    #[test]
    fn 普通信息不产生结论() {
        assert!(judge("###udapte table success", &[]).is_none());
        assert!(judge("", &[]).is_none());
    }

    #[test]
    fn 兜底规则认异常() {
        let v = judge("java.lang.IllegalStateException: 状态不对", &[]).unwrap();
        assert_eq!(v.rule, "unattributed");
        assert_eq!(v.severity, "warn");
    }

    #[test]
    fn 慢sql结论带耗时与行数() {
        let v = slow_sql(1274, Some(44618));
        assert_eq!(v.severity, "slow");
        assert!(v.title.contains("1274ms"));
        assert!(v.title.contains("44618"));
    }

    #[test]
    fn 抽取函数不越界() {
        assert_eq!(extract_table("select 1 from dual"), None);
        assert_eq!(extract_table("select A from ("), None);
        assert_eq!(extract_upm("no upm here"), None);
        assert_eq!(extract_class("nothing", "classnotfoundexception"), None);
        // 中文紧邻 .upm 也不能切坏字符边界
        assert_eq!(
            extract_upm("错误在 D:\\a\\b.upm 这就"),
            Some("D:\\a\\b.upm".to_string())
        );
    }
}
