import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activateTab, patchTab, useDbSelector } from "../../lib/dbStore";
import { comparisonCell, comparisonColumns, comparisonTsv, filterComparisonRows, type CompareTab } from "../../lib/dbCompareState";
import { useComparison } from "../../hooks/useComparison";
import { downloadText } from "../../lib/resultExport";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { CellDetail } from "./CellDetail";
import { CompareSource } from "./CompareSource";
import { ComparisonGrid, type ComparisonGridApi, type ComparisonViewState } from "./ComparisonGrid";
import "../../db-compare-workbench.css";

export function ComparisonWorkspace({ tab }: { tab:CompareTab }) {
  const [detail,setDetail]=useState<{r:number;c:number}|null>(null);
  const gridRef=useRef<ComparisonGridApi>(null);
  const sourceId=useDbSelector(state=>[tab.after.originTabId,tab.before.originTabId].find(id=>id && state.tabs.some(t=>t.id===id)));
  const comparison=useComparison(tab.before,tab.after,tab.keys);
  const model=comparison.model;
  const order=useMemo(()=>model ? filterComparisonRows(model,tab.filter,tab.query) : [],[model,tab.filter,tab.query]);
  const columns=useMemo(()=>model ? comparisonColumns(model,order,tab.onlyChanged) : [],[model,order,tab.onlyChanged]);
  const updateGrid=useCallback((patch:ComparisonViewState)=>patchTab<CompareTab>(tab.id,patch),[tab.id]);
  useEffect(()=>setDetail(null),[tab.before,tab.after]);
  const update=(patch:Partial<CompareTab>)=>{
    setDetail(null);
    // Filtering can remove rows or column pairs; never let an old position select a different value.
    patchTab<CompareTab>(tab.id,{...patch,scrollTop:0,scrollLeft:0,activeCell:null});
  };
  const closeDetail=()=>{setDetail(null);requestAnimationFrame(()=>gridRef.current?.focusActive());};
  const detailColumn=detail ? columns[detail.c] : undefined;
  const detailRecord=detail && model ? model.records[detail.r] : undefined;
  const detailValue=detailColumn && detailRecord ? comparisonCell(detailRecord,detailColumn) : undefined;
  const activeColumn=tab.activeCell ? columns[tab.activeCell.c] : undefined;
  const canInspect=!!(tab.activeCell && model && activeColumn && activeColumn.sourceIndex>=0 && model.records[tab.activeCell.r] && comparisonCell(model.records[tab.activeCell.r],activeColumn)!==undefined);
  const partial=!tab.before.complete || !tab.after.complete;
  const count=model?.records.length ?? 0;
  const filters:[CompareTab["filter"],string,number][]=[["all","全部",count],["changed","修改",model?.counts.changed ?? 0],["added","新增",model?.counts.added ?? 0],["removed","删除",model?.counts.removed ?? 0]];
  const exportAll=()=>{
    if(!model) return;
    try {downloadText("查询结果差异.tsv",comparisonTsv(tab.before,tab.after,model));}
    catch(error) {toast(`导出失败：${error instanceof Error ? error.message : String(error)}`,"error");}
  };

  return <section className="dbx-comparison" aria-label="查询结果比对">
    <div className="dbx-compare-topbar">
      <button type="button" className="dbx-btn ghost" disabled={!sourceId} title={sourceId ? "返回来源查询，保留当前比对文档" : "来源标签已关闭"} onClick={()=>sourceId && activateTab(sourceId)}><Icon name="arrowLeft" size={14} />返回查询</button>
      <h2>结果比对</h2>
      <button type="button" className="dbx-btn" disabled={!model || count===0} onClick={exportAll} title="包含全部差异、全部字段和比较范围，不受当前筛选影响"><Icon name="download" size={14} />导出全部差异{model ? `（${count.toLocaleString()}）` : ""}</button>
    </div>
    <div className="dbx-compare-sources"><CompareSource snapshot={tab.before} side="A" /><CompareSource snapshot={tab.after} side="B" /></div>
    <div className="dbx-compare-scope" data-partial={partial || undefined}>
      <Icon name={partial ? "alertTriangle" : "layers"} size={14} /><span>{partial ? "仅比较已加载数据，不能代表全表差异" : "比较两份查询结果的全部已加载数据，包含隐藏列"}{partial && "；包含隐藏列。新增、删除仅表示这两份样本的差异。"}</span>
    </div>
    {comparison.pending && <div role="status">正在比对数据…</div>}
    <fieldset className="dbx-compare-keys">
      <legend>唯一键 <span>手动选择，可多选组成复合键</span></legend>
      <div className="dbx-compare-key-options">{tab.before.columns.map((column,index)=><label key={`${column.name}-${index}`}><input type="checkbox" checked={tab.keys.some(key=>key.toUpperCase()===column.name.toUpperCase())} onChange={event=>update({keys:event.target.checked ? [...tab.keys,column.name] : tab.keys.filter(key=>key.toUpperCase()!==column.name.toUpperCase())})} />{column.name}</label>)}</div>
    </fieldset>
    {model && <div className="dbx-compare-controls">
      <div role="group" aria-label="差异类型" className="dbx-compare-filters">{filters.map(([filter,label,n])=><button key={filter} type="button" className="dbx-btn ghost" aria-pressed={tab.filter===filter} onClick={()=>update({filter})}>{label}<span>{n.toLocaleString()}</span></button>)}</div>
      <label className="dbx-compare-search"><Icon name="search" size={13} /><input type="search" aria-label="按键查找" placeholder="按键查找" value={tab.query} onChange={event=>update({query:event.target.value})} /></label>
      <label className="dbx-compare-toggle"><input type="checkbox" checked={tab.onlyChanged} onChange={event=>update({onlyChanged:event.target.checked})} />只看变化字段</label>
      <button type="button" className="dbx-btn ghost" disabled={!canInspect} onClick={()=>tab.activeCell && setDetail(tab.activeCell)}><Icon name="eye" size={13} />查看完整值</button>
    </div>}
    <div className="dbx-compare-body dbx-rbody">
      {comparison.error ? <div className="dbx-compare-empty" role="alert"><Icon name="alertTriangle" size={22} /><strong>无法按当前字段比较</strong><p>{comparison.error}</p></div>
        : !model ? <div className="dbx-compare-empty"><Icon name="key" size={24} /><strong>先选择能唯一标识记录的字段</strong><p>两份结果按选中的字段值对应，可多选组成复合键。</p></div>
        : order.length===0 ? <div className="dbx-compare-empty" role="status"><Icon name={count===0 ? "check" : "search"} size={24} /><strong>{count===0 ? "两份已加载结果没有差异" : "没有符合筛选条件的差异"}</strong><p>{count===0 ? "当前唯一键下，全部已加载字段值一致。" : `全部差异仍有 ${count.toLocaleString()} 条，导出范围保持完整。`}</p>{count>0 && <button type="button" className="dbx-btn" onClick={()=>update({filter:"all",query:""})}>清除筛选</button>}</div>
        : <ComparisonGrid model={model} order={order} columns={columns} activeCell={tab.activeCell} scrollTop={tab.scrollTop} scrollLeft={tab.scrollLeft} onStateChange={updateGrid} onOpen={setDetail} apiRef={gridRef} />}
      {detail && detailColumn && detailRecord && model && detailColumn.sourceIndex>=0 && detailValue!==undefined && <CellDetail column={model.columns[detailColumn.sourceIndex]} zh={`${detailColumn.side ? `${detailColumn.side} · ${detailColumn.side==="A" ? "对照值" : "当前值"}` : "唯一键"} · ${detailRecord.key}`} row={detail.r+1} value={detailValue} empty={false} onClose={closeDetail} />}
    </div>
    {model && <div className="dbx-compare-footer"><span role="status">显示 {order.length.toLocaleString()} / {count.toLocaleString()} 条差异</span><span>双击单元格或 Enter 查看完整原值</span></div>}
  </section>;
}
