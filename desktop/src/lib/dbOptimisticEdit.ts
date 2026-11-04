import type { BoundCell, Cell, ColumnMeta } from "./dbApi";
import { identifier } from "./dbConditions";

export interface RowChange { row: number; sql: string; params: BoundCell[]; cells: { column: number; before: Cell; after: Cell }[] }
export function optimisticChanges(table: string, columns: ColumnMeta[], rows: Cell[][], pk: string[], changed: Map<string, Cell>): RowChange[] {
  const keyCols = pk.map(n => columns.findIndex(c => c.name.toUpperCase() === n.toUpperCase()));
  if (!pk.length || keyCols.some(i => i < 0)) return [];
  const byRow = new Map<number, number[]>();
  for (const k of changed.keys()) { const [r,c] = k.split(":").map(Number); byRow.set(r, [...(byRow.get(r) ?? []), c]); }
  return [...byRow].sort(([a],[b]) => a-b).map(([r, cs]) => {
    const row = rows[r];
    if (!row || keyCols.some(i => row[i] === null)) throw new Error("记录缺少有效主键，不能写回");
    const params: BoundCell[] = [];
    const bind = (v: Cell, c: number) => bindRowValue(v, columns[c], params);
    const cells = cs.map(c => ({ column:c, before:row[c], after:changed.get(`${r}:${c}`)! }));
    const set = cells.map(c => `${identifier(columns[c.column].name)} = ${bind(c.after, c.column)}`).join(", ");
    const guards = [...new Set([...keyCols, ...cs])].map(c => {
      const name = identifier(columns[c].name);
      if (row[c] === null) return `${name} is null`;
      return /CLOB/i.test(columns[c].type) ? `dbms_lob.compare(${name}, ${bind(row[c],c)}) = 0` : `${name} = ${bind(row[c],c)}`;
    });
    // 原值条件与 UPDATE 是同一条语句，避免先查后改之间仍被其他会话抢写。
    return { row:r, cells, params, sql:`update ${identifier(table)} set ${set} where ${guards.join(" and ")}` };
  });
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
