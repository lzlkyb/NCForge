import { useSyncExternalStore } from "react";
import type { Cell, ColumnMeta } from "./dbApi";
import { type ResultSnapshot } from "./dbResultTools";
import { RESULT_BYTES, RESULT_ROWS, rowsBytes } from "./dbResultBudget";
import { toTsv } from "./resultExport";

export interface CompareTab {
  kind:"compare"; id:string; connId:null; title:string;
  before:ResultSnapshot; after:ResultSnapshot; keys:string[];
  filter:"all"|"changed"|"added"|"removed"; query:string; onlyChanged:boolean;
  scrollTop?:number; scrollLeft?:number; activeCell?:{r:number;c:number}|null;
}
let baseline:ResultSnapshot|null=null;
const listeners=new Set<()=>void>();
export const getCompareBaseline=()=>baseline;
export const subscribeCompareBaseline=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const useCompareBaseline=()=>useSyncExternalStore(subscribeCompareBaseline,getCompareBaseline,getCompareBaseline);

/** Check before allocating; a partial clone would silently change the comparison's scope. */
export function cloneCompareSnapshot(snapshot:ResultSnapshot):ResultSnapshot {
  if(snapshot.rows.length>RESULT_ROWS) throw new Error(`结果超过比较上限 ${RESULT_ROWS.toLocaleString()} 行，请缩小查询范围后重试；未截断数据。`);
  if(rowsBytes(snapshot.rows)>RESULT_BYTES) throw new Error("结果超过比较内存上限 16 MiB，请缩小查询范围后重试；未截断数据。");
  const copy={...snapshot,columns:snapshot.columns.map(c=>({...c})),rows:snapshot.rows.map(row=>[...row])};
  copy.columns.forEach(Object.freeze);copy.rows.forEach(Object.freeze);
  Object.freeze(copy.columns);Object.freeze(copy.rows);
  return Object.freeze(copy);
}
export function setCompareBaseline(snapshot:ResultSnapshot):ResultSnapshot {
  const next=cloneCompareSnapshot(snapshot);baseline=next;listeners.forEach(listener=>listener());return next;
}
export function clearCompareBaseline() {if(baseline){baseline=null;listeners.forEach(listener=>listener());}}

export const compareKindLabel={changed:"修改",added:"新增",removed:"删除"} as const;
export interface ComparisonRecord {kind:Exclude<CompareTab["filter"],"all">;key:string;before:Cell[]|null;after:Cell[]|null}
export interface ComparisonModel {columns:ColumnMeta[];keyColumns:number[];records:ComparisonRecord[];counts:Record<ComparisonRecord["kind"],number>}
export interface ComparisonColumn {kind:"type"|"key"|"value";name:string;sourceIndex:number;side?:"A"|"B";width:number}
export { buildComparison } from "./comparisonModel";
export function filterComparisonRows(model:ComparisonModel,filter:CompareTab["filter"],query:string):number[] {
  const search=query.trim().toLocaleLowerCase();
  return model.records.flatMap((row,index)=>(filter==="all" || row.kind===filter) && (!search || row.key.toLocaleLowerCase().includes(search)) ? [index] : []);
}
export function comparisonColumns(model:ComparisonModel,order:number[],onlyChanged:boolean):ComparisonColumn[] {
  const result:ComparisonColumn[]=[{kind:"type",name:"变化",sourceIndex:-1,width:84},...model.keyColumns.map(sourceIndex=>({kind:"key" as const,name:model.columns[sourceIndex].name,sourceIndex,width:140}))];
  model.columns.forEach((column,sourceIndex)=>{
    if(model.keyColumns.includes(sourceIndex)) return;
    if(onlyChanged && !order.some(i=>{const row=model.records[i];return !row.before || !row.after || row.before[sourceIndex]!==row.after[sourceIndex];})) return;
    result.push({kind:"value",name:column.name,sourceIndex,side:"A",width:190},{kind:"value",name:column.name,sourceIndex,side:"B",width:190});
  });
  return result;
}
export function comparisonCell(row:ComparisonRecord,column:ComparisonColumn):Cell|undefined {
  if(column.kind==="type") return compareKindLabel[row.kind];
  if(column.kind==="key") return (row.after ?? row.before)![column.sourceIndex];
  return (column.side==="A" ? row.before : row.after)?.[column.sourceIndex];
}
export function comparisonTsv(before:ResultSnapshot,after:ResultSnapshot,model:ComparisonModel):string {
  const scope=before.complete && after.complete ? "两份查询结果的全部已加载数据，包含隐藏列" : "仅比较已加载数据，不能代表全表差异";
  const meta=[scope,before.source,after.source,before.schema ?? "未记录",after.schema ?? "未记录",new Date(before.at).toISOString(),new Date(after.at).toISOString()];
  const columns=[...(["比较范围","A 来源","B 来源","A schema","B schema","A 时间","B 时间","变化","取值侧"].map(name=>({name,type:"VARCHAR2",precision:0,scale:0}))),...model.columns];
  // Export the model, never the filtered row order or the virtual viewport.
  const rows=model.records.flatMap(row=>[
    ...(row.before ? [[...meta,compareKindLabel[row.kind],"A 对照值",...row.before]] : []),
    ...(row.after ? [[...meta,compareKindLabel[row.kind],"B 当前值",...row.after]] : []),
  ]);
  return toTsv(columns,rows);
}
