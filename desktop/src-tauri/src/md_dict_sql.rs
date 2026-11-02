//! 数据字典的取数 SQL（只读）。
//!
//! 每条 SQL 的形态都不是照着文档写的，是在真库（`aier260824`，Oracle 19.3 / **ZHS16GBK**）
//! 上跑过、踩过才定下来的。改之前先看这五条：
//!
//! 1. 🔴 **`industry` 必须放行 NULL**。NC 自己查元数据写的是
//!    `industry in ('0','48')`，照抄会丢掉 **26 张表，其中 25 张是
//!    `isextendtable='Y'` 的二开扩展表**（本库共 87 张扩展表，一下少 29%）。
//!    NC 那样写是因为它要渲染某个行业的产品界面，我们要的是"这张表叫什么"，
//!    二开表恰恰最需要。所以条件是 `industry in ('0','48') or industry is null`。
//! 2. 🔴 **`md_column` 没有 `industry` 列**（实测 ORA-00904），只有 `versiontype`。
//!    别照着 `md_table` 的写法套。
//! 3. 🔴 **`md_ormap` 是 1:N**：一个列可能被多个属性映射（`bd_billtype` 的 41 列
//!    在 join 后是 96 行，29 列有多个属性）。所以取数只负责把"列 × 属性"配对吐出来，
//!    **折叠在装配层做**（`md_dict::build`）——SQL 里 group 会丢掉属性名，
//!    不折叠又会凭空多出列且不报错。
//! 4. 🔴 **软删除 `dr` 是 NULL 而不是 0**（md_table 5866 行 NULL / 10 行 0），
//!    所以只能写 `nvl(dr,0) = 0`，写 `dr = 0` 会把整库过滤成空。
//! 5. **不用 `LIKE` 过滤表名**：`_` 和 `%` 是通配符，开发者搜 `ic_` 会得到 `icXxx`。
//!    改用 `substr` / `instr`，顺带省掉转义。

use serde::Deserialize;

/// Oracle 的 `in (...)` 上限是 1000 个字面量，留余量给别的条件。
pub const IN_CHUNK: usize = 900;

/// 一次最多选多少张表。
///
/// 500 张 ≈ 3 万个列行（本库实测 328 张 `bd_` 表是 18 657 行、2.9 秒）。
/// 再往上不是跑不动，是**没人看得完**，而且文档会大到没人打开。
pub const MAX_TABLES: usize = 500;

/// 表集合的选取条件。三个条件同时给出时取**交集**。
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TableFilter {
    /// 精确表名（勾选、或从补丁草稿里扫出来的表）。
    pub names: Vec<String>,
    /// 表名前缀，如 `bd_`。按字面比较，不是 LIKE。
    pub prefix: String,
    /// 表名或表中文名里包含的字串。
    pub keyword: String,
}

impl TableFilter {
    /// 去空白、去空项、小写化。SQL 统一按 `lower(name)` 比较。
    pub fn normalized(&self) -> Self {
        let mut names: Vec<String> = self
            .names
            .iter()
            .map(|n| n.trim().to_lowercase())
            .filter(|n| !n.is_empty())
            .collect();
        names.sort();
        names.dedup();
        Self {
            names,
            prefix: self.prefix.trim().to_lowercase(),
            keyword: self.keyword.trim().to_lowercase(),
        }
    }

    /// 一个条件都没有 = 没有选取范围。**不允许退化成"全库"**：
    /// 5876 张表没人看得完，而且它会掩盖"用户其实没选东西"这个事实。
    pub fn is_empty(&self) -> bool {
        let n = self.normalized();
        n.names.is_empty() && n.prefix.is_empty() && n.keyword.is_empty()
    }

    /// 用户是怎样选出这批表的（写进文档抬头，便于事后核对口径）。
    pub fn describe(&self) -> String {
        let f = self.normalized();
        let mut parts = Vec::new();
        if !f.names.is_empty() {
            parts.push(format!("指定 {} 张表", f.names.len()));
        }
        if !f.prefix.is_empty() {
            parts.push(format!("前缀 {}", f.prefix));
        }
        if !f.keyword.is_empty() {
            parts.push(format!("包含「{}」", f.keyword));
        }
        if parts.is_empty() {
            "未指定".to_string()
        } else {
            parts.join(" · ")
        }
    }
}

/// SQL 字符串字面量：单引号翻倍。
///
/// 表名来自库里自己的元数据、前缀/关键词来自用户输入，两边都可能带单引号
/// （二开表名不保证规范），所以统一走这里，不在拼串处手写引号。
pub fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 表清单。带版本去重（`rn = 1`）、软删与停用过滤。
pub fn tables_sql(f: &TableFilter, limit: usize) -> Result<String, String> {
    let f = f.normalized();
    if f.names.is_empty() && f.prefix.is_empty() && f.keyword.is_empty() {
        return Err("没有选表：勾选表、给一个前缀、或输入关键词".to_string());
    }
    if f.names.len() > MAX_TABLES {
        return Err(format!(
            "一次最多 {} 张表（现在 {} 张）",
            MAX_TABLES,
            f.names.len()
        ));
    }

    let mut conds: Vec<String> = Vec::new();
    if !f.names.is_empty() {
        let list: Vec<String> = f.names.iter().map(|n| literal(n)).collect();
        conds.push(format!("lower(t.name) in ({})", list.join(", ")));
    }
    if !f.prefix.is_empty() {
        // 按字面比较：`substr` 不吃通配符，`%`/`_` 都当普通字符
        conds.push(format!(
            "substr(lower(t.name), 1, {}) = {}",
            f.prefix.chars().count(),
            literal(&f.prefix)
        ));
    }
    if !f.keyword.is_empty() {
        let k = literal(&f.keyword);
        conds.push(format!(
            "(instr(lower(t.name), {k}) > 0 or instr(lower(t.displayname), {k}) > 0)"
        ));
    }

    // 允许比 MAX_TABLES 多 1 行：调用方要用「多出来的那一行」判断是否超限。
    // 卡死在 MAX_TABLES 的话，`bd_` 这种宽前缀会被 rownum 悄悄截断成 500 张，
    // 生成出来的字典缺表却报成功——和缺列一样，是「看着完整、其实不全」。
    let limit = limit.clamp(1, MAX_TABLES + 1);
    // 三层嵌套：内层去版本 → 中层取 rn=1 并排序 → 外层截断。
    // Oracle 的 rownum 在 order by 之前生效，两层塞不进同一个 select。
    Ok(format!(
        "select * from (\
           select * from (\
             select row_number() over (partition by t.id order by t.versiontype desc) rn, \
                    t.id, t.name, t.displayname, t.isextendtable, t.isactive, t.resid, t.resmodule \
               from md_table t \
              where nvl(t.dr, 0) = 0 \
                and (t.industry in ('0', '48') or t.industry is null) \
                and {}\
           ) a where a.rn = 1 order by a.name\
         ) where rownum <= {limit}",
        conds.join(" and ")
    ))
}

/// 列 + 属性名。一个（列, 属性）一对，折叠由装配层做。
///
/// 返回多条语句：`table_id` 超过 [`IN_CHUNK`] 要分片，同一次查询里塞 6000 个
/// 字面量会让 SQL 解析本身变慢，而且超 1000 直接 ORA-01795。
pub fn columns_sqls(table_ids: &[String]) -> Vec<String> {
    chunks(table_ids)
        .into_iter()
        .map(|ids| {
            let list: Vec<String> = ids.iter().map(|i| literal(i)).collect();
            format!(
                "select c.tableid tid, c.name cname, c.displayname cdisp, c.sqldatetype ctype, \
                        c.columnlength clen, c.precise cscale, c.pkey cpkey, c.nullable cnull, \
                        c.columnsequence cseq, p.name pname, p.displayname pdisp \
                   from md_column c \
                   left join md_ormap m on m.columnid = c.id and nvl(m.dr, 0) = 0 \
                   left join (\
                     select id, name, displayname from (\
                       select row_number() over (partition by id order by versiontype desc) rn, \
                              id, name, displayname \
                         from md_property \
                        where nvl(dr, 0) = 0 \
                          and (industry in ('0', '48') or industry is null)\
                     ) where rn = 1\
                   ) p on p.id = m.attributeid \
                  where nvl(c.dr, 0) = 0 \
                    and c.tableid in ({})",
                list.join(", ")
            )
        })
        .collect()
}

/// 表 → 实体（VO 类）。一个表可能被多个实体映射（`bd_billtype` 是 3 个），
/// 所以这里是**候选**，不是唯一答案，装配层会写成"多个实体"并标出来。
pub fn entities_sqls(table_ids: &[String]) -> Vec<String> {
    chunks(table_ids)
        .into_iter()
        .map(|ids| {
            let list: Vec<String> = ids.iter().map(|i| literal(i)).collect();
            format!(
                "select c.tableid tid, cl.name cname, cl.fullclassname cfull, \
                        count(distinct c.id) ccols \
                   from md_ormap m \
                   join md_column c on c.id = m.columnid \
                   join md_class cl on cl.id = m.classid \
                  where nvl(m.dr, 0) = 0 and nvl(c.dr, 0) = 0 \
                    and c.tableid in ({}) \
                  group by c.tableid, cl.name, cl.fullclassname",
                list.join(", ")
            )
        })
        .collect()
}

fn chunks(ids: &[String]) -> Vec<&[String]> {
    if ids.is_empty() {
        return Vec::new();
    }
    ids.chunks(IN_CHUNK).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> TableFilter {
        TableFilter {
            names: v.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn 空选取直接报错而不是查全库() {
        assert!(tables_sql(&TableFilter::default(), 100).is_err());
        assert!(TableFilter::default().is_empty());
        // 只有空白也算空
        let blank = TableFilter {
            names: vec!["  ".into()],
            prefix: " ".into(),
            keyword: String::new(),
        };
        assert!(blank.is_empty());
        assert!(tables_sql(&blank, 100).is_err());
    }

    #[test]
    fn industry_放行_null_否则会丢扩展表() {
        let sql = tables_sql(&names(&["bd_billtype"]), 100).unwrap();
        // 本库 26 张 industry 为 NULL 的表里 25 张是扩展表，这条不可省
        assert!(sql.contains("(t.industry in ('0', '48') or t.industry is null)"));
        assert!(sql.contains("nvl(t.dr, 0) = 0"), "dr 是 NULL 而不是 0");
        assert!(sql.contains("where a.rn = 1"), "多版本必须去重");
    }

    #[test]
    fn 前缀按字面比较不吃通配符() {
        let sql = tables_sql(
            &TableFilter {
                prefix: "ic_".into(),
                ..Default::default()
            },
            100,
        )
        .unwrap();
        assert!(sql.contains("substr(lower(t.name), 1, 3) = 'ic_'"));
        assert!(!sql.contains(" like "), "LIKE 会把 _ 当通配符");
    }

    #[test]
    fn 关键词同时搜表名与中文名() {
        let sql = tables_sql(
            &TableFilter {
                keyword: "单据".into(),
                ..Default::default()
            },
            100,
        )
        .unwrap();
        assert!(sql.contains("instr(lower(t.name), '单据') > 0"));
        assert!(sql.contains("instr(lower(t.displayname), '单据') > 0"));
    }

    #[test]
    fn 单引号与大小写都被处理掉() {
        let sql = tables_sql(&names(&["BD_O'Neil"]), 100).unwrap();
        assert!(sql.contains("'bd_o''neil'"), "单引号必须翻倍：{sql}");
        // 归一化后的小写表名才能和 lower(t.name) 对上
        assert!(!sql.contains("BD_O"));
    }

    #[test]
    fn 列查询不带_industry_且必需软删过滤() {
        let sqls = columns_sqls(&["t1".to_string()]);
        assert_eq!(sqls.len(), 1);
        let sql = &sqls[0];
        assert!(sql.contains("c.tableid in ('t1')"));
        // md_column 没有 industry 列（实测 ORA-00904），SQL 里只该出现在 md_property 子查询
        let before_prop = sql.split("md_property").next().unwrap();
        assert!(
            !before_prop.contains("c.industry"),
            "md_column 没有 industry 列"
        );
        assert!(sql.contains("nvl(m.dr, 0) = 0"));
    }

    #[test]
    fn 超过_900_张表自动分片() {
        let ids: Vec<String> = (0..1900).map(|i| format!("id{i}")).collect();
        let sqls = columns_sqls(&ids);
        assert_eq!(sqls.len(), 3, "1900 个 id 应分成 900/900/100");
        assert_eq!(entities_sqls(&ids).len(), 3);
    }

    #[test]
    fn 表数超过上限报错而不是悄悄截断() {
        let many: Vec<String> = (0..MAX_TABLES + 1).map(|i| format!("t{i}")).collect();
        let err = tables_sql(
            &names(&many.iter().map(String::as_str).collect::<Vec<_>>()),
            100,
        )
        .unwrap_err();
        assert!(err.contains(&MAX_TABLES.to_string()));
    }

    #[test]
    fn 上限截断写在最外层() {
        let sql = tables_sql(&names(&["a"]), 50).unwrap();
        assert!(sql.trim_end().ends_with("where rownum <= 50"));
    }

    #[test]
    fn 允许比上限多要一行用来判断超限() {
        // 命令层按 MAX_TABLES + 1 查：多出来的那一行 = 「范围太宽」，必须报错而不是截断
        let sql = tables_sql(&names(&["a"]), MAX_TABLES + 1).unwrap();
        assert!(sql
            .trim_end()
            .ends_with(&format!("where rownum <= {}", MAX_TABLES + 1)));
        // 再多也不会继续放宽：只有调用方明确要那一行时才给
        let wide = tables_sql(&names(&["a"]), MAX_TABLES + 100).unwrap();
        assert!(wide
            .trim_end()
            .ends_with(&format!("where rownum <= {}", MAX_TABLES + 1)));
    }

    #[test]
    fn 描述口径能看懂() {
        let f = TableFilter {
            names: vec!["a".into(), "b".into()],
            prefix: "bd_".into(),
            keyword: String::new(),
        };
        let d = f.describe();
        assert!(d.contains("2 张表") && d.contains("bd_"));
    }
}
