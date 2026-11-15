import { useSyncExternalStore } from "react";
import { invoke,listen } from "./tauri";
import { registerCommands } from "./commandRegistry";
import { getSession,setSession } from "./workspaceSession";
import { workspaceEpoch } from "./workspaceEpoch";
import { langRequest,flushDoc,langReady,inLangModule,loadJdtSource } from "./lang";
import { tabMetaFromJdt } from "./tabSession";
import type { LinkedProject } from "./linkedProjects";
import { findModel,openVirtualModel } from "./editorStore";
import { libraryTabMeta,parseLibraryUri,readLibraryFile,sameLibrarySource } from "./libraryFiles";
import { applyWorkbenchPlan,type FilePlan } from "./refactorWorkbench";
import type { JavaRunResult } from "./javaRun";
export type ProjectPane="dependencies"|"build"|"shelf";
let pane:ProjectPane|null=null;const listeners=new Set<()=>void>();
export const useProjectWorkbench=()=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};},()=>pane,()=>pane);
export function openProjectWorkbench(next:ProjectPane){pane=next;listeners.forEach(fn=>fn());}
export function closeProjectWorkbench(){pane=null;listeners.forEach(fn=>fn());}
export function registerProjectWorkbenchCommands(){return registerCommands([
  {id:"project.dependencies",title:"工程类路径 / 源码附件 / 依赖图",run:()=>openProjectWorkbench("dependencies")},
  {id:"project.buildtools",title:"工程终端 / Maven / Gradle",run:()=>openProjectWorkbench("build")},
  {id:"project.shelf",title:"变更集 / 保存与恢复搁置副本",run:()=>openProjectWorkbench("shelf")},
]);}
export interface ProjectEdge{from:string;to:string;exported:boolean;}
export interface ProjectToolsContext{root:string;maven:boolean;gradle:boolean;projects:LinkedProject[];edges:ProjectEdge[];}
export interface ClasspathEntry{path:string;kind:number;exported:boolean;source:string;javadoc:string;}
export interface ClasspathReport{project:string;entries:ClasspathEntry[];issues:string[];}
export const projectToolsContext=()=>invoke<ProjectToolsContext>("project_tools_context");
function projectJavaPath(){const session=getSession();return session.tabs.find(t=>t.path===session.activePath&&!t.readOnly&&inLangModule(t.path))?.path??session.tabs.find(t=>!t.readOnly&&inLangModule(t.path))?.path;}
export async function effectiveClasspath():Promise<ClasspathReport>{
  const path=projectJavaPath(),epoch=workspaceEpoch();if(!path||!langReady())throw new Error("先打开当前模块的 Java 文件，等待代码智能就绪后查看有效类路径");
  await flushDoc(path);const report=await langRequest<ClasspathReport>("workspace/executeCommand",path,{command:"ncforge.projectClasspath",arguments:[{uri:"",mode:"read"}]},30000);
  if(epoch!==workspaceEpoch())throw new Error("工程已切换，请重新读取类路径");return report;
}
export function dependencyVersionConflicts(entries:ClasspathEntry[]):string[]{
  const versions=new Map<string,Set<string>>();
  for(const entry of entries){if(entry.kind!==1)continue;const name=entry.path.replace(/\\/g,"/").split("/").pop()??"";
    const match=/^(.+?)[-_](\d+(?:\.\d+)+[^/]*)\.jar$/i.exec(name);if(!match)continue;
    const key=match[1].toLowerCase();if(!versions.has(key))versions.set(key,new Set());versions.get(key)!.add(name);
  }
  return [...versions].filter(([,values])=>values.size>1).map(([artifact,values])=>`同一库存在多个版本候选：${artifact} · ${[...values].join(" / ")}；请核对类路径顺序`);
}
export async function planSourceAttachment(jar:string,source:string,javadoc:string):Promise<FilePlan>{
  const epoch=workspaceEpoch();const plan=await invoke<FilePlan>("project_plan_attachment",{jar,source,javadoc});
  if(epoch!==workspaceEpoch())throw new Error("工程已切换，请重新生成附件预览");
  const model=findModel(plan.path);if(model&&model.getValue()!==plan.beforeText)throw new Error(".classpath 有未保存编辑，请先保存后配置附件");
  return {...plan,modelVersion:model?.getVersionId()};
}
export async function applySourceAttachment(file:FilePlan,epoch:number,jar:string,source:string,javadoc:string){
  await applyWorkbenchPlan({files:[file],warnings:[],epoch,label:"源码附件与 Javadoc 关联"});
  const path=projectJavaPath();if(path&&langReady()&&epoch===workspaceEpoch()){
    try{await langRequest("workspace/executeCommand",path,{command:"ncforge.projectClasspath",arguments:[{uri:"",mode:"attach",jar,source,javadoc}]},30000);}
    catch(error){throw new Error(`工程配置已保存；当前模块即时关联失败，请重启代码智能读取附件：${String(error)}`);}
    const archive=jar.replace(/\\/g,"/").split("/").pop()?.toLowerCase();
    const open=getSession().tabs.filter(tab=>{try{return tab.path.startsWith("jdt://")&&decodeURIComponent(tab.path.split("?")[0]).toLowerCase().includes(`/${archive}/`);}catch{return false;}});
    // An already-open decompiled model has its own cache; refresh it after attachment.
    for(const tab of open){if(epoch!==workspaceEpoch())return;const result=await loadJdtSource(tab.path,false,true);if(epoch!==workspaceEpoch())return;
      setSession({tabs:tabs=>tabs.map(current=>current.path===tab.path?{...current,...tabMetaFromJdt(tab.path,result.text,result.decompiled),preview:current.preview,pinned:current.pinned}:current)});
    }
  }
  // Search results use nc-library URLs rather than the JDT cache; refresh those too.
  for(const tab of getSession().tabs){const target=parseLibraryUri(tab.path);if(!target||!target.archive||!sameLibrarySource(target.source,jar)||!target.entry.endsWith(".class"))continue;
    if(epoch!==workspaceEpoch())return;const result=await readLibraryFile(target);if(epoch!==workspaceEpoch())return;
    openVirtualModel(tab.path,result.text,{language:"java",replace:true});
    setSession({tabs:tabs=>tabs.map(current=>current.path===tab.path?{...current,...libraryTabMeta(tab.path,target,result),preview:current.preview,pinned:current.pinned}:current)});
  }
}
interface ToolRun{running:boolean;id:string|null;root:string;log:string[];error:string;result:JavaRunResult|null;}
let run:ToolRun={running:false,id:null,root:"",log:[],error:"",result:null};const runListeners=new Set<()=>void>();
const setRun=(patch:Partial<ToolRun>)=>{run={...run,...patch};runListeners.forEach(fn=>fn());};
export const useProjectToolRun=()=>useSyncExternalStore(fn=>{runListeners.add(fn);return()=>{runListeners.delete(fn);};},()=>run,()=>run);
export async function runProjectTool(tool:"maven"|"gradle",action:string){
  if(run.running)return;if(getSession().tabs.some(t=>t.dirty||t.eolChanged))throw new Error("请先保存修改，再运行工程构建任务");
  const root=getSession().root,epoch=workspaceEpoch();if(!root)throw new Error("尚未打开工程");
  const id=`tool-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;setRun({running:true,id,root,log:[],error:"",result:null});
  let off:(()=>void)|undefined;
  try{off=await listen<{id:string;text:string}>("java-run-log",event=>{if(event.id===id)setRun({log:[...run.log,...event.text.replace(/\r\n/g,"\n").split("\n")].slice(-1500)});});
    if(epoch!==workspaceEpoch())throw new Error("工程已切换，请重新执行任务");
    setRun({result:await invoke<JavaRunResult>("project_run_tool",{id,tool,action})});
  }catch(error){setRun({error:String(error)});}finally{off?.();setRun({running:false});}
}
export const stopProjectTool=()=>run.id?invoke("project_stop_tool",{id:run.id}):Promise.resolve();
export const openProjectTerminal=()=>invoke("project_open_terminal");
