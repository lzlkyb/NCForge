import { useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref, type RefObject } from "react";
import type { CellPos, ResultGridApi } from "../components/db/ResultGrid";

type GridFocus={kind:"header";c:number;menu?:boolean}|{kind:"cell";pos:CellPos;menu?:boolean};

/** Grid/header navigation shares one focus owner; reveal a virtual target before focusing or opening its menu. */
export function useResultGridNavigation({boxRef,sel,visible,order,reveal,onSel,onSort,onHeaderMenu,onCellMenu,editing,onOpen,onCopy,apiRef}: {
  boxRef:RefObject<HTMLDivElement>;sel:CellPos|null;visible:number[];order:number[];
  reveal:(c:number,rowIndex?:number)=>void;onSel:(pos:CellPos,extend?:boolean)=>void;onSort:(c:number)=>void;
  onHeaderMenu?:(c:number,x:number,y:number)=>void;onCellMenu?:(r:number,c:number,x:number,y:number)=>void;
  editing:boolean;onOpen:(pos:CellPos)=>void;onCopy:()=>void;apiRef?:Ref<ResultGridApi>;
}) {
  const headerRefs=useRef(new Map<number,HTMLButtonElement>());
  const [headerCol,setHeaderCol]=useState(sel?.c ?? visible[0]);
  const [pendingFocus,setPendingFocus]=useState<GridFocus|null>(null);
  const selIndex=sel ? order.indexOf(sel.r) : -1;
  const focusCell=(pos:CellPos,menu=false)=>{
    const index=order.indexOf(pos.r);
    if(index<0 || !visible.includes(pos.c)) return;
    reveal(pos.c,index);setPendingFocus({kind:"cell",pos,menu});
  };
  const focusActive=()=>{
    if(sel && order.includes(sel.r) && visible.includes(sel.c)) focusCell(sel);
    else boxRef.current?.focus({preventScroll:true});
  };
  const focusHeader=(c:number|undefined,menu=false)=>{
    if(c===undefined || !visible.includes(c)) return;
    reveal(c);setHeaderCol(c);setPendingFocus({kind:"header",c,menu});
  };
  useImperativeHandle(apiRef,()=>({focusActive}));
  useLayoutEffect(()=>{
    if(!pendingFocus) return;
    const target=pendingFocus.kind==="header" ? headerRefs.current.get(pendingFocus.c)
      : boxRef.current?.querySelector<HTMLElement>(`#dbx-cell-${pendingFocus.pos.r}-${pendingFocus.pos.c}`);
    setPendingFocus(null);
    if(!target) return;
    target.scrollIntoView?.({block:"nearest",inline:"nearest"});
    if(pendingFocus.kind==="header") {
      target.focus({preventScroll:true});
      if(pendingFocus.menu) {const rect=target.getBoundingClientRect();onHeaderMenu?.(pendingFocus.c,rect.left,rect.bottom);}
    } else {
      boxRef.current?.focus({preventScroll:true});
      if(pendingFocus.menu) {const rect=target.getBoundingClientRect();onCellMenu?.(pendingFocus.pos.r,pendingFocus.pos.c,rect.left,rect.bottom);}
    }
  },[pendingFocus,onHeaderMenu,onCellMenu,boxRef]);
  const move=(dr:number,dc:number,extend=false)=>{
    if(order.length===0 || visible.length===0) return;
    const i=Math.max(0,Math.min(order.length-1,(selIndex<0 ? 0 : selIndex)+dr));
    const ci=Math.max(0,Math.min(visible.length-1,Math.max(0,visible.indexOf(sel?.c ?? visible[0]))+dc));
    const c=visible[ci];onSel({r:order[i],c},extend);focusCell({r:order[i],c});
  };
  const onKey=(e:KeyboardEvent)=>{
    if(editing || e.target!==e.currentTarget) return;
    const step:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1],PageUp:[-20,0],PageDown:[20,0]};
    if(e.key==="ArrowUp" && (e.altKey || selIndex<=0 && !e.shiftKey)) {e.preventDefault();focusHeader(sel?.c ?? visible[0]);}
    else if((e.key==="ContextMenu" || e.key==="F10" && e.shiftKey) && sel && onCellMenu) {e.preventDefault();focusCell(sel,true);}
    else if(step[e.key]) {e.preventDefault();move(...step[e.key],e.shiftKey);}
    else if(sel && (e.key==="Enter" || e.key==="F2")) {e.preventDefault();onOpen(sel);}
    else if(sel && (e.ctrlKey || e.metaKey) && e.key.toLowerCase()==="c" && !window.getSelection()?.toString()) {e.preventDefault();onCopy();}
  };
  const onHeaderKey=(e:KeyboardEvent,c:number)=>{
    const index=visible.indexOf(c);
    const next=e.key==="Home" ? 0 : e.key==="End" ? visible.length-1
      : e.key==="ArrowLeft" ? Math.max(0,index-1) : e.key==="ArrowRight" ? Math.min(visible.length-1,index+1) : -1;
    if(next>=0) {e.preventDefault();focusHeader(visible[next]);}
    else if(e.key==="Escape") {e.preventDefault();focusActive();}
    else if(e.key==="ArrowDown") {
      e.preventDefault();
      if(order.length) {const pos={r:sel && order.includes(sel.r) ? sel.r : order[0],c};onSel(pos);focusCell(pos);}
      else boxRef.current?.focus({preventScroll:true});
    } else if((e.key==="ContextMenu" || e.key==="F10" && e.shiftKey) && onHeaderMenu) {e.preventDefault();focusHeader(c,true);}
    else if((e.key==="Enter" || e.key===" ") && e.target===headerRefs.current.get(c)) {e.preventDefault();onSort(c);}
  };
  return {headerRefs,headerCol,setHeaderCol,focusHeader,onHeaderKey,onKey};
}
