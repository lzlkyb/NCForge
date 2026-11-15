import { useState } from "react";
import { collapseDiff, countChanges, diffLines } from "../../lib/textDiff";
import type { FilePlan } from "../../lib/refactorWorkbench";

function FileChanges({ file }: { file:FilePlan }) {
  const [open,setOpen]=useState(false);
  const diff=open?diffLines(file.beforeText,file.delete?"":file.text):null;
  const counts=diff?countChanges(diff.rows):null;
  return <details onToggle={e=>setOpen(e.currentTarget.open)} className="border-b border-border px-2 py-1 last:border-b-0">
    <summary className="cursor-pointer break-all text-xs">{file.delete?"删除":file.destination?"移动":"修改"} · {file.path}{file.destination?` → ${file.destination}`:""}{counts?` · +${counts.added} −${counts.removed}`:""}</summary>
    {diff?.tooBig?<div className="space-y-2 p-2 text-xs"><p className="text-muted-foreground">文件较大，显示完整的修改前后内容。</p><details><summary>修改前</summary><pre className="max-h-48 overflow-auto">{file.beforeText}</pre></details><details><summary>修改后</summary><pre className="max-h-48 overflow-auto">{file.text}</pre></details></div>:diff&&<pre className="max-h-56 overflow-auto bg-background/70 p-2 text-xs">{collapseDiff(diff.rows).slice(0,400).map((item,i)=>item.kind==="gap"?<div key={i} className="text-muted-foreground">… {item.count} 行未改动</div>:<div key={i} className={item.row.op==="add"?"bg-success/10 text-success-ink":item.row.op==="del"?"bg-destructive/10 text-destructive-ink":""}>{item.row.op==="add"?"+":item.row.op==="del"?"−":" "}{String(item.row.oldLine??item.row.newLine??"").padStart(4)} {item.row.text}</div>)}</pre>}
    {diff&&!diff.tooBig&&collapseDiff(diff.rows).length>400&&<p className="text-xs text-muted-foreground">差异超过 400 行，展开完整内容核对。</p>}
    {open&&<details className="p-2 text-xs"><summary>完整修改后内容</summary><pre className="max-h-56 overflow-auto">{file.text}</pre></details>}
  </details>;
}
export function WorkbenchEditPreview({files}:{files:FilePlan[]}) {
  return <div className="mt-3 max-h-64 overflow-auto rounded-[var(--r-control)] border border-border">{files.map(file=><FileChanges key={file.path} file={file}/>)}</div>;
}

