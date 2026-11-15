import { invoke } from "./tauri";
import { findModel } from "./editorStore";
import { getSession } from "./workspaceSession";
import { readFile } from "./workspace";
import { workspaceEpoch } from "./workspaceEpoch";
import { applyWorkbenchPlan,type FilePlan,type WorkbenchPlan } from "./refactorWorkbench";
import { svnDiff } from "./svn";
export interface ShelfSummary{id:string;name:string;created:number;files:number;}
export const listChangeShelves=()=>invoke<ShelfSummary[]>("change_shelf_list");
export const deleteChangeShelf=(id:string)=>invoke("change_shelf_delete",{id});
export async function saveChangeShelf(name:string,paths:string[]):Promise<ShelfSummary>{
  const epoch=workspaceEpoch();const files:FilePlan[]=[];
  for(const path of paths){const content=await readFile(path);const model=findModel(path);
    if(!content.lossless||content.eol==="MIXED")throw new Error(`文件不能无损保存变更副本：${path}`);
    files.push({path,beforeText:content.text,expectedText:content.text,expectedMtimeMs:content.mtimeMs,text:model?.getValue()??content.text,delete:false,encoding:content.encoding,hasBom:content.hasBom,eol:content.eol});
  }
  if(epoch!==workspaceEpoch())throw new Error("工程已切换，未保存副本");
  return invoke<ShelfSummary>("change_shelf_create",{name,files});
}
export async function prepareShelfRestore(shelf:ShelfSummary):Promise<WorkbenchPlan>{
  const epoch=workspaceEpoch();const files=await invoke<FilePlan[]>("change_shelf_plan",{id:shelf.id});
  if(epoch!==workspaceEpoch())throw new Error("工程已切换，请重新预览副本");
  return {epoch,label:`恢复变更集 ${shelf.name}`,warnings:["恢复会写入预览中的文件；恢复前的当前编辑内容会另存为一份副本。"],files:files.map(file=>{const model=findModel(file.path);return {...file,beforeText:model?.getValue()??file.beforeText,modelVersion:model?.getVersionId()};})};
}
export async function restoreChangeShelf(shelf:ShelfSummary,plan:WorkbenchPlan){
  if(plan.epoch!==workspaceEpoch())throw new Error("工程已切换，请重新预览副本");
  // A deleted disk file may still have a newer buffer; archive the preview snapshot too.
  const files=plan.files.filter(file=>file.expectedMtimeMs!==null||file.modelVersion!==undefined).map(file=>({...file,text:file.beforeText,destination:undefined,delete:false}));
  if(files.length)await invoke<ShelfSummary>("change_shelf_create",{name:`恢复前：${shelf.name}`.slice(0,80),files});
  await applyWorkbenchPlan(plan);
}
export function shelfCandidates(){return getSession().tabs.filter(tab=>!tab.readOnly&&!tab.virtual&&!tab.deferred).map(tab=>({path:tab.path,name:tab.name,dirty:tab.dirty||tab.eolChanged}));}
/** A true shelve removes tracked-file changes only after a durable named copy exists. */
export async function prepareShelve(paths:string[]):Promise<WorkbenchPlan>{
  const epoch=workspaceEpoch(),files:FilePlan[]=[];if(!paths.length)throw new Error("请先选择需要暂存的文件");
  for(const path of paths){const disk=await readFile(path),base=await svnDiff(path),model=findModel(path);
    if(base.baseEmpty||!base.editable)throw new Error(`暂存并移开只支持有可读 SVN 基线的文件：${path}；其它文件可以保存保留当前内容的副本`);
    if(!disk.lossless||disk.eol==="MIXED"||base.workingText.replace(/\r\n/g,"\n")!==disk.text)throw new Error(`文件内容或格式已变化，请重新预览：${path}`);
    files.push({path,beforeText:model?.getValue()??disk.text,expectedText:disk.text,expectedMtimeMs:disk.mtimeMs,text:base.baseText.replace(/\r\n/g,"\n"),delete:false,encoding:disk.encoding,hasBom:disk.hasBom,eol:disk.eol,modelVersion:model?.getVersionId()});
  }
  if(epoch!==workspaceEpoch())throw new Error("工程已切换，请重新预览暂存");
  return {epoch,files,label:"暂存并移开当前修改",warnings:["先保存具名副本，再将选中文件内容恢复到 SVN 基线；文件移动、删除和未纳管文件请单独处理。"]};
}
export async function shelveChanges(name:string,plan:WorkbenchPlan){
  if(plan.epoch!==workspaceEpoch())throw new Error("工程已切换，请重新预览暂存");
  await saveChangeShelf(name,plan.files.map(file=>file.path));
  try{await applyWorkbenchPlan(plan);}catch(error){throw new Error(`变更副本已保存；移开修改未完成：${String(error)}`);}
}
