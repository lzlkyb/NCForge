/**
 * 表结构对比（DDL diff）的共享类型与纯函数。
 *
 * 后端（`db_struct.rs`）算完差异与 DDL 之后再回到这里：前端只做「怎么给人看」——
 * 汇总计数、把脚本拼成可复制的整段、按状态筛行。比对规则一律不在前端复制一份，
 * 否则两侧判据会慢慢分叉。
 */

export type DiffStatus = "same" | "onlyLeft" | "onlyRight" | "changed";

export interface StructColumn {
  name: string;
  ty: string;
  nullable: boolean;
  defaultText: string | null;
  comment: string | null;
}

export interface StructIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface TableStruct {
  /** `OWNER.TABLE`。 */
  label: string;
  columns: StructColumn[];
  pk: string[];
  pkName: string | null;
  indexes: StructIndex[];
  comment: string | null;
}

export interface FieldDiff {
  /** 类型 / 可空 / 默认值 / 注释。 */
  field: string;
  left: string | null;
  right: string | null;
}

export interface ColumnDiff {
  name: string;
  status: DiffStatus;
  left: StructColumn | null;
  right: StructColumn | null;
  changes: FieldDiff[];
}

export interface IndexDiff {
  name: string;
  leftName: string | null;
  rightName: string | null;
  unique: boolean;
  columns: string[];
  status: DiffStatus;
  /** 列与唯一性一致、只是名字不同：不算差异，但界面要提一句。 */
  renamed: boolean;
}

export interface StructStmt {
  sql: string;
  reason: string;
  /** 会删东西：界面标红，且**永不自动执行**。 */
  destructive: boolean;
}

export interface StructDiff {
  left: TableStruct;
  right: TableStruct;
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  pkChanged: boolean;
  commentChanged: boolean;
  onlyLeft: number;
  onlyRight: number;
  changed: number;
  ddl: StructStmt[];
}

export interface StructSideReq {
  id: string;
  owner: string;
  table: string;
}

/** 汇总（界面顶部的几个胶囊）。`diff` 为 `null`（还没比）时全是 0。 */
export function summarize(diff: StructDiff | null): { same: number; onlyLeft: number; onlyRight: number; changed: number; statements: number } {
  if (!diff) return { same: 0, onlyLeft: 0, onlyRight: 0, changed: 0, statements: 0 };
  return {
    same: diff.columns.filter((c) => c.status === "same").length,
    onlyLeft: diff.onlyLeft,
    onlyRight: diff.onlyRight,
    changed: diff.changed,
    statements: diff.ddl.length,
  };
}

/**
 * 把 DDL 拼成一段脚本。
 *
 * 每段前面带 `-- 原因`：脚本脱离界面之后（贴到工单、发给同事）还能看出**为什么**要改这行，
 * 而不是一堆没人敢跑的 alter。文件头写清方向，避免有人拿反了跑。
 */
export function ddlScript(diff: StructDiff): string {
  if (diff.ddl.length === 0) return "";
  const head = [
    `-- ${diff.right.label} → ${diff.left.label}（把右侧改成左侧）`,
    `-- 共 ${diff.ddl.length} 条；标 [删] 的会丢数据，逐条确认后再执行`,
    "",
  ];
  const body = diff.ddl.flatMap((s) => [
    `-- ${s.destructive ? "[删] " : ""}${s.reason}`,
    s.sql,
    "",
  ]);
  return [...head, ...body].join("\n");
}

/** 按状态筛列差异。`same` 单独给一个开关，因为「完全一致的表」会有一大堆无信息行。 */
export function filterColumns(columns: ColumnDiff[], show: "all" | "diff" | "same"): ColumnDiff[] {
  if (show === "all") return columns;
  return columns.filter((c) => (show === "same" ? c.status === "same" : c.status !== "same"));
}

/** 状态文案与色调（界面上三处用到，别各写一份）。 */
export const STATUS_TEXT: Record<DiffStatus, string> = {
  same: "一致",
  onlyLeft: "缺（左侧有）",
  onlyRight: "多（右侧有）",
  changed: "属性不同",
};
