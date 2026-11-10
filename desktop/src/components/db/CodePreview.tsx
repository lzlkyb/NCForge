import { useMemo, useState, type RefObject } from "react";
import { codeTokens } from "../../lib/codeTokens";
import { copyText } from "../../lib/utils";
import { toast } from "../ui/toast";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { SqlCodeViewer } from "./SqlCodeViewer";
import "./db-reading.css";

/** 短片段轻量高亮；仅用户展开的一个长SQL才加载编辑器。 */
export function CodePreview({text,label="SQL 预览",language="sql",className="",preRef,connId,expandable=true,copyLabel}: {
 text:string;label?:string;language?:"sql"|"json"|"text";className?:string;preRef?:RefObject<HTMLPreElement>;connId?:string;expandable?:boolean;copyLabel?:string;
}) {
 const [find,setFind]=useState(false),[query,setQuery]=useState(""),[expanded,setExpanded]=useState(false);
 const tokens=useMemo(()=>language === "text" ? [{text,kind:"plain"}] : codeTokens(text,language),[text,language]);
 const matches = useMemo(()=>{
  if(!find || !query) return [];
  const source=text.toLocaleLowerCase(), needle=query.toLocaleLowerCase(), found:{start:number;end:number}[]=[];
  for(let at=source.indexOf(needle);at>=0 && found.length<1000;at=source.indexOf(needle,at+needle.length)) found.push({start:at,end:at+needle.length});
  return found;
 },[text,find,query]);
 let offset=0,matchAt=0;
 const colored=tokens.map((token,index)=>{
  const start=offset,end=start+token.text.length;offset=end;
  while(matchAt<matches.length && matches[matchAt].end<=start)matchAt++;
  const overlaps:typeof matches=[];
  for(let i=matchAt;i<matches.length && matches[i].start<end;i++)overlaps.push(matches[i]);
  let at=0;const parts:(string|React.ReactNode)[]=[];
  overlaps.forEach((match,i)=>{const a=Math.max(0,match.start-start),b=Math.min(token.text.length,match.end-start);parts.push(token.text.slice(at,a),<mark key={i}>{token.text.slice(a,b)}</mark>);at=b;});
  parts.push(token.text.slice(at));return <span key={index} className={`dbx-token-${token.kind}`}>{parts}</span>;
 });
 return <div className="dbx-code-preview">
  <div className="dbx-code-preview-tools">
   <button type="button" className="dbx-lk" aria-label={`查找${label}`} onClick={()=>setFind(v=>!v)}><Icon name="search" size={13}/></button>
   <button type="button" className="dbx-lk" aria-label={copyLabel ?? `复制${label}`} onClick={()=>void copyText(text,()=>toast(copyLabel ? "已复制展示内容" : "已复制原文","success"),error=>toast(`复制失败：${error}`,"error"))}><Icon name="copy" size={13}/></button>
   {language === "sql" && expandable && <button type="button" className="dbx-lk" aria-label={`展开${label}`} onClick={()=>setExpanded(true)}><Icon name="expand" size={13}/></button>}
  </div>
  {find && <label className="dbx-code-find"><input autoFocus aria-label={`搜索${label}`} placeholder="查找展示内容" value={query} onChange={e=>setQuery(e.target.value)}/><span role="status">{query ? `${matches.length}${matches.length === 1000 ? "+" : ""} 处` : "输入关键词"}</span></label>}
  {language !== "text" && text.length>20000 && <p className="dbx-plan-note">前20000字符提供语法着色，原文仍完整显示与复制。</p>}
  <pre ref={preRef} tabIndex={0} className={`dbx-code-text ${className}`} aria-label={label}>{colored}</pre>
  {expanded && <Modal open onClose={()=>setExpanded(false)} className="modal-surface dbx-code-dialog" ariaLabel={label}><button type="button" className="dbx-btn" onClick={()=>setExpanded(false)}>关闭代码查看</button><SqlCodeViewer text={text} label={label} connId={connId}/></Modal>}
 </div>;
}
