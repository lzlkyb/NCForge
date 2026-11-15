// 「光标在这儿能做什么」的单一真源。
//
// 为什么要这一层（2026-11-14）：同一个位置原来由三套各自独立的门槛决定——
// 补全列表在 `sqlAssistProvider` 里判一次、CodeAction 在 `sqlBillAssist` 里判一次、
// 右键菜单又各写一次。于是 `SELECT * FROM po_order` 这个最常见的写法会出现
// 「补全给 JOIN 片段、灯泡给整条替换、右键什么都没有」三种行为，用户哪边都记不住。
//
// 这里只做**判定**，不读库、不拼 SQL、不碰 monaco：
// 输入是已经算好的位置事实，输出是当下可用的动作清单。
// 消费方：补全列表末尾的动作项、表名后的行内 chip。
//
// 选区类动作（批量转 IN、核对查询）**故意不在目录里**：它们需要用户先选中一列值，
// 位置信息不足以判断，留在右键菜单才是对的。

export type SqlActionId = "bill.query" | "bill.join";

export interface SqlActionInput {
  /** Oracle 方言。模板族目前只对 plsql 成立。 */
  plsql: boolean;
  /** 设置里的「查询与条件模板」总开关。 */
  templatesEnabled: boolean;
  /** 语句还没开始（裸表名起手）。这里替换的是表名本身，整条联查才放得进去。 */
  bare: boolean;
  /** 光标处精确命中的表（小写规范名）；空串表示没命中。 */
  table: string;
  /** 这张表在业务关系同步快照里已知的子表数。0 = 还没解析出来。 */
  relations: number;
}

export interface SqlAction {
  id: SqlActionId;
  title: string;
  detail: string;
}

/** 当下可用的动作，按展示顺序返回。 */
export function sqlActionsAt(input: SqlActionInput): SqlAction[] {
  if (!input.plsql || !input.templatesEnabled) return [];
  // 关系没解析出来之前不给：说了「支持主子表联查」却点不动，比不说更糟。
  if (!input.table || input.relations <= 0) return [];
  // 🔴 与 `sqlBillAssist` 的口径必须一致，否则给出一条点不动的动作：
  // - 裸表名 → 整表替换（`targetAt` 的 replace 模式）；
  // - 语句内 → 只能追加 JOIN（append 模式），替换整条会毁掉已有的 SELECT/WHERE。
  return input.bare
    ? [{ id: "bill.query", title: "补全为整条主子表联查", detail: `${input.table} 另有 ${input.relations} 张可关联的子表` }]
    : [{ id: "bill.join", title: "追加子表 LEFT JOIN", detail: `在 ${input.table} 后接上子表与 ON 条件` }];
}
