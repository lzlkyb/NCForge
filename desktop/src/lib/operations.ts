import { useSyncExternalStore } from "react";

export type OperationState = "running" | "cancelling" | "success" | "failed" | "cancelled";
export interface Operation {
  id:number; key:string; label:string; scope?:string; page?:string; path?:string; panel?:string; root?:string|null;
  state:OperationState; phase:string; startedAt:number; endedAt?:number; visible:boolean;
  detail?:string; progress?:{done:number;total?:number};
}
export interface OperationSpec {
  key:string; label:string; scope?:string; page?:string; path?:string; panel?:string; root?:string|null; phase?:string;
  cancel?:()=>Promise<unknown>; retry?:boolean|(()=>Promise<unknown>); cancelled?:(error:unknown)=>boolean;
  errorDetail?:(error:unknown)=>string;
  reveal?:()=>void;
}
export interface OperationHandle {
  id:number;
  update:(patch:Partial<Pick<Operation,"phase"|"detail"|"progress">>)=>void;
  finish:(state?:Exclude<OperationState,"running"|"cancelling">,detail?:string)=>void;
}
let items:Operation[]=[];let nextId=0;
const listeners=new Set<()=>void>();
const actions=new Map<number,{cancel?:()=>Promise<unknown>;retry?:()=>Promise<unknown>;errorDetail?:(error:unknown)=>string;reveal?:()=>void}>();
const flights=new Map<string,Promise<unknown>>();
const notify=()=>listeners.forEach(f=>f());
const patch=(id:number,v:Partial<Operation>)=>{items=items.map(o=>o.id===id?{...o,...v}:o);notify();};
export const getOperations=()=>items;
export const subscribeOperations=(f:()=>void)=>{listeners.add(f);return()=>{listeners.delete(f);};};
export const useOperations=()=>useSyncExternalStore(subscribeOperations,getOperations,getOperations);
/**
 * 只订阅一个任务键：别的后台任务每 125ms 更新进度时，这个组件的快照引用不变，
 * React 直接跳过重渲染。全量 `useOperations()` 只留给确实要列所有任务的面板。
 */
function operationByKey(key:string):Operation|null{
  const list=items.filter(o=>o.key===key);
  return list.find(o=>o.endedAt===undefined) ?? list[list.length-1] ?? null;
}
function activeByKey(key:string):Operation|null{
  return items.find(o=>o.key===key && (o.state==="running" || o.state==="cancelling")) ?? null;
}
export const useOperation=(key:string)=>useSyncExternalStore(subscribeOperations,()=>operationByKey(key),()=>null);
export const useActiveOperation=(key:string)=>useSyncExternalStore(subscribeOperations,()=>activeByKey(key),()=>null);
export const useOperationById=(id:number|undefined)=>useSyncExternalStore(subscribeOperations,()=>id===undefined?null:items.find(o=>o.id===id)??null,()=>null);
/** 只关心「这个键是否在跑」时用布尔选择器，连任务对象都不必跟着变。 */
export const useOperationActive=(key:string)=>useSyncExternalStore(subscribeOperations,()=>operationActive(key),()=>false);
export const operationActive=(key:string)=>items.some(o=>o.key===key && ["running","cancelling"].includes(o.state));
export function beginOperation(spec:OperationSpec):OperationHandle|null {
  if(operationActive(spec.key)) return null;
  const id=++nextId;
  items=[...items,{id,key:spec.key,label:spec.label,scope:spec.scope,page:spec.page,path:spec.path,panel:spec.panel,root:spec.root,state:"running",phase:spec.phase??"处理中",startedAt:Date.now(),visible:false}];
  actions.set(id,{cancel:spec.cancel,errorDetail:spec.errorDetail,reveal:spec.reveal});notify();
  // 缓存命中/短操作不闪等待图标，业务结果不为动画额外延迟。
  const timer=setTimeout(()=>{const o=items.find(o=>o.id===id);if(o?.state==="running" || o?.state==="cancelling") patch(id,{visible:true});},300);
  let finished=false;
  return {id,update:v=>{if(!finished) patch(id,v);},finish:(state="success",detail)=>{
    if(finished) return;finished=true;clearTimeout(timer);
    patch(id,{state,endedAt:Date.now(),detail});
    const complete=items.filter(o=>o.endedAt!==undefined).slice(-30);
    const keep=new Set(complete.map(o=>o.id));
    items=items.filter(o=>o.endedAt===undefined || keep.has(o.id));
    for(const key of actions.keys()) if(!items.some(o=>o.id===key)) actions.delete(key);
    notify();
  }};
}
export function trackOperation<T>(spec:OperationSpec,work:(handle:OperationHandle)=>Promise<T>,outcome?:(value:T)=>{state:Exclude<OperationState,"running"|"cancelling">;detail?:string}):Promise<T> {
  const existing=flights.get(spec.key);if(existing) return existing as Promise<T>;
  const handle=beginOperation(spec);
  if(!handle) return Promise.reject(new Error("此操作正在处理中，请稍候"));
  // 先登记 Promise 再执行，快捷键/同帧连点也共享同一次调用。
  const task=Promise.resolve().then(()=>work(handle)).then(value=>{
    const result=outcome?.(value);handle.finish(result?.state??"success",result?.detail);return value;
  }).catch(error=>{handle.finish(spec.cancelled?.(error)?"cancelled":"failed",spec.errorDetail?.(error)??String(error instanceof Error?error.message:error));throw error;}).finally(()=>flights.delete(spec.key));
  flights.set(spec.key,task);
  if(spec.retry) actions.set(handle.id,{cancel:spec.cancel,errorDetail:spec.errorDetail,reveal:spec.reveal,retry:typeof spec.retry==="function"?spec.retry:()=>trackOperation(spec,work,outcome)});
  return task;
}
export async function cancelOperation(id:number):Promise<void> {
  const o=items.find(o=>o.id===id),cancel=actions.get(id)?.cancel;
  if(!o || o.state!=="running" || !cancel) return;
  patch(id,{state:"cancelling",phase:"正在请求停止"});
  try {await cancel();const latest=items.find(o=>o.id===id);if(latest?.state==="cancelling") patch(id,{phase:"停止请求已发送，等待操作返回"});}
  catch(error){const latest=items.find(o=>o.id===id);if(latest?.state==="cancelling") patch(id,{state:"running",detail:`停止请求失败：${actions.get(id)?.errorDetail?.(error)??String(error)}`});}
}
export const canCancelOperation=(id:number)=>!!actions.get(id)?.cancel;
export async function retryOperation(id:number):Promise<void>{const item=items.find(o=>o.id===id);if(item?.state==="failed" && !operationActive(item.key)) await actions.get(id)?.retry?.();}
export const canRetryOperation=(id:number)=>!!actions.get(id)?.retry;
export const revealOperation=(id:number)=>actions.get(id)?.reveal?.();
export function clearCompletedOperations(){const keep=new Set(items.filter(o=>o.endedAt===undefined).map(o=>o.id));items=items.filter(o=>keep.has(o.id));for(const id of actions.keys()) if(!keep.has(id)) actions.delete(id);notify();}
export function updateOperation(key:string,patchValue:Parameters<OperationHandle["update"]>[0]){const o=items.find(o=>o.key===key && o.endedAt===undefined);if(o) patch(o.id,patchValue);}
/** 切工程/退出前等现有写入收尾，再检查脏文件，避免拿旧 mtime 再保存一次。 */
export function waitForFileOperations():Promise<void>{
  const pending=()=>items.some(o=>o.endedAt===undefined && (o.key.startsWith("file.save:") || o.key.startsWith("file.reload:")));
  if(!pending()) return Promise.resolve();
  return new Promise(resolve=>{const stop=subscribeOperations(()=>{if(!pending()){stop();resolve();}});});
}
