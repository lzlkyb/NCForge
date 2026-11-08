import { useId, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import { comparisonCell, compareKindLabel, type ComparisonColumn, type ComparisonModel, type CompareTab } from "../../lib/dbCompareState";
import { columnViewport } from "../../lib/gridViewport";
import { getUiDensity, subscribeUiDensity } from "../../lib/uiDensity";
import { copyText } from "../../lib/utils";
import { toast } from "../ui/toast";

type CellPos={r:number;c:number};
export type ComparisonViewState=Partial<Pick<CompareTab,"scrollTop"|"scrollLeft"|"activeCell">>;
export interface ComparisonGridApi {focusActive:()=>void}
const OVERSCAN=8;

/** Virtualize both axes; record indexes always refer to the complete comparison model. */
export function ComparisonGrid({ model, order, columns, activeCell, scrollTop=0, scrollLeft=0, onStateChange, onOpen, apiRef }: {
  model:ComparisonModel; order:number[]; columns:ComparisonColumn[];
  activeCell?:CellPos|null; scrollTop?:number; scrollLeft?:number;
  onStateChange:(patch:ComparisonViewState)=>void; onOpen:(pos:CellPos)=>void; apiRef?:Ref<ComparisonGridApi>;
}) {
  const density=useSyncExternalStore(subscribeUiDensity,getUiDensity);
  const rowHeight=density==="comfortable" ? 30 : 26, headHeight=density==="comfortable" ? 48 : 44;
  const boxRef=useRef<HTMLDivElement>(null), previousRowHeight=useRef(rowHeight);
  const id=useId(), helpId=`${id}-help`;
  const [scroll,setScroll]=useState({top:scrollTop,left:scrollLeft,h:320,w:800});
  const [pendingFocus,setPendingFocus]=useState<CellPos|null>(null);
  const active=activeCell && order.includes(activeCell.r) && columns[activeCell.c] ? activeCell : null;
  const visible=columns.map((_,i)=>i), widths=columns.map(c=>c.width);
  const frozen=new Set(visible.filter(c=>columns[c].kind!=="value"));
  const viewport=columnViewport(visible,widths,frozen,scroll.left,scroll.w,0);
  const total=widths.reduce((sum,width)=>sum+width,0);
  const first=Math.max(0,Math.floor(scroll.top/rowHeight)-OVERSCAN);
  const last=Math.min(order.length,Math.ceil((scroll.top+scroll.h)/rowHeight)+OVERSCAN);
  const activeIndex=active ? order.indexOf(active.r) : -1;
  const cellId=(pos:CellPos)=>`${id}-cell-${pos.r}-${pos.c}`;
  const activeId=active && activeIndex>=first && activeIndex<last && viewport.some(c=>c.column===active.c) ? cellId(active) : undefined;

  useLayoutEffect(()=>{
    const el=boxRef.current;if(!el) return;
    const nextTop=scrollTop/previousRowHeight.current*rowHeight;
    const densityChanged=previousRowHeight.current!==rowHeight;
    previousRowHeight.current=rowHeight;
    el.scrollTop=nextTop;el.scrollLeft=scrollLeft;
    setScroll(s=>s.top===el.scrollTop && s.left===el.scrollLeft ? s : {...s,top:el.scrollTop,left:el.scrollLeft});
    // Store the new pixel offset too, so returning to this document preserves the same first row.
    if(densityChanged) onStateChange({scrollTop:el.scrollTop});
  },[scrollTop,scrollLeft,rowHeight,onStateChange]);
  useLayoutEffect(()=>{
    const el=boxRef.current;if(!el) return;
    const update=()=>setScroll(s=>{
      const h=el.clientHeight || s.h,w=el.clientWidth || s.w;
      return s.h===h && s.w===w ? s : {...s,h,w};
    });
    update();const observer=new ResizeObserver(update);observer.observe(el);
    return ()=>observer.disconnect();
  },[]);

  const syncScroll=()=>{
    const el=boxRef.current;if(!el) return;
    const top=el.scrollTop,left=el.scrollLeft;
    setScroll(s=>({...s,top,left,h:el.clientHeight || s.h,w:el.clientWidth || s.w}));
    if(top!==scrollTop || left!==scrollLeft) onStateChange({scrollTop:top,scrollLeft:left});
  };
  const reveal=(pos:CellPos)=>{
    const el=boxRef.current,index=order.indexOf(pos.r);
    if(!el || index<0 || !columns[pos.c]) return;
    const h=el.clientHeight || scroll.h,w=el.clientWidth || scroll.w;
    const x=widths.slice(0,pos.c).reduce((n,width)=>n+width,0);
    const fixedWidth=visible.filter(c=>frozen.has(c)).reduce((n,c)=>n+widths[c],0);
    if(!frozen.has(pos.c)) {
      if(x<el.scrollLeft+fixedWidth) el.scrollLeft=Math.max(0,x-fixedWidth);
      else if(x+widths[pos.c]>el.scrollLeft+w) el.scrollLeft=x+widths[pos.c]-w;
    }
    const y=index*rowHeight;
    if(y<el.scrollTop) el.scrollTop=y;
    else if(y+rowHeight>el.scrollTop+h-headHeight) el.scrollTop=y+rowHeight-h+headHeight;
    syncScroll();
  };
  const focusCell=(pos:CellPos)=>{reveal(pos);setPendingFocus(pos);};
  const focusActive=()=>{if(active) focusCell(active);else boxRef.current?.focus({preventScroll:true});};
  useImperativeHandle(apiRef,()=>({focusActive}));
  useLayoutEffect(()=>{
    if(!pendingFocus) return;
    const target=document.getElementById(`${id}-cell-${pendingFocus.r}-${pendingFocus.c}`);
    setPendingFocus(null);
    if(!target) return;
    target.scrollIntoView?.({block:"nearest",inline:"nearest"});
    boxRef.current?.focus({preventScroll:true});
  },[pendingFocus,id]);
  const select=(pos:CellPos)=>{onStateChange({activeCell:pos});focusCell(pos);};
  const inspect=(pos:CellPos)=>{
    if(columns[pos.c].sourceIndex<0) return;
    if(comparisonCell(model.records[pos.r],columns[pos.c])===undefined) {toast("此侧无此记录，没有单元格原值", "info");return;}
    onStateChange({activeCell:pos});onOpen(pos);
  };
  const onKeyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.target!==event.currentTarget || !order.length) return;
    const pos=active ?? {r:order[Math.min(order.length-1,Math.floor(scroll.top/rowHeight))],c:0};
    let r=order.indexOf(pos.r),c=pos.c;
    const page=Math.max(1,Math.floor((scroll.h-headHeight)/rowHeight)-1);
    const moves:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1],PageUp:[-page,0],PageDown:[page,0]};
    if(moves[event.key]) {r+=moves[event.key][0];c+=moves[event.key][1];}
    else if(event.key==="Home") {c=0;if(event.ctrlKey || event.metaKey) r=0;}
    else if(event.key==="End") {c=columns.length-1;if(event.ctrlKey || event.metaKey) r=order.length-1;}
    else if(event.key==="Enter" || event.key==="F2") {event.preventDefault();inspect(pos);return;}
    else if((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==="c" && !window.getSelection()?.toString()) {
      event.preventDefault();const value=comparisonCell(model.records[pos.r],columns[pos.c]);
      if(value===undefined || value===null) {toast(value===undefined ? "此侧无此记录，没有可复制的原值" : "NULL 为数据库空值，没有文本原值","info");return;}
      void copyText(String(value),()=>toast("已复制原值","success"),error=>toast(`复制失败：${error}`,"error"));return;
    } else return;
    event.preventDefault();select({r:order[Math.max(0,Math.min(order.length-1,r))],c:Math.max(0,Math.min(columns.length-1,c))});
  };

  return <div ref={boxRef} className="dbx-compare-grid" role="grid" aria-label="结果差异" tabIndex={0}
    aria-describedby={helpId} aria-rowcount={order.length+1} aria-colcount={columns.length} aria-activedescendant={activeId}
    style={{"--cmp-row-h":`${rowHeight}px`,"--cmp-head-h":`${headHeight}px`} as CSSProperties}
    onScroll={syncScroll} onKeyDown={onKeyDown} onFocus={event=>{
      if(event.target===event.currentTarget && !active && order.length) onStateChange({activeCell:{r:order[Math.min(order.length-1,Math.floor(scroll.top/rowHeight))],c:0}});
    }}>
    <span id={helpId} className="dbx-compare-instructions">方向键移动；Home、End 移到本行首尾；Ctrl+Home、Ctrl+End 移到首末行；Enter 查看完整原值，Ctrl+C 复制原值。唯一键列固定，A 为对照值，B 为当前值。</span>
    <div className="dbx-compare-canvas" style={{width:total,height:headHeight+order.length*rowHeight}}>
      <div className="dbx-compare-gridhead" role="row" aria-rowindex={1} style={{width:total}}>
        {viewport.map(v=>{const column=columns[v.column];return <div key={v.column} className="dbx-compare-heading" role="columnheader" aria-colindex={v.column+1}
          style={{width:v.width,left:v.frozen ? v.sticky : v.left,position:v.frozen ? "sticky" : "absolute",zIndex:v.frozen ? 2 : 1}}
          data-frozen={v.frozen || undefined} data-side={column.side} title={`${column.name} · ${column.kind==="key" ? "唯一键，冻结列" : column.side==="A" ? "A 对照值" : column.side==="B" ? "B 当前值" : "差异类型"}`}>
          <strong>{column.name}</strong><span>{column.kind==="key" ? "唯一键 · 冻结" : column.side==="A" ? "A · 对照值" : column.side==="B" ? "B · 当前值" : "差异类型"}</span>
        </div>;})}
      </div>
      {order.slice(first,last).map((recordIndex,offset)=>{
        const record=model.records[recordIndex],viewIndex=first+offset;
        return <div key={recordIndex} className="dbx-compare-row" role="row" aria-rowindex={viewIndex+2} style={{top:headHeight+viewIndex*rowHeight,width:total}}>
          {viewport.map(v=>{
            const column=columns[v.column],pos={r:recordIndex,c:v.column},value=comparisonCell(record,column);
            const placeholder=value===undefined ? "无此记录" : value===null ? "NULL" : value==="" ? "空字符串" : typeof value==="string" && !/\S/.test(value) ? `空白 · ${value.length} 字符` : null;
            const shown=placeholder ?? String(value).slice(0,500),chosen=active?.r===recordIndex && active.c===v.column;
            const changed=column.kind==="value" && value!==undefined && record.before?.[column.sourceIndex]!==record.after?.[column.sourceIndex];
            const label=`${column.name}${column.side ? ` · ${column.side} ${column.side==="A" ? "对照值" : "当前值"}` : ""}：${shown.slice(0,120)}`;
            return <div key={v.column} id={cellId(pos)} role="gridcell" aria-colindex={v.column+1} aria-selected={chosen} aria-label={label}
              className="dbx-compare-cell" data-record={recordIndex} data-column={v.column} data-frozen={v.frozen || undefined} data-side={column.side}
              data-change={changed ? record.kind : undefined} data-value-kind={value===undefined ? "missing" : value===null ? "null" : value==="" ? "empty" : undefined}
              style={{width:v.width,left:v.frozen ? v.sticky : v.left,position:v.frozen ? "sticky" : "absolute",zIndex:v.frozen ? 2 : 1}}
              title={`${label}${typeof value==="string" && value.length>120 ? "… · Enter 查看完整原值" : ""}`} onClick={()=>select(pos)} onDoubleClick={()=>inspect(pos)}>
              {placeholder ? <span className="dbx-compare-placeholder" data-placeholder={placeholder} aria-hidden="true" /> : <span>{column.kind==="type" ? compareKindLabel[record.kind] : shown}</span>}
            </div>;
          })}
        </div>;
      })}
    </div>
  </div>;
}
