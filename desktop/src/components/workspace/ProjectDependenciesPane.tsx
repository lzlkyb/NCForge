import { useEffect,useState } from "react";
import { Button } from "../ui/button";
import { invoke } from "../../lib/tauri";
import { effectiveClasspath,projectToolsContext,dependencyVersionConflicts,planSourceAttachment,applySourceAttachment,type ClasspathReport,type ProjectToolsContext,type ClasspathEntry } from "../../lib/projectWorkbench";
import { workspaceEpoch } from "../../lib/workspaceEpoch";
import { WorkbenchEditPreview } from "./WorkbenchEditPreview";
import { ProjectDependencyGraph } from "./ProjectDependencyGraph";
import type { FilePlan } from "../../lib/refactorWorkbench";
interface State{context:ProjectToolsContext|null;report:ClasspathReport|null;error:string;busy:boolean;entry:ClasspathEntry|null;source:string;javadoc:string;plan:FilePlan|null;epoch:number;}
const initial:State={context:null,report:null,error:"",busy:false,entry:null,source:"",javadoc:"",plan:null,epoch:0};
export function ProjectDependenciesPane(){
  const [state,set]=useState<State>(initial);const patch=(next:Partial<State>)=>set(previous=>({...previous,...next}));
  const reload=async()=>{patch({busy:true,error:"",plan:null});const epoch=workspaceEpoch();
    const results=await Promise.allSettled([projectToolsContext(),effectiveClasspath()]);if(epoch!==workspaceEpoch())return;
    patch({context:results[0].status==="fulfilled"?results[0].value:null,report:results[1].status==="fulfilled"?results[1].value:null,error:results.filter(r=>r.status==="rejected").map(r=>String((r as PromiseRejectedResult).reason)).join("；"),busy:false,epoch});
  };
  useEffect(()=>{let live=true;const epoch=workspaceEpoch();set(previous=>({...previous,busy:true}));
    void Promise.allSettled([projectToolsContext(),effectiveClasspath()]).then(results=>{if(!live||epoch!==workspaceEpoch())return;set(previous=>({...previous,context:results[0].status==="fulfilled"?results[0].value:null,report:results[1].status==="fulfilled"?results[1].value:null,error:results.filter(r=>r.status==="rejected").map(r=>String((r as PromiseRejectedResult).reason)).join("；"),busy:false,epoch}));});
    return()=>{live=false;};
  },[]);
  const preview=async()=>{if(!state.entry)return;patch({busy:true,error:"",plan:null});try{patch({plan:await planSourceAttachment(state.entry.path,state.source,state.javadoc),epoch:workspaceEpoch()});}catch(error){patch({error:String(error)});}finally{patch({busy:false});}};
  const apply=async()=>{if(!state.plan||!state.entry)return;patch({busy:true,error:""});try{await applySourceAttachment(state.plan,state.epoch,state.entry.path,state.source,state.javadoc);await reload();}catch(error){patch({error:String(error)});}finally{patch({busy:false});}};
  const pick=async()=>{try{const path=await invoke<string|null>("pick_file",{title:"选择同版本源码附件",extensions:["jar","zip"]});if(path)patch({source:path,plan:null});}catch(error){patch({error:String(error)});}};
  const field="w-full rounded-[var(--r-control)] border border-border bg-background/70 px-2 py-1 text-xs";
  const issues=[...(state.report?.issues??[]),...dependencyVersionConflicts(state.report?.entries??[])];
  return <div className="space-y-3"><div className="flex items-center justify-between"><p className="text-xs text-muted-foreground">当前模块实际使用的类路径；可据此核对 hyext 的类是否参加语义导航。</p><Button size="sm" variant="outline" disabled={state.busy} onClick={()=>void reload()}>{state.busy?"读取中…":"重新读取"}</Button></div>
    {state.error&&<p role="alert" className="text-xs text-destructive-ink">{state.error}</p>}
    {state.report&&<div className="max-h-56 overflow-auto rounded-[var(--r-control)] border border-border"><table className="w-full text-left text-xs"><thead><tr className="bg-muted"><th className="p-2">来源</th><th className="p-2">路径 / 源码 / 文档</th><th/></tr></thead><tbody>{state.report.entries.map((entry,i)=><tr key={`${entry.path}-${i}`} className="border-t border-border"><td className="p-2 align-top">{entry.kind===1?"依赖库":entry.kind===3?"源码根":"工程容器"}</td><td className="break-all p-2">{entry.path}{entry.source&&<div className="text-muted-foreground">源码：{entry.source}</div>}{entry.javadoc&&<div className="text-muted-foreground">文档：{entry.javadoc}</div>}</td><td className="p-2">{entry.kind===1&&/\.jar$/i.test(entry.path)&&<Button size="sm" variant="outline" disabled={state.busy} onClick={()=>patch({entry,source:entry.source,javadoc:entry.javadoc,plan:null})}>关联</Button>}</td></tr>)}</tbody></table></div>}
    {issues.map((issue,i)=><p key={i} className="text-xs text-warning-ink">{issue}</p>)}
    {state.entry&&<fieldset disabled={state.busy} className="space-y-2 rounded-[var(--r-control)] border border-border p-3"><p className="break-all text-xs">关联 {state.entry.path}</p><label className="block text-xs">同版本源码附件（JAR / ZIP）<div className="flex gap-2"><input className={field} value={state.source} onChange={e=>patch({source:e.target.value,plan:null})}/><Button variant="outline" size="sm" onClick={()=>void pick()}>选择</Button></div></label><label className="block text-xs">Javadoc 地址<input className={field} value={state.javadoc} placeholder="https://… 或 file://…" onChange={e=>patch({javadoc:e.target.value,plan:null})}/></label><p className="text-xs text-muted-foreground">配置保存到工程 .classpath。未显式列出的 JAR 会增加一条库条目，请核对预览；源码附件须位于工程、关联工程或 NC 目录内。</p><Button size="sm" variant="outline" onClick={()=>void preview()}>预览关联配置</Button>{state.plan&&<><WorkbenchEditPreview files={[state.plan]}/><Button size="sm" onClick={()=>void apply()}>保存关联配置</Button></>}</fieldset>}
    {state.context&&<ProjectDependencyGraph context={state.context}/>}
  </div>;
}

