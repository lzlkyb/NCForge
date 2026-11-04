import { useEffect, useState } from "react";
import { dbApi, type Cell, type ColumnMeta } from "../../lib/dbApi";
import { claimCursor, connOf, type TableTab } from "../../lib/dbStore";
import { mdDict, type TableDict } from "../../lib/mdDict";
import { relationRows, relationQuery, openRelated, returnRelated, type Relation } from "../../lib/dbRelations";
import { trackOperation } from "../../lib/operations";
import { dbTaskSpec } from "../../lib/dbOperations";
import { setSearchForm } from "../../lib/searchStore";
import { friendlyDbError } from "../../lib/db";
import { toast } from "../ui/toast";
import { Modal } from "../ui/Modal";
export function TableRelations({tab,columns,row,onClose}:{tab:TableTab;columns:ColumnMeta[];row:Cell[];onClose:()=>void}) {
  const [state,setState]=useState<{relations:Relation[];notes:string[];dict:TableDict|null;enums:Cell[][];loading:boolean;failed:boolean}>({relations:[],notes:[],dict:null,enums:[],loading:true,failed:false});
  const [revision,setRevision]=useState(0);
  useEffect(()=>{let live=true;setState(v=>({...v,loading:true}));void (async()=>{
    // 字典查询会替换主会话游标；先失效续取状态，关闭弹窗也不会漏掉。
    claimCursor(tab.connId,null,`metadata:${tab.id}`);
    const [relations,dict]=await trackOperation(dbTaskSpec(`relations:${tab.id}`,"读取关联与 NC 元数据",tab.connId,tab.table,connOf(tab.connId)?.name,tab.id),()=>Promise.allSettled([dbApi.relations(tab.connId,tab.table),mdDict({names:[tab.table],prefix:"",keyword:""},tab.connId)]),results=>({state:results.some(r=>r.status==="rejected") ? "failed" : "success",detail:results.some(r=>r.status==="rejected") ? "部分关系或元数据未读取成功，返回关联面板查看原因" : "已读取关系与元数据"}));
    if(!live) return;
    const notes:string[]=[];let list:Relation[]=[];let metadata:TableDict|null=null;let enums:Cell[][]=[];
    if(relations.status==="fulfilled") {list=[...relationRows(relations.value.foreign,"外键"),...relationRows(relations.value.references,"NC类引用")];notes.push(...relations.value.notes);if(relations.value.enums?.kind==="rows") enums=relations.value.enums.rows;if(relations.value.sharedSession) {claimCursor(tab.connId,null,`relations:${tab.id}`);notes.push("关系查询复用了主会话，原游标已关闭。");} if((relations.value.foreign.kind==="rows" && relations.value.foreign.hasMore) || (relations.value.references.kind==="rows" && relations.value.references.hasMore)) notes.push("关系超过读取上限，清单不完整。");}
    else notes.push(friendlyDbError(relations.reason));
    if(dict.status==="fulfilled") metadata=dict.value.tables[0] ?? null;else notes.push(`NC元数据：${friendlyDbError(dict.reason)}`);
    setState({relations:list,notes,dict:metadata,enums,loading:false,failed:relations.status==="rejected" || dict.status==="rejected"});
  })();return()=>{live=false;};},[tab.connId,tab.table,tab.id,revision]);
  const open=(r:Relation)=>{try {openRelated(tab,relationQuery(r,tab.table,columns,row));onClose();}catch(e){toast(friendlyDbError(e),"error");}};
  const locate=(full:string)=>{const name=full.split(".").pop() ?? full;setSearchForm({query:name,regex:false,scope:"all"});window.dispatchEvent(new CustomEvent("ncforge-navigate",{detail:"search"}));onClose();};
  return <Modal open ariaLabel="关联记录与NC元数据" className="modal-surface dbx-relations-dialog" onClose={onClose}><h2>关联记录与 NC 元数据</h2><p>{tab.table} · 仅使用已声明的外键或明确的 NC 类引用</p>{state.loading?<p role="status">读取关系与元数据…</p>:<>
    {state.relations.map(r=><div className="dbx-relation" key={r.id}><strong>{r.source} → {r.target}</strong><span>{r.kind} · {r.from.join(" + ")} → {r.to.join(" + ")}</span><button type="button" className="dbx-btn" onClick={()=>open(r)}>打开关联记录</button></div>)}
    {!state.relations.length && <p>{state.failed ? "关系未完整读取，请查看原因后重试。" : "没有可确认的关联。仍可用「按值反查」或手写条件查询。"}</p>}
    {state.dict && <><h3>{state.dict.displayName || "实体与字段映射"}</h3>{state.dict.entities.map(e=><p key={e.fullClassName}>{e.fullClassName}<button type="button" className="dbx-btn" onClick={()=>locate(e.fullClassName)}>在工程中查找类</button></p>)}<div className="dbx-meta"><table><thead><tr><th>字段</th><th>中文名</th><th>NC 类型描述</th><th>实体属性</th></tr></thead><tbody>{state.dict.columns.map(c=><tr key={c.name}><td>{c.name}</td><td>{c.displayName}</td><td>{c.type}</td><td>{c.props.map(p=>`${p.name} ${p.displayName}`).join(" · ")}</td></tr>)}</tbody></table></div></>}
    {state.enums.length>0 && <div className="dbx-meta"><h3>业务枚举</h3><table><thead><tr><th>字段</th><th>数据库值</th><th>中文含义</th></tr></thead><tbody>{state.enums.map((e,i)=><tr key={i}><td>{String(e[0] ?? "")}</td><td>{String(e[1] ?? "NULL")}</td><td>{String(e[2] ?? "")}</td></tr>)}</tbody></table></div>}
    {state.failed && <button type="button" className="dbx-btn" onClick={()=>setRevision(v=>v+1)}>重新读取</button>}
    {state.notes.length>0 && <details><summary>读取范围与不可用原因</summary>{state.notes.map(n=><p key={n}>{n}</p>)}</details>}
  </>}<div className="dbx-filter-actions">{tab.trail?.length ? <button type="button" className="dbx-btn" onClick={()=>{if(returnRelated(tab,tab.trail![tab.trail!.length-1])) toast("来源标签已关闭，已重新打开表","info");onClose();}}>返回 {tab.trail[tab.trail.length-1].label}</button>:null}<button type="button" className="dbx-btn" onClick={onClose}>关闭</button></div></Modal>;
}
