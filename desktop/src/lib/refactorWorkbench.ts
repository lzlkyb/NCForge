import { useSyncExternalStore } from "react";
import { registerCommands } from "./commandRegistry";
import { currentSelection } from "./editorActions";
import { findModel, pathOfModel, markSaved, renameModel, closeModel } from "./editorStore";
import { flushDoc, langRequest, langReady } from "./lang";
import { workspaceEpoch } from "./workspaceEpoch";
import { getSession, setSession } from "./workspaceSession";
import { readFile, baseName, type FileContent, type Eol, type TextEncoding } from "./workspace";
import { invoke } from "./tauri";
import { captureLocalHistory } from "./localHistory";
import { toast } from "../components/ui/toast";
import { parseWorkspaceEdit, plannedText, editPathKey, normalizedEditText, type SemanticEditResponse } from "./workspaceEditPlan";
import type { EditorGroups } from "./editorGroups";

export type WorkbenchRefactor = "inlineVariable" | "inlineMethod" | "moveType" | "renamePackage" | "visibility" | "signature" | "structure" | "batchFix";
export const REFACTOR_LABELS: Record<WorkbenchRefactor,string> = {inlineVariable:"内联变量",inlineMethod:"内联方法",moveType:"移动类到包",renamePackage:"移动或重命名包",visibility:"调整可见性",signature:"修改方法签名",structure:"结构化搜索替换",batchFix:"批量检查与修复"};
export interface SignatureParameter {index:number; name:string; type:string; value:string;}
export interface SignatureInfo {name:string; parameters:SignatureParameter[]; constructor:boolean;}
export interface RefactorContext {path:string; line:number; character:number; length:number; epoch:number; modelVersion:number;}
export interface FilePlan {
  path:string; beforeText:string; expectedText:string; expectedMtimeMs:number|null; text:string; destination?:string; delete:boolean;
  encoding:TextEncoding; hasBom:boolean; eol:Eol; modelVersion?:number;
}
export interface WorkbenchPlan {files:FilePlan[]; warnings:string[]; epoch:number; label:string; matches?:SemanticEditResponse["matches"];}
interface State {kind:WorkbenchRefactor|null; context:RefactorContext|null;}
let state:State={kind:null,context:null}; const listeners=new Set<()=>void>();
function publish(next:State) {state=next;listeners.forEach(fn=>fn());}
export const subscribeRefactorWorkbench=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
export const useRefactorWorkbench=()=>useSyncExternalStore(subscribeRefactorWorkbench,()=>state,()=>state);
export function closeRefactorWorkbench() {publish({kind:null,context:null});}
export function openRefactorWorkbench(kind:WorkbenchRefactor) {
  const selection=currentSelection(),path=selection?pathOfModel(selection.model):undefined;
  if (!selection || !path || selection.readOnly || selection.model.getLanguageId()!=="java") {toast("请先在可编辑的 Java 文件中选择目标", "info");return;}
  const start=selection.model.getOffsetAt({lineNumber:selection.start.line,column:selection.start.column});
  const end=selection.model.getOffsetAt({lineNumber:selection.end.line,column:selection.end.column});
  publish({kind,context:{path,line:selection.start.line-1,character:selection.start.column-1,length:end-start,epoch:workspaceEpoch(),modelVersion:selection.model.getVersionId()}});
}
export function registerRefactorWorkbenchCommands():()=>void {
  return registerCommands((Object.keys(REFACTOR_LABELS) as WorkbenchRefactor[]).map(kind=>({id:`refactor.workbench.${kind}`,title:REFACTOR_LABELS[kind],run:()=>openRefactorWorkbench(kind),enabled:()=>langReady()})));
}
function assertContext(context:RefactorContext) {
  const model=findModel(context.path);
  if (workspaceEpoch()!==context.epoch || !model || model.isDisposed() || model.getVersionId()!==context.modelVersion) throw new Error("文件或工程已改变，请关闭并重新执行");
}
export async function refactorRequest<T>(context:RefactorContext,command:string,args:Record<string,unknown>):Promise<T> {
  assertContext(context);await flushDoc(context.path);assertContext(context);
  const response=await langRequest<T>("workspace/executeCommand",context.path,{command,arguments:[{uri:"",line:context.line,character:context.character,length:context.length,...args}]},60000);
  assertContext(context);return response;
}
export async function prepareWorkbenchPlan(context:RefactorContext,response:SemanticEditResponse,label:string):Promise<WorkbenchPlan> {
  assertContext(context); const parsed=parseWorkspaceEdit(response),files:FilePlan[]=[];
  for (const group of parsed.groups) {
    const resource=parsed.resources.find(r=>editPathKey(r.path)===editPathKey(group.path));
    const created=resource?.kind==="create",model=findModel(group.path);
    const disk:FileContent=created?{text:"",mtimeMs:0,encoding:"UTF-8",hasBom:false,eol:"LF",lossless:true,size:0}:await readFile(group.path);
    const generated=parsed.before.get(editPathKey(group.path));
    const original=model?.getValue() ?? disk.text;
    if (!created && model) {
      const tab=getSession().tabs.find(t=>editPathKey(t.path)===editPathKey(group.path));
      // The server snapshot describes the buffer, not the disk baseline it was opened from.
      if (tab ? tab.mtimeMs!==disk.mtimeMs : normalizedEditText(original)!==normalizedEditText(disk.text)) throw new Error(`文件存在外部修改，请先比较并重新加载：${group.path}`);
    }
    if (!created && generated===undefined) throw new Error(`重构缺少输入快照：${group.path}；不能安全应用旧坐标`);
    if (generated!==undefined && normalizedEditText(original)!==generated) throw new Error(`预览期间文件已改变：${group.path}`);
    if (!disk.lossless || disk.eol==="MIXED") throw new Error(`文件编码或换行不能无损改写：${group.path}`);
    files.push({path:group.path,beforeText:original,expectedText:disk.text,expectedMtimeMs:created?null:disk.mtimeMs,text:plannedText(original,group),destination:resource?.destination,delete:resource?.kind==="delete",encoding:disk.encoding,hasBom:disk.hasBom,eol:disk.eol,modelVersion:model?.getVersionId()});
  }
  assertContext(context);
  return {files,warnings:parsed.warnings,epoch:context.epoch,label,matches:response.matches};
}
export async function applyWorkbenchPlan(plan:WorkbenchPlan):Promise<void> {
  const assertPlan=()=>{
    if (workspaceEpoch()!==plan.epoch) throw new Error("工程已切换，请重新预览");
    for (const file of plan.files) {
      const model=findModel(file.path);
      if ((file.modelVersion!==undefined && (!model || model.getVersionId()!==file.modelVersion)) || (model && normalizedEditText(model.getValue())!==normalizedEditText(file.beforeText))) throw new Error(`预览后编辑器内容已改变：${file.path}`);
    }
  };
  assertPlan();
  for (const file of plan.files) if (file.expectedMtimeMs!==null) await captureLocalHistory(file.path);
  // Archiving awaits IO; repeat the snapshot checks immediately before the transaction.
  assertPlan();
  const outcome=await invoke<{written:string[];renamed:[string,string][];deleted:string[]}>("workspace_apply_edit",{edits:plan.files});
  if (workspaceEpoch()!==plan.epoch) {toast("重构已写入原工程，当前工程已切换；返回原工程查看结果", "warning");return;}
  const deferred:string[]=[],retainedDeletes=new Set<string>(),updates=new Map<string,{path:string;mtimeMs:number;dirty:boolean}>();
  for (const file of plan.files) {
    const tab=getSession().tabs.find(t=>editPathKey(t.path)===editPathKey(file.path));
    const actualPath=tab?.path ?? file.path,target=file.destination ?? actualPath;
    const disk=file.delete?null:await readFile(target).catch(()=>null);
    if(workspaceEpoch()!==plan.epoch){toast("重构已写入原工程，当前工程已切换；返回原工程查看结果","warning");return;}
    const model=findModel(file.path);
    const changed=model && normalizedEditText(model.getValue())!==normalizedEditText(file.beforeText);
    const diverged=!file.delete&&(!disk||normalizedEditText(disk.text)!==normalizedEditText(file.text));
    if (changed||diverged) deferred.push(target);
    if (file.delete) {
      if (changed) {retainedDeletes.add(editPathKey(actualPath));updates.set(editPathKey(actualPath),{path:actualPath,mtimeMs:0,dirty:true});}
      else closeModel(actualPath);
      continue;
    }
    // Moving a file also moves a newer buffer; its contents must survive the path change.
    if (file.destination) renameModel(actualPath,file.destination);
    const nextModel=findModel(target);
    if (nextModel && !changed && !diverged) {nextModel.pushEditOperations([],[{range:nextModel.getFullModelRange(),text:file.text}],()=>null);markSaved(target);}
    updates.set(editPathKey(actualPath),{path:target,mtimeMs:diverged?tab?.mtimeMs??0:disk?.mtimeMs??0,dirty:!!changed||diverged});
  }
  const move=(path:string|null)=>path?outcome.renamed.find(([from])=>editPathKey(from)===editPathKey(path))?.[1] ?? path:path;
  const groups=getSession().editorGroups;
  const moveGroups=(groups:EditorGroups):EditorGroups=>({...groups,left:groups.left.map(p=>move(p)!),right:groups.right.map(p=>move(p)!),recent:groups.recent.map(p=>move(p)!),leftActive:move(groups.leftActive),rightActive:move(groups.rightActive)});
  setSession({activePath:move(getSession().activePath),splitPath:move(getSession().splitPath),...(groups?{editorGroups:moveGroups(groups)}:{}),tabs:tabs=>tabs.filter(t=>retainedDeletes.has(editPathKey(t.path))||!outcome.deleted.some(p=>editPathKey(p)===editPathKey(t.path))).map(t=>{const update=updates.get(editPathKey(t.path));return update?{...t,...update,name:baseName(update.path),eolChanged:update.dirty?t.eolChanged:false}:t;})});
  window.dispatchEvent(new CustomEvent("workspace-edit-applied",{detail:outcome}));
  if (deferred.length) toast(`已写入 ${outcome.written.length} 个文件；${deferred.length} 个编辑器在写入期间有新修改，已保留，请比较磁盘版本`,"warning");
  else toast(`${plan.label}完成：已写入 ${outcome.written.length} 个文件`,"success");
}
