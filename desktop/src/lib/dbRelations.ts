import type { BoundCell, Cell, ColumnMeta, ExecResult } from "./dbApi";
import { bindRowValue } from "./dbOptimisticEdit";
import { identifier } from "./dbConditions";
import { activateTab, getDb, openTableTab, patchTab, type TableTab } from "./dbStore";
export interface Relation {id:string;source:string;target:string;from:string[];to:string[];kind:"外键"|"NC类引用"}
export function relationRows(result:ExecResult,kind:Relation["kind"]):Relation[] {
  if(result.kind!=="rows") return [];
  const col=(name:string)=>result.columns.findIndex(c=>c.name.toUpperCase()===name);
  const names=["RELATION","SOURCE_TABLE","SOURCE_COLUMN","TARGET_TABLE","TARGET_COLUMN","POSITION"];
  const indexes=names.map(col); if(indexes.some(i=>i<0)) return [];
  const groups=new Map<string,Relation>();
  for(const row of [...result.rows].sort((a,b)=>Number(a[indexes[5]])-Number(b[indexes[5]]))) {
    const [name,source,from,target,to]=indexes.slice(0,5).map(i=>String(row[i]??""));
    if(!source || !target || !from || !to) continue;
    const id=`${kind}:${name}:${source}:${target}`;
    const r=groups.get(id) ?? {id,source,target,from:[],to:[],kind};
    if(!r.from.includes(from)) {r.from.push(from);r.to.push(to);} groups.set(id,r);
  }
  return [...groups.values()];
}
export function relationQuery(relation:Relation,table:string,columns:ColumnMeta[],row:Cell[]) {
  const forward=relation.source.toUpperCase()===table.toUpperCase();
  const from=forward?relation.from:relation.to, to=forward?relation.to:relation.from;
  const params:BoundCell[]=[];
  const where=from.map((name,i)=>{const c=columns.findIndex(c=>c.name.toUpperCase()===name.toUpperCase());if(c<0) throw new Error(`结果没有关联字段 ${name}`);const value=row[c];if(value===null || value===undefined) throw new Error(`关联字段 ${name} 为空`);return `${identifier(to[i])} = ${bindRowValue(value,columns[c],params)}`;}).join(" and ");
  return {table:forward?relation.target:relation.source,where,order:"",params};
}
export function openRelated(tab:TableTab,query:ReturnType<typeof relationQuery>) {
  const id=openTableTab(tab.connId,query.table);
  patchTab<TableTab>(id,{query,trail:[...(tab.trail??[]),{tabId:tab.id,label:tab.table}]});
}

export function returnRelated(tab:TableTab,step:{tabId:string;label:string}):boolean {
  if(getDb().tabs.some(t=>t.id===step.tabId)) { activateTab(step.tabId); return false; }
  openTableTab(tab.connId,step.label);
  return true;
}
