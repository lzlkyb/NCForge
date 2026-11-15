import { useEffect,useState } from "react";
import { Button } from "../ui/button";
import { projectToolsContext,useProjectToolRun,runProjectTool,stopProjectTool,openProjectTerminal,type ProjectToolsContext } from "../../lib/projectWorkbench";
export function ProjectBuildPane(){
  const [context,setContext]=useState<ProjectToolsContext|null>(null),[error,setError]=useState("");const run=useProjectToolRun();
  useEffect(()=>{let live=true;void projectToolsContext().then(value=>{if(live)setContext(value);}).catch(error=>{if(live)setError(String(error));});return()=>{live=false;};},[]);
  const start=async(tool:"maven"|"gradle",action:string)=>{setError("");try{await runProjectTool(tool,action);}catch(error){setError(String(error));}};
  const terminal=async()=>{try{await openProjectTerminal();}catch(error){setError(String(error));}};
  return <div className="space-y-3"><p className="break-all text-xs text-muted-foreground">{context?.root??"读取工程…"} · 优先使用工程自带 Wrapper，运行结果会保留到下次任务开始。</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={()=>void terminal()}>在工程目录打开终端</Button>{run.running&&<Button variant="outline" size="sm" onClick={()=>void stopProjectTool().catch(error=>setError(String(error)))}>停止任务</Button>}</div>
    {context?.maven&&<div className="flex flex-wrap items-center gap-2 text-sm"><span>Maven</span>{["compile","test","package"].map(action=><Button key={action} size="sm" variant="outline" disabled={run.running} onClick={()=>void start("maven",action)}>{action}</Button>)}</div>}
    {context?.gradle&&<div className="flex flex-wrap items-center gap-2 text-sm"><span>Gradle</span>{["classes","test","build"].map(action=><Button key={action} size="sm" variant="outline" disabled={run.running} onClick={()=>void start("gradle",action)}>{action}</Button>)}</div>}
    {context&&!context.maven&&!context.gradle&&<p className="text-sm text-muted-foreground">工程根没有 Maven / Gradle 构建文件，继续使用现有 NC 编译入口；需要其它命令时打开终端。</p>}
    {(error||run.error)&&<p role="alert" className="text-xs text-destructive-ink">{error||run.error}</p>}
    {run.id&&<p className="text-xs">{run.running?"任务运行中…":run.result?.cancelled?"任务已取消":run.result?.ok?"任务成功":run.result?`任务失败 · 退出码 ${run.result.exitCode??"未知"}`:"任务未完成"}{run.result?` · ${run.result.durationMs} ms`:""}</p>}
    {!!run.log.length&&<pre aria-label="工程工具输出" className="max-h-80 overflow-auto rounded-[var(--r-control)] border border-border bg-background/70 p-3 text-xs">{run.log.join("\n")}</pre>}
  </div>;
}

