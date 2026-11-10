import type { EditKeyInfo } from "./sqlEditable";
import type { QuerySource } from "./sqlSource";

/** 诊断面板要显示的全部信息；工具条和 toast 只用其中一两句。 */
export interface EditDiagnostics {
  /** 为什么不能改（工具条现用文案）。 */
  reason: string;
  /** 下一步能做什么；可编辑时为空。 */
  next: string;
  /** 单行 SQL 摘要（过长截断）。 */
  sql: string;
  /** 解析出的基表（可能带 schema）。 */
  table: string | null;
  alias: string | null;
  /** 行定位方式的自然语言。 */
  identity: string;
  /** 定位列（表列名）。 */
  keys: string[];
  /** 主键里结果缺的列。 */
  missing: string[];
  /** 不可编辑的列与原因。 */
  readonlyColumns: { name: string; why: string }[];
  /** 连接只读状态：null = 还没探测到。 */
  readonly: boolean | null;
  /** 是否手动指定过基表。 */
  forced: boolean;
  /** 原查询本身是 JOIN/聚合等「手动指定基表时要额外确认」的结构。 */
  risky: boolean;
  /** 解析说明（认出了什么）。 */
  detail: string;
}

export function sqlSummary(sql: string, max = 120): string {
  const text = sql.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nextStep(source: QuerySource, keyInfo: EditKeyInfo, readonly: boolean | null, usable: boolean): string {
  if (usable) return "";
  if (readonly === true) return "在顶部连接条关闭「只读模式」后重新执行。";
  if (readonly === null) return "在顶部连接条点重试，重新探测连接是否只读。";
  if (!source.table) {
    if (["join", "subquery", "union", "group", "distinct", "window", "hierarchical", "pivot", "aggregate"].includes(source.code)) {
      return "把查询改成单表 SELECT；或点「指定基表/定位列…」选一行对应的表，并确认结果含该表的定位列。只想看关联结果时，可以到对象树双击表名，用表页改数据。";
    }
    if (source.code === "no-table") return "补上 FROM 表名；只有来自表的行才能在网格里改。";
    if (["table-name", "dblink", "table-function"].includes(source.code)) {
      return "改成普通表名（schema.表名），或点「指定基表/定位列…」从表清单里手动选择。";
    }
    return "检查 SQL 是否是单条 SELECT；或点「指定基表/定位列…」手动选择。";
  }
  if (keyInfo.reason.startsWith("正在")) return "等表结构读取完成；若一直停在这里，检查连接后在顶部连接条重试。";
  if (keyInfo.missing.length) {
    return `把主键列加进 SELECT（例如 select t.*, t.rowid from ${source.table} t），或在诊断面板点「指定基表/定位列…」。`;
  }
  if (keyInfo.reason.includes("没有主键")) {
    return `给结果加 rowid：select t.*, t.rowid from ${source.table} t；或手动指定一列能唯一确定行的定位列（不保证唯一时，写回命中多行会被拒绝）。`;
  }
  if (keyInfo.reason.includes("读不到表")) return "检查表名 / schema 与访问权限；或点「指定基表/定位列…」从表清单重新选。";
  if (keyInfo.reason.includes("多列对应主键")) return "结果里同一主键出现了多次；去掉重复列，或手动指定定位列。";
  return "点「指定基表/定位列…」调整定位方式。";
}

export function buildEditDiagnostics({ sql, source, keyInfo, readonly, readonlyColumns, forced, usable, blocked, risky }: {
  sql: string;
  source: QuerySource;
  keyInfo: EditKeyInfo;
  readonly: boolean | null;
  readonlyColumns: { name: string; why: string }[];
  forced: boolean;
  usable: boolean;
  blocked: string;
  risky: boolean;
}): EditDiagnostics {
  const identity = keyInfo.kind === "rowid" ? "ROWID"
    : keyInfo.kind === "pk" ? `主键（${keyInfo.keys.join("、")}）`
      : keyInfo.kind === "custom" ? `指定列（${keyInfo.keys.join("、")}）`
        : "未确定";
  return {
    reason: blocked,
    next: nextStep(source, keyInfo, readonly, usable),
    sql: sqlSummary(sql),
    table: source.table,
    alias: source.alias,
    identity,
    keys: keyInfo.keys,
    missing: keyInfo.missing,
    readonlyColumns,
    readonly,
    forced,
    risky,
    detail: forced ? `手动指定基表 ${source.table}` : source.detail,
  };
}

/** 复制到剪贴板的纯文本：用户贴给同事/贴进工单时不用再翻界面。 */
export function diagnosticText(diag: EditDiagnostics): string {
  return [
    "为什么不能直接改数据",
    diag.reason || "可以改",
    diag.next && `下一步：${diag.next}`,
    `查询：${diag.sql}`,
    `基表：${diag.table ?? "未识别"}${diag.alias ? `（别名 ${diag.alias}）` : ""}`,
    `定位方式：${diag.identity}`,
    diag.keys.length ? `定位列：${diag.keys.join("、")}` : "",
    diag.missing.length ? `结果缺少主键列：${diag.missing.join("、")}` : "",
    diag.readonlyColumns.length ? `不可编辑列：${diag.readonlyColumns.map(c => `${c.name}（${c.why}）`).join("；")}` : "",
    `连接只读：${diag.readonly === null ? "未探测到" : diag.readonly ? "是" : "否"}`,
    diag.forced ? "已手动指定基表" : "",
  ].filter(Boolean).join("\n");
}
