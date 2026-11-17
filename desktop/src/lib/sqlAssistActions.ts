// 「光标在这儿能做什么」的单一真源。
//
// 为什么要这一层（2026-11-14）：同一个位置原来由三套各自独立的门槛决定——
// 补全列表在 `sqlAssistProvider` 里判一次、CodeAction 在 `sqlBillAssist` 里判一次、
// 右键菜单又各写一次。于是 `SELECT * FROM po_order` 这个最常见的写法会出现
// 「补全给 JOIN 片段、灯泡给整条替换、右键什么都没有」三种行为，用户哪边都记不住。
//
// 这里只做**判定**，不读库、不拼 SQL、不碰 monaco：
// 输入是已经算好的位置事实，输出是当下可用的动作清单。
// 消费方：补全列表里的动作项、表名后的行内 chip、Ctrl+. 菜单。
//
// 只收**生成类**动作（把 SQL 凭空写出来）。三类故意不在目录里：
// - 纠错类（条件移入 ON / 明确 INNER JOIN）：它们已经有 marker + 行尾透镜作锚点，
//   再进补全等于在用户没犯错的地方推销；
// - 选区类（转 IN / 查重 / 汇总）：需要用户先选中一列值，位置信息判不出来，
//   走 `sqlSelectionActions`；
// - 记忆类（固定表 / 忘记表 / 快捷键速查）：是设置不是改写，只留右键菜单。
//
// 🔴 加了动作就必须有能执行的入口：`ACTION_COMMANDS` 里没有 id 的动作
// 点下去只会弹一个空菜单（`bill.*` 走 CodeAction，`star.*`/`insert.*` 走 editor action）。

/** 生成类动作。 */
export type SqlActionId = "bill.query" | "bill.join" | "star.expand" | "insert.template";

export interface SqlActionInput {
  /** Oracle 方言。联查模板目前只对 plsql 成立；展开字段不分方言。 */
  plsql: boolean;
  /** 设置里的「查询与条件模板」总开关。 */
  templatesEnabled: boolean;
  /** 语句还没开始（裸表名起手）。这里替换的是表名本身，整条联查才放得进去。 */
  bare: boolean;
  /** 光标处（或光标前）精确命中的表（小写规范名）；空串表示没命中。 */
  table: string;
  /** 这张表在业务关系同步快照里已知的子表数。0 = 还没解析出来。 */
  relations: number;
  /**
   * 有可展开的 `*`：光标压在 `*` 上，或光标所在语句里恰好只有一个 `*`。
   * 两者共用 `sqlScope` 的判定，别在这里另立标准。
   */
  wildcard: boolean;
  /** 有已确认的表，且当前语句是普通 SQL（不是 PL/SQL 块）——INSERT 模板的成立条件。 */
  insertable: boolean;
}

export interface SqlAction {
  id: SqlActionId;
  title: string;
  detail: string;
  /**
   * 关键词直搜：打这些 ASCII 词也能把动作搜出来。
   *
   * 🔴 只收「打出来不会和语法关键字撞车」的词。联查类刻意**不给**关键词：
   * `join` 本身就是 SQL 关键字，给了会抢掉 `JOIN` 的补全位，按 Enter 还会
   * 打开一个菜单而不是插入关键字。
   */
  keys: readonly string[];
}

/**
 * 动作 → 执行入口。
 *
 * `bill.*` 走 CodeAction 菜单：一张表可能有多个子表，必须先让用户选。
 * `star.*` / `insert.*` 是单值动作，直接跑 editor action，少一次点击。
 */
export const ACTION_COMMANDS: Readonly<Record<SqlActionId, string | null>> = {
  "bill.query": null,
  "bill.join": null,
  "star.expand": "ncforge.sql.expandStar",
  "insert.template": "ncforge.sql.insertTemplate",
};

/** 当下可用的动作，按展示顺序返回。 */
export function sqlActionsAt(input: SqlActionInput): SqlAction[] {
  const actions: SqlAction[] = [];
  // 展开字段不是「模板」，不受模板开关管——与表名旁 chip 的口径一致。
  if (input.wildcard) {
    actions.push({ id: "star.expand", title: "展开 * 为字段列表", detail: "带中文名与别名前缀", keys: ["exp", "expand"] });
  }
  if (!input.plsql || !input.templatesEnabled) return actions;
  // 关系没解析出来之前不给：说了「支持主子表联查」却点不动，比不说更糟。
  if (input.table && input.relations > 0) {
    // 🔴 与 `sqlBillAssist` 的口径必须一致，否则给出一条点不动的动作：
    // - 裸表名 → 整表替换（`targetAt` 的 replace 模式）；
    // - 语句内 → 只能追加 JOIN（append 模式），替换整条会毁掉已有的 SELECT/WHERE。
    actions.push(input.bare
      ? { id: "bill.query", title: "补全为整条主子表联查", detail: `${input.table} 另有 ${input.relations} 张可关联的子表`, keys: [] }
      : { id: "bill.join", title: "追加子表 LEFT JOIN", detail: `在 ${input.table} 后接上子表与 ON 条件`, keys: [] });
  }
  if (input.insertable && input.table && input.bare) {
    // 只在「新语句起手」给：`SELECT * FROM po_order` 那里列表已经塞满表名与 JOIN 片段，
    // 再挂一条 INSERT 模板只会让最常见的补全多一行噪音。那种位置想生成 INSERT，
    // 右键菜单里一直有。
    actions.push({ id: "insert.template", title: "生成 INSERT 模板", detail: `按 ${input.table} 的真实列序`, keys: ["insert"] });
  }
  return actions;
}

/**
 * 已输入的词是不是这条动作的关键词。
 *
 * 允许少打一个字符（`ex` 命中 `exp`），但**不允许**两字符以下的短前缀：
 * `in` 是 SQL 的 `IN` 操作符，让它命中 `insert` 会把操作符从列表首位挤走。
 * 返回命中用的 key（拿它当 `filterText` 与 label 前缀），没命中返回空串。
 */
export function keywordFor(action: SqlAction, prefix: string): string {
  const typed = prefix.toLowerCase();
  if (typed.length < 2) return "";
  return action.keys.find(key => key.startsWith(typed) && typed.length >= key.length - 1) ?? "";
}
