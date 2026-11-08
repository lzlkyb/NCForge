import { useState } from "react";
import type { ResultSnapshot } from "../../lib/dbResultTools";
import { clearCompareBaseline, setCompareBaseline, useCompareBaseline } from "../../lib/dbCompareState";
import { openCompareTab } from "../../lib/dbStore";
import { Icon } from "../ui/icon";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { toast } from "../ui/toast";
import { CompareSourceDialog } from "./CompareSource";
import "../../db-compare-workbench.css";

export function ResultBaselineSummary() {
  const baseline=useCompareBaseline();
  const [open,setOpen]=useState(false);
  if(!baseline) return null;
  return <>
    <button type="button" className="dbx-compare-baseline" aria-label="查看对照 A 来源" title={`A · ${baseline.source} · schema ${baseline.schema || "未记录"} · ${new Date(baseline.at).toLocaleString()} · ${baseline.rows.length.toLocaleString()} 行 · ${baseline.complete ? "完整查询结果" : "部分结果"}`} onClick={()=>setOpen(true)}>
      <b>A</b><span className="dbx-baseline-source">{baseline.source}</span><span className="dbx-baseline-schema">{baseline.schema || "schema 未记录"}</span><time dateTime={new Date(baseline.at).toISOString()}>{new Date(baseline.at).toLocaleTimeString()}</time><span>{baseline.rows.length.toLocaleString()} 行</span><span data-partial={!baseline.complete || undefined}>{baseline.complete ? "完整" : "部分"}</span>
    </button>
    <CompareSourceDialog before={baseline} open={open} onClose={()=>setOpen(false)} />
  </>;
}

/** Every result subscribes to the same in-memory A, so tab changes cannot leave a stale "saved" state. */
export function ResultCompare({ snapshot, related }: { snapshot:ResultSnapshot; related?:ContextMenuItem }) {
  const baseline=useCompareBaseline();
  const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
  const [sourceOpen,setSourceOpen]=useState(false);
  const fix=()=>{
    try {
      setCompareBaseline(snapshot);
      toast(`已${baseline ? "更新" : "固定"}对照 A · ${snapshot.rows.length.toLocaleString()} 行，包含隐藏列；切到另一份结果点击比对`,"success");
    } catch(error) { toast(error instanceof Error ? error.message : String(error),"error"); }
  };
  const compare=()=>{
    if(!baseline) {fix();return;}
    try {openCompareTab(baseline,snapshot);}
    catch(error) {toast(error instanceof Error ? error.message : String(error),"error");}
  };
  return <>
    <div className="dbx-compare-action" role="group" aria-label="结果比对">
      <button type="button" className="dbx-btn ghost" aria-label={baseline ? "比对当前结果与对照 A" : "固定当前结果为对照 A"} title={baseline ? "比较两份全部已加载数据，包含隐藏列；在独立文档中打开" : "先固定当前结果为对照 A，再到另一份结果点击比对"} onClick={compare}><Icon name="layers" size={14} /><span>比对</span>{!baseline && <span className="dbx-compare-first">固定 A</span>}</button>
      <button type="button" className="dbx-btn ghost" aria-label="比对选项" title="固定或更新对照、查看来源" aria-haspopup="menu" aria-expanded={!!menu} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();setMenu(menu ? null : {x:r.left,y:r.bottom+4});}}><Icon name="chevronDown" size={12} /></button>
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={()=>setMenu(null)} items={[
      {label:baseline ? "更新对照 A" : "固定为对照 A",icon:"copy",onSelect:fix},
      {label:"查看来源",icon:"eye",onSelect:()=>setSourceOpen(true)},
      ...(baseline ? [{label:"清除对照 A",icon:"close" as const,onSelect:clearCompareBaseline}] : []),
      ...(related ? [{...related,separator:true}] : []),
    ]} />}
    <CompareSourceDialog before={baseline} after={snapshot} open={sourceOpen} onClose={()=>setSourceOpen(false)} />
  </>;
}
