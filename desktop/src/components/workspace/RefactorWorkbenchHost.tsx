import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { navigate } from "../../lib/lang";
import { uriToPath } from "../../lib/langConvert";
import { useRefactorWorkbench, closeRefactorWorkbench, refactorRequest, prepareWorkbenchPlan, applyWorkbenchPlan, REFACTOR_LABELS, type SignatureInfo, type SignatureParameter, type WorkbenchPlan } from "../../lib/refactorWorkbench";
import type { SemanticEditResponse } from "../../lib/workspaceEditPlan";
import { WorkbenchEditPreview } from "./WorkbenchEditPreview";

interface Options {target:string;name:string;parameters:SignatureParameter[];pattern:string;replacement:string;scope:string;replace:boolean;}
interface BatchResponse extends SemanticEditResponse {issues?:{uri:string;line:number;column:number;severity:string;message:string}[];}
const initial:Options={target:"",name:"",parameters:[],pattern:"$value$ == null",replacement:"java.util.Objects.isNull($value$)",scope:"file",replace:false};
export function RefactorWorkbenchHost() {
  const {kind,context}=useRefactorWorkbench();
  const liveContext=useRef(context);liveContext.current=context;
  const [options,setOptions]=useState<Options>(initial),[plan,setPlan]=useState<WorkbenchPlan|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[report,setReport]=useState<BatchResponse|null>(null);
  useEffect(()=>{
    let live=true;setOptions(initial);setPlan(null);setError("");setReport(null);setBusy(false);
    if(kind==="signature"&&context){setBusy(true);void refactorRequest<SignatureInfo>(context,"ncforge.signatureWorkbench",{mode:"info"}).then(info=>{
      if(live)setOptions({...initial,name:info.name,parameters:info.parameters});
    }).catch(error=>{if(live)setError(String(error));}).finally(()=>{if(live)setBusy(false);});}
    return()=>{live=false;};
  },[kind,context]);
  if(!kind||!context)return null;
  const change=(patch:Partial<Options>)=>{setOptions(previous=>({...previous,...patch}));setPlan(null);setReport(null);setError("");};
  const preview=async(fix=false)=>{
    setBusy(true);setError("");setPlan(null);setReport(null);
    try{
      const command=kind==="signature"?"ncforge.signatureWorkbench":kind==="structure"?"ncforge.structuralSearch":kind==="batchFix"?"ncforge.batchInspect":"ncforge.refactorWorkbench";
      const args=kind==="signature"?{name:options.name,parameters:options.parameters}:kind==="structure"?{scope:options.scope,pattern:options.pattern,...(options.replace?{replacement:options.replacement}:{})}:kind==="batchFix"?{scope:options.scope,mode:fix?"organizeImports":"inspect"}:{kind,target:options.target||(kind==="visibility"?"public":"")};
      const response=await refactorRequest<BatchResponse>(context,command,args);
      if(liveContext.current!==context)return;
      setReport(response);const result=await prepareWorkbenchPlan(context,response,REFACTOR_LABELS[kind]);if(liveContext.current!==context)return;setPlan(result);
      if(!result.files.length&&!response.matches?.length&&!response.issues?.length)setError("本次没有找到问题、匹配或可应用的改动");
    }catch(error){if(liveContext.current===context)setError(String(error));}finally{if(liveContext.current===context)setBusy(false);}
  };
  const apply=async()=>{if(!plan?.files.length)return;setBusy(true);setError("");try{await applyWorkbenchPlan(plan);if(liveContext.current===context)closeRefactorWorkbench();}catch(error){if(liveContext.current===context)setError(String(error));}finally{if(liveContext.current===context)setBusy(false);}};
  const updateParameter=(index:number,patch:Partial<SignatureParameter>)=>change({parameters:options.parameters.map((p,i)=>i===index?{...p,...patch}:p)});
  const moveParameter=(index:number,delta:number)=>{const next=[...options.parameters],other=index+delta;if(other<0||other>=next.length)return;[next[index],next[other]]=[next[other],next[index]];change({parameters:next});};
  const open=(uri:string,line:number,column=1)=>{const path=uriToPath(uri);if(path)navigate({kind:"file",path,line,column});};
  const field="w-full rounded-[var(--r-control)] border border-border bg-background/70 px-2 py-1 text-sm";
  return <Modal open ariaLabel={REFACTOR_LABELS[kind]} onClose={()=>{if(!busy)closeRefactorWorkbench();}} className="w-full max-w-3xl rounded-[var(--r-dialog)] modal-surface p-5">
    <h3 className="mb-2 text-base font-semibold">{REFACTOR_LABELS[kind]}</h3>
    <p className="mb-3 break-all text-xs text-muted-foreground">{context.path} · 先预览完整清单，确认后保留原编码与换行写入；写入包含清单中文件的当前编辑内容。</p>
    <fieldset disabled={busy} className="space-y-3">
      {(kind==="moveType"||kind==="renamePackage")&&<label className="block text-sm">目标包名<input autoFocus className={field} value={options.target} placeholder="例如 nc.ui.custom" onChange={e=>change({target:e.target.value})}/></label>}
      {kind==="visibility"&&<label className="block text-sm">新的可见性<select className={field} value={options.target||"public"} onChange={e=>change({target:e.target.value})}><option value="public">public</option><option value="protected">protected</option><option value="private">private</option><option value="package">包可见</option></select></label>}
      {kind==="signature"&&<>
        <label className="block text-sm">方法名称<input className={field} value={options.name} onChange={e=>change({name:e.target.value})}/></label>
        <div className="max-h-56 overflow-auto"><table className="w-full text-left text-xs"><thead><tr><th>参数名</th><th>类型</th><th>新参数的默认表达式</th><th>顺序</th></tr></thead><tbody>{options.parameters.map((p,i)=><tr key={`${p.index}-${i}`}>
          <td><input aria-label={`参数 ${i+1} 名称`} className={field} value={p.name} onChange={e=>updateParameter(i,{name:e.target.value})}/></td>
          <td><input aria-label={`参数 ${i+1} 类型`} className={field} value={p.type} onChange={e=>updateParameter(i,{type:e.target.value})}/></td>
          <td>{p.index<0?<input aria-label={`参数 ${i+1} 默认表达式`} className={field} value={p.value} onChange={e=>updateParameter(i,{value:e.target.value})}/>:<span className="px-2 text-muted-foreground">保留原调用实参</span>}</td>
          <td className="whitespace-nowrap"><button type="button" className="wb-status-btn" disabled={i===0} onClick={()=>moveParameter(i,-1)}>上移</button><button type="button" className="wb-status-btn" disabled={i===options.parameters.length-1} onClick={()=>moveParameter(i,1)}>下移</button><button type="button" className="wb-status-btn" onClick={()=>change({parameters:options.parameters.filter((_,n)=>n!==i)})}>移除</button></td>
        </tr>)}</tbody></table></div>
        <Button variant="outline" size="sm" onClick={()=>change({parameters:[...options.parameters,{index:-1,name:`param${options.parameters.length+1}`,type:"String",value:'""'}]})}>新增参数</Button>
      </>}
      {(kind==="structure"||kind==="batchFix")&&<label className="block text-sm">检查范围<select className={field} value={options.scope} onChange={e=>change({scope:e.target.value})}><option value="file">当前文件</option><option value="module">当前语言服务模块的全部源码</option></select></label>}
      {kind==="structure"&&<>
        <label className="block text-sm">Java 结构模板<textarea className={field} rows={2} value={options.pattern} onChange={e=>change({pattern:e.target.value})}/></label>
        <p className="text-xs text-muted-foreground">用 $变量$ 捕获表达式，例如 $value$ == null；同名捕获必须相同。结构匹配忽略空格，不搜索注释。</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={options.replace} onChange={e=>change({replace:e.target.checked})}/>生成替换预览</label>
        {options.replace&&<label className="block text-sm">替换模板<textarea className={field} rows={2} value={options.replacement} onChange={e=>change({replacement:e.target.value})}/></label>}
      </>}
    </fieldset>
    {error&&<p className="mt-3 text-sm text-destructive-ink" role="alert">{error}</p>}
    {report?.filesScanned!==undefined&&<p className="mt-3 text-xs text-muted-foreground">已检查 {report.filesScanned} 个文件{report.issues?`，${report.issues.length} 个问题`:report.matches?`，${report.matches.length} 处结构匹配`:""}</p>}
    {!!report?.issues?.length&&<div className="mt-2 max-h-40 overflow-auto">{report.issues.map((issue,i)=><button key={i} type="button" className="block w-full rounded-[var(--r-control)] px-2 py-1 text-left text-xs hover:bg-accent" onClick={()=>open(issue.uri,issue.line,issue.column)}>{issue.severity==="error"?"错误":"提示"} · {issue.line} 行 · {issue.message}</button>)}</div>}
    {!!report?.matches?.length&&<div className="mt-2 max-h-32 overflow-auto">{report.matches.map((hit,i)=><button key={i} type="button" className="block w-full px-2 py-1 text-left text-xs hover:bg-accent" onClick={()=>open(hit.uri,hit.range.start.line+1,hit.range.start.character+1)}>{hit.uri.split("/").pop()}:{hit.range.start.line+1} · {hit.text}</button>)}</div>}
    {!!plan?.files.length&&<WorkbenchEditPreview files={plan.files}/>}
    {plan?.warnings.map((warning,i)=><p key={i} className="mt-2 text-xs text-warning-ink">{warning}</p>)}
    <div className="mt-4 flex flex-wrap justify-end gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={closeRefactorWorkbench}>关闭</Button><Button variant="outline" size="sm" disabled={busy} onClick={()=>void preview()}>{busy?"计算中…":kind==="batchFix"?"检查问题":"生成预览"}</Button>{kind==="batchFix"&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>void preview(true)}>预览批量整理导入</Button>}<Button size="sm" disabled={busy||!plan?.files.length} onClick={()=>void apply()}>应用并写入 {plan?.files.length??0} 个文件</Button></div>
  </Modal>;
}

