import { useEffect,useState } from "react";
import { Button } from "../ui/button";
import { listChangeShelves,saveChangeShelf,prepareShelfRestore,restoreChangeShelf,deleteChangeShelf,shelfCandidates,prepareShelve,shelveChanges,type ShelfSummary } from "../../lib/changeShelf";
import { WorkbenchEditPreview } from "./WorkbenchEditPreview";
import type { WorkbenchPlan } from "../../lib/refactorWorkbench";
import { toast } from "../ui/toast";
interface State{shelves:ShelfSummary[];name:string;paths:string[];busy:boolean;error:string;selected:ShelfSummary|null;plan:WorkbenchPlan|null;deleteId:string|null;shelving:boolean;}
export function ProjectShelfPane(){
  const candidates=shelfCandidates();const [state,set]=useState<State>({shelves:[],name:"",paths:candidates.filter(c=>c.dirty).map(c=>c.path),busy:false,error:"",selected:null,plan:null,deleteId:null,shelving:false});
  const patch=(next:Partial<State>)=>set(previous=>({...previous,...next}));
  const reload=async()=>{patch({shelves:await listChangeShelves()});};
  useEffect(()=>{let live=true;void listChangeShelves().then(shelves=>{if(live)patch({shelves});}).catch(error=>{if(live)patch({error:String(error)});});return()=>{live=false;};},[]);
  const save=async()=>{patch({busy:true,error:""});try{await saveChangeShelf(state.name,state.paths);patch({name:""});await reload();toast("变更副本已保存，当前编辑内容保留","success");}catch(error){patch({error:String(error)});}finally{patch({busy:false});}};
  const preview=async(shelf:ShelfSummary)=>{patch({busy:true,error:"",plan:null,selected:shelf,shelving:false});try{patch({plan:await prepareShelfRestore(shelf)});}catch(error){patch({error:String(error)});}finally{patch({busy:false});}};
  const restore=async()=>{if(!state.selected||!state.plan)return;patch({busy:true,error:""});try{await restoreChangeShelf(state.selected,state.plan);patch({plan:null,selected:null});await reload();}catch(error){patch({error:String(error)});}finally{patch({busy:false});}};
  const remove=async(id:string)=>{patch({busy:true,error:""});try{await deleteChangeShelf(id);patch({deleteId:null,plan:null});await reload();}catch(error){patch({error:String(error)});}finally{patch({busy:false});}};
  const previewShelve=async()=>{patch({busy:true,error:"",plan:null,selected:null,shelving:true});try{patch({plan:await prepareShelve(state.paths)});}catch(error){patch({error:String(error)});}finally{patch({busy:false});}};
  const shelve=async()=>{if(!state.plan)return;patch({busy:true,error:""});try{await shelveChanges(state.name,state.plan);patch({plan:null,name:"",shelving:false});await reload();}catch(error){patch({error:String(error)});}finally{patch({busy:false});}};
  return <div className="space-y-3"><p className="text-xs text-muted-foreground">给一组文件保存具名副本，可包含未保存编辑，关闭应用后仍可恢复。创建副本后当前修改保留；每个工程最多 20 份、合计 64 MiB。</p>
    <fieldset disabled={state.busy} className="space-y-2"><label className="block text-sm">变更集名称<input className="w-full rounded-[var(--r-control)] border border-border bg-background/70 px-2 py-1 text-sm" value={state.name} placeholder="例如 价格维护调整" onChange={e=>patch({name:e.target.value,plan:null})}/></label><div className="max-h-36 overflow-auto rounded-[var(--r-control)] border border-border p-2">{candidates.map(file=><label key={file.path} className="flex gap-2 py-1 text-xs"><input type="checkbox" checked={state.paths.includes(file.path)} onChange={e=>patch({paths:e.target.checked?[...state.paths,file.path]:state.paths.filter(p=>p!==file.path),plan:null})}/><span title={file.path}>{file.name}{file.dirty?" · 未保存":""}</span></label>)}{!candidates.length&&<p className="text-xs text-muted-foreground">先打开要纳入变更集的可编辑文件。</p>}</div><Button size="sm" disabled={!state.name.trim()||!state.paths.length} onClick={()=>void save()}>保存 {state.paths.length} 个文件的副本</Button></fieldset>
    {state.error&&<p role="alert" className="text-xs text-destructive-ink">{state.error}</p>}
    <div className="max-h-44 overflow-auto">{state.shelves.map(shelf=><div key={shelf.id} className="flex items-center gap-2 border-b border-border py-2 text-xs"><span className="flex-1">{shelf.name} · {shelf.files} 个文件 · {new Date(shelf.created).toLocaleString()}</span><Button size="sm" variant="outline" disabled={state.busy} onClick={()=>void preview(shelf)}>预览恢复</Button><Button size="sm" variant="outline" disabled={state.busy} onClick={()=>patch({deleteId:shelf.id})}>删除副本</Button></div>)}{!state.shelves.length&&<p className="text-sm text-muted-foreground">尚未保存变更副本。</p>}</div>
    {state.deleteId&&<div className="flex items-center gap-2 text-xs"><span>删除这份副本，工程文件保持当前内容。</span><Button size="sm" variant="outline" disabled={state.busy} onClick={()=>patch({deleteId:null})}>取消</Button><Button size="sm" disabled={state.busy} onClick={()=>void remove(state.deleteId!)}>确认删除副本</Button></div>}
    <Button size="sm" variant="outline" disabled={state.busy||!state.name.trim()||!state.paths.length} onClick={()=>void previewShelve()}>预览暂存并移开选中文件修改</Button>
    {state.plan&&<><WorkbenchEditPreview files={state.plan.files}/><p className="text-xs text-muted-foreground">{state.shelving?"先保存具名副本，再将所选文件恢复到 SVN 基线；支持已纳管、已有基线的文本文件。":"应用前会保存一份“恢复前”副本，随后保留文件当前编码与换行写入。"}</p><Button size="sm" disabled={state.busy||state.shelving&&!state.name.trim()} onClick={()=>void(state.shelving?shelve():restore())}>{state.shelving?`确认暂存并移开 ${state.plan.files.length} 个文件修改`:`备份当前内容并恢复 ${state.plan.files.length} 个文件`}</Button></>}
  </div>;
}

