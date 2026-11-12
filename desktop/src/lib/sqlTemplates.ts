// 表名 → 整条查询模板。
//
// 场景：编辑器还空着（或刚开始写一条新语句）时，用户先打出表名，希望直接得到
// 一条能跑的 `select`。补全列表是这里唯一顺手的入口——右键「生成 INSERT 模板」
// 那种做法要求表名**已经写在语句里**，属于「写完再改」，覆盖不到这个起点。
//
// 只给「唯一命中」的那张表挂模板：3000 张表各挂三条会把列表淹掉，而前缀唯一命中
// 恰好说明用户已经知道自己在找哪张表。
import type { SqlLanguage } from "sql-formatter";

export interface SqlTemplate {
  /** 列表里显示的人读文本（也用来做二级说明的标题）。 */
  label: string;
  /** Monaco snippet 文本：`$0` 是落点，其余 `$`/`}`/`\` 必须转义。 */
  insertText: string;
  /** 列表里的灰色说明。 */
  hint: string;
}

/** Monaco snippet 的元字符转义，与 `sqlEditorAssist` 里插 INSERT 模板同一口径。 */
export const snippetEscape = (text: string): string => text.replace(/[\\$}]/g, "\\$&");

/**
 * 给一张表生成模板列表。
 *
 * @param insertText 已经过 `sqlIdentifier` 处理的表名（该加引号的加好了）。
 * @param upper     关键字大小写跟格式化的 `keywordCase` 一致；`preserve` 也按大写，
 *                  与右键「生成 INSERT 模板」同口径——两处不一致比统一错更糟。
 * @param dialect   决定 `FOR UPDATE` 出不出：tsql 用 `WITH (UPDLOCK)`，写 `FOR UPDATE`
 *                  是直接报错的语句，不如不给。
 */
export function tableTemplates(insertText: string, upper: boolean, dialect: SqlLanguage = "sql"): SqlTemplate[] {
  const id = snippetEscape(insertText);
  const kw = (text: string) => (upper ? text : text.toLowerCase());
  const listed: SqlTemplate[] = [
    {
      label: `${kw("SELECT")} * ${kw("FROM")} ${insertText}`,
      insertText: `${kw("SELECT")} * ${kw("FROM")} ${id};$0`,
      hint: "整条查询",
    },
    {
      label: `${kw("SELECT")} ${kw("COUNT")}(*) ${kw("FROM")} ${insertText}`,
      insertText: `${kw("SELECT")} ${kw("COUNT")}(*) ${kw("FROM")} ${id};$0`,
      hint: "只数行数",
    },
  ];
  if (dialect !== "tsql") {
    listed.push({
      label: `${kw("SELECT")} * ${kw("FROM")} ${insertText} ${kw("FOR")} ${kw("UPDATE")}`,
      insertText: `${kw("SELECT")} * ${kw("FROM")} ${id} ${kw("FOR")} ${kw("UPDATE")};$0`,
      hint: "锁定这些行再改",
    });
  }
  return listed;
}

// ── 开关：模板是「顺手」不是「必需品」，觉得吵可以关掉 ──
const KEY = "ncforge-sql-templates";
const listeners = new Set<() => void>();
let enabled = load();

function load(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    // 隐私模式 / 无 DOM 的测试环境：默认开启
    return true;
  }
}

export function getSqlTemplatesEnabled(): boolean {
  return enabled;
}

/** 返回是否写盘成功；写失败也已经在本次会话生效，与 `setSqlUsageEnabled` 同口径。 */
export function setSqlTemplatesEnabled(value: boolean): boolean {
  enabled = value;
  listeners.forEach((fn) => fn());
  try {
    localStorage.setItem(KEY, value ? "on" : "off");
    return true;
  } catch {
    return false;
  }
}

export function subscribeSqlTemplates(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
