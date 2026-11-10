import { useMemo, useState, type RefObject } from "react";
import { CodePreview } from "./CodePreview";

function JsonNode({name,value,depth=0}:{name:string;value:unknown;depth?:number}) {
 const [open,setOpen]=useState(depth===0),[limit,setLimit]=useState(100);
 const compound=typeof value === "object" && value!==null;
 if(!compound) return <div className="dbx-json-leaf"><span>{name}: </span><span className={typeof value==="string"?"dbx-token-string":"dbx-token-number"}>{JSON.stringify(value)}</span></div>;
 const entries=Object.entries(value as object);
 return <details open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>{name} · {Array.isArray(value)?"数组":"对象"} · {entries.length} 项</summary>
  {open && depth<30 && entries.slice(0,limit).map(([key,item])=><JsonNode key={key} name={key} value={item} depth={depth+1}/>)}
  {open && depth>=30 && <p>层级过深，请切回格式化文本查找。</p>}
  {open && entries.length>limit && <button type="button" className="dbx-lk" onClick={()=>setLimit(v=>v+100)}>再显示100项</button>}
 </details>;
}
export function JsonInspector({text,json=true,preRef}:{text:string;json?:boolean;preRef?:RefObject<HTMLPreElement>}) {
 const [tree,setTree]=useState(false);
 const parsed=useMemo(()=>{try{return JSON.parse(text) as unknown;}catch{return null;}},[text]);
 return <>{json && <button type="button" className="dbx-btn ghost" aria-pressed={tree} onClick={()=>setTree(v=>!v)}>{tree?"格式化文本":"树形查看"}</button>}
  {tree && json?<div className="dbx-json-tree" role="region" aria-label="JSON 树"><JsonNode key={text} name="根节点" value={parsed}/></div>:<CodePreview key="code" preRef={preRef} text={text} language={json ? "json" : "text"} label="单元格完整值" copyLabel="复制展示内容"/>}
 </>;
}
