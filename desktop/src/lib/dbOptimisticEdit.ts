import type { BoundCell, Cell, ColumnMeta } from "./dbApi";
import { identifier } from "./dbConditions";
import { isLobPreview } from "./db";

/** 一条待写回的变更。表页一次写回里可以混着三种，顺序由 `planWriteBack` 决定。 */
export type ChangeKind = "insert" | "update" | "delete";

export interface RowChange {
  kind: ChangeKind;
  /** 显示行号（`rows` 下标）；新增行是虚拟行号，只用于提示与定位草稿。 */
  row: number;
  sql: string;
  params: BoundCell[];
  cells: { column: number; before: Cell; after: Cell }[];
}

/**
 * 写回定位方式。表页不传：按 `pk` 名字在结果列里找。
 *
 * SQL 结果页会传 `keyCols` / `rowidCol` / `sourceName`：结果列可能被重命名
 * （`code as 编码`），主键列的下标也不能靠列名再猜一遍。
 */
export interface WriteOptions {
  /** 结果里 ROWID 伪列的下标；有它就不需要主键。 */
  rowidCol?: number;
  /** 定位列在结果里的下标（与 `pk` 二选一）。 */
  keyCols?: number[];
  /** 结果列下标 → 表列名；返回 null = 这一列不能写回。 */
  sourceName?: (col: number) => string | null;
}

const ROWID_COLUMN: ColumnMeta = { name: "ROWID", type: "ROWID", precision: 0, scale: 0 };

function tableNameOf(columns: ColumnMeta[], opts: WriteOptions, col: number): string {
  const name = opts.sourceName ? opts.sourceName(col) : columns[col]?.name;
  if (!name) throw new Error(`「${columns[col]?.name ?? `第 ${col + 1} 列`}」对不上表列，不能写回`);
  return name;
}

export function optimisticChanges(
  table: string,
  columns: ColumnMeta[],
  rows: Cell[][],
  pk: string[],
  changed: Map<string, Cell>,
  opts: WriteOptions = {},
): RowChange[] {
  const rowid = opts.rowidCol;
  const keyCols = opts.keyCols ?? pk.map(n => columns.findIndex(c => c.name.toUpperCase() === n.toUpperCase()));
  if (rowid === undefined && (!keyCols.length || keyCols.some(i => i < 0))) return [];
  const byRow = new Map<number, number[]>();
  for (const k of changed.keys()) { const [r,c] = k.split(":").map(Number); byRow.set(r, [...(byRow.get(r) ?? []), c]); }
  return [...byRow].sort(([a],[b]) => a-b).map(([r, cs]) => {
    const row = rows[r];
    if (!row) throw new Error("这一行已不在结果里，不能写回");
    if (rowid !== undefined && row[rowid] === null) throw new Error("这一行没有 ROWID，不能写回");
    if (rowid === undefined && keyCols.some(i => row[i] === null)) throw new Error("记录缺少有效主键，不能写回");
    const params: BoundCell[] = [];
    const bind = (v: Cell, c: number) => bindRowValue(v, columns[c], params);
    const cells = cs.map(c => ({ column:c, before:row[c], after:changed.get(`${r}:${c}`)! }));
    // 🔴 被截断的大文本不能当原值，也不能就这么写回去：
    // - `dbms_lob.compare(列, '前 8K + 尾部署名')` 永远不等于库里的完整值，UPDATE 会 0 行
    //   命中，用户只看到「可能已被他人修改」，反复重试也不会成功；
    // - 真要写进去，尾巴那句「…只显示前 8192…」就成了数据的一部分。
    // 网格拿不到完整值，所以这里只能明确拒绝，让用户走 SQL。
    const clipped = cells.find(c => typeof c.before === "string" && isLobPreview(c.before));
    if (clipped) {
      throw new Error(
        `「${columns[clipped.column].name}」内容太长，网格里只有前 8K，改它会把截断内容写坏；请用 SQL 更新这条记录`,
      );
    }
    const set = cells.map(c => `${identifier(tableNameOf(columns, opts, c.column))} = ${bind(c.after, c.column)}`).join(", ");
    const guards: string[] = [];
    if (rowid !== undefined) {
      guards.push(`rowid = ${bindRowValue(row[rowid], ROWID_COLUMN, params)}`);
    } else {
      for (const c of keyCols) {
        const name = identifier(tableNameOf(columns, opts, c));
        guards.push(row[c] === null ? `${name} is null` : /CLOB/i.test(columns[c].type)
          ? `dbms_lob.compare(${name}, ${bind(row[c],c)}) = 0` : `${name} = ${bind(row[c],c)}`);
      }
    }
    for (const c of cs) {
      const name = identifier(tableNameOf(columns, opts, c));
      guards.push(row[c] === null ? `${name} is null` : /CLOB/i.test(columns[c].type)
        ? `dbms_lob.compare(${name}, ${bind(row[c],c)}) = 0` : `${name} = ${bind(row[c],c)}`);
    }
    // 原值条件与 UPDATE 是同一条语句，避免先查后改之间仍被其他会话抢写。
    return { kind:"update", row:r, cells, params, sql:`update ${identifier(table)} set ${set} where ${guards.join(" and ")}` };
  });
}

/**
 * 新增行 → `insert`。
 *
 * 只写用户真的填过的列：没填的列交给数据库默认值（NC 表大量列有 `sysdate` / `'~'` 默认值，
 * 全部塞 NULL 会把默认值覆盖掉，写出来的单据直接不可用）。因此「空着」和「显式 NULL」
 * 是两个不同的动作，这里只处理前者——后者由用户显式输入 NULL 表示。
 */
export function insertChange(table: string, columns: ColumnMeta[], values: Map<number, Cell>, row: number, opts: WriteOptions = {}): RowChange {
  const cols = [...values.keys()].sort((a, b) => a - b).filter(c => columns[c]);
  if (!cols.length) throw new Error("新增行没有任何值，不能写回");
  // 与 UPDATE 同一条契约：网格里的大文本只有前 8K + 一段中文尾注，插进去就是永久截断。
  // 粘贴完整文本不受影响——预览标记只由后端生成。
  const clipped = cols.find(c => isLobPreview(values.get(c) ?? null));
  if (clipped !== undefined) {
    throw new Error(
      `「${columns[clipped].name}」内容太长，网格里只有前 8K，新增行不能写入截断内容；请在该列重新粘贴完整文本，或改用 SQL 插入`,
    );
  }
  const params: BoundCell[] = [];
  const names = cols.map(c => identifier(tableNameOf(columns, opts, c)));
  const binds = cols.map(c => bindRowValue(values.get(c)!, columns[c], params));
  return {
    kind: "insert",
    row,
    params,
    cells: cols.map(c => ({ column: c, before: null, after: values.get(c)! })),
    sql: `insert into ${identifier(table)} (${names.join(", ")}) values (${binds.join(", ")})`,
  };
}

/**
 * 删除行 → `delete`。只按主键 / ROWID 定位：标识不变，删掉的永远是用户看见的那一行。
 *
 * 不加原值守卫是有意的——删除整行时其它列被谁改过都不影响「删哪一行」，
 * 而给 CLOB 列做 `dbms_lob.compare` 会让每次删除多一次大字段比较。
 */
export function deleteChange(
  table: string,
  columns: ColumnMeta[],
  row: Cell[],
  pk: string[],
  index: number,
  opts: WriteOptions = {},
): RowChange {
  const params: BoundCell[] = [];
  if (opts.rowidCol !== undefined) {
    if (row[opts.rowidCol] === null) throw new Error("ROWID 为空，不能删除");
    const where = `rowid = ${bindRowValue(row[opts.rowidCol], ROWID_COLUMN, params)}`;
    return { kind: "delete", row: index, params, cells: [], sql: `delete from ${identifier(table)} where ${where}` };
  }
  const keys = opts.keyCols ?? pk.map(n => columns.findIndex(c => c.name.toUpperCase() === n.toUpperCase()));
  if (!keys.length || keys.some(i => i < 0)) throw new Error("记录缺少有效主键，不能删除");
  const where = keys.map(c => {
    if (row[c] === null) throw new Error("主键为空，不能删除");
    return `${identifier(tableNameOf(columns, opts, c))} = ${bindRowValue(row[c], columns[c], params)}`;
  });
  return { kind: "delete", row: index, params, cells: [], sql: `delete from ${identifier(table)} where ${where.join(" and ")}` };
}

/**
 * 写回顺序：先删、再改、后插。
 *
 * 顺序不是随意的：同一张表里「把 A 的编号腾给 B」这种调整，先插会撞唯一键，
 * 先删再改再插才是能跑通的顺序；而插入放最后也保证新行的外键指向的记录已经存在。
 *
 * 同一种变更内部：新增行**倒序**执行——写回成功后草稿是按行号逐条移除的，
 * 正序执行会让「移除第 i 条」把后面还没执行的草稿整体前移，写回写错行。
 */
export function planWriteBack(changes: RowChange[]): RowChange[] {
  // 同一行既标了删除又有未写回的改动：删掉整行后 UPDATE 必然 0 行命中，
  // 手动事务会停在冲突态，自动提交时 DELETE 已落库、UPDATE 报错，用户看到的是
  // 「写回失败」而那一行其实已经删了。删除的意图优先，UPDATE 不再生成。
  // 若用户随后撤销删除，`changed` 仍在，这条行会恢复成普通修改。
  const deleted = new Set(changes.filter(c => c.kind === "delete").map(c => c.row));
  const rank: Record<ChangeKind, number> = { delete: 0, update: 1, insert: 2 };
  return changes
    .filter(c => !(c.kind === "update" && deleted.has(c.row)))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === "insert" ? b.row - a.row : a.row - b.row));
}

/** 显式绑定结果中的数字和时间，避免关联/冲突回读依赖会话 NLS 格式。 */
export function bindRowValue(value:Cell,column:ColumnMeta,params:BoundCell[]):string {
  if(value!==null && /^(DATE|TIMESTAMP)/i.test(column.type)) {
    let text=String(value).trim().replace("T"," ");
    if(text.length===10) text+=" 00:00:00";
    if(text.length===16) text+=":00";
    if(!text.includes(".")) text+=".0";
    params.push(text);
    return `to_timestamp(:${params.length}, 'YYYY-MM-DD HH24:MI:SS.FF')`;
  }
  params.push(value!==null && /^(NUMBER|INTEGER|FLOAT|DECIMAL|DOUBLE)/i.test(column.type) ? {number:String(value)} : value);
  const p=`:${params.length}`;
  return value!==null && /CLOB/i.test(column.type) ? `to_clob(${p})` : p;
}

export function lookupRow(table:string,columns:ColumnMeta[],row:Cell[],pk:string[]) {
  const params:BoundCell[]=[];
  const where=pk.map(n=>{const c=columns.findIndex(v=>v.name.toUpperCase()===n.toUpperCase());if(c<0 || row[c]===null || row[c]===undefined) throw new Error("主键缺失");return `${identifier(n)} = ${bindRowValue(row[c],columns[c],params)}`;}).join(" and ");
  return {sql:`select * from ${identifier(table)} where ${where}`,params};
}
