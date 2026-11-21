import { errorToast } from "../../lib/errorToast";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOperations, useOperationStatusLabel, cancelOperation, canCancelOperation, retryOperation, canRetryOperation, clearCompletedOperations, revealOperation } from "../../lib/operations";
import { requestOpenFile } from "../../lib/openFileRequest";
import { setSession } from "../../lib/workspaceSession";
import { Icon } from "./icon";
import { Button } from "./button";
import { usePresence } from "../../hooks/usePresence";
import { useTaskElapsed } from "../../hooks/useTaskElapsed";
import { OperationEta } from "./OperationEta";
import "../../operation-feedback.css";
const stateText={running:"处理中",cancelling:"停止中",success:"已完成",failed:"失败",cancelled:"已取消",partial:"部分完成"};
export function OperationStatus({compact=false}:{compact?:boolean}) {
  const label=useOperationStatusLabel();
  const [open,setOpen]=useState(false);
  const panelId=useId();
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement|null>(null);
  const {mounted,entered}=usePresence(open);
  useEffect(()=>{
    if(!open) return;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const other=(e:Event)=>{if((e as CustomEvent).detail!==panelId) setOpen(false);};
    const outside=(e:PointerEvent)=>{if(!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false);};
    const key=(e:KeyboardEvent)=>{
      if(e.isComposing || e.key!=="Escape") return;
      const focused=panel.current?.contains(document.activeElement) || document.activeElement===trigger.current;
      setOpen(false);
      if(focused){e.preventDefault();e.stopPropagation();trigger.current?.focus();}
    };
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",key);document.addEventListener("ncforge-operation-open",other);
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",key);document.removeEventListener("ncforge-operation-open",other);};
  },[open,panelId]);
  const close=()=>{setOpen(false);trigger.current?.focus();};
  return <>
    <button type="button" ref={trigger} className={compact?"wb-status-chip op-status":"wb-header-icon op-status"} aria-label="运行任务" aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} title={label} onClick={()=>{if(!open) document.dispatchEvent(new CustomEvent("ncforge-operation-open",{detail:panelId}));setOpen(v=>!v);}}>
      <Icon name="activity" size={13} aria-hidden="true"/><span>{label}</span>
    </button>
    {mounted && createPortal(<section id={panelId} ref={node=>{panel.current=node;if(node) node.inert=!open;}} role="dialog" aria-label="运行任务" aria-hidden={!open || undefined} data-state={entered?"open":"closed"} data-exiting={!open || undefined} data-anchor={compact?"bottom":"top"} className="ui-surface op-panel">
      <div className="op-head"><h2>任务</h2><Button size="icon" variant="ghost" aria-label="关闭运行任务" onClick={close}><Icon name="close" size={14}/></Button><Button size="sm" variant="ghost" onClick={clearCompletedOperations}>清除已结束</Button></div>
      <OperationList open={open} close={close}/>
    </section>,document.body)}
  </>;
}

function OperationList({open,close}:{open:boolean;close:()=>void}) {
  const tasks=useOperations();
  const active=tasks.filter(o=>o.endedAt===undefined);
  useTaskElapsed(open && active.length>0);
  const now=Date.now();
  return <>
      {!tasks.length && <p className="op-empty">暂无运行任务。耗时操作开始后会在这里显示。</p>}
      <div className="op-list">{[...active,...tasks.filter(o=>o.endedAt!==undefined).reverse()].map(o=>{
        const seconds=Math.max(0,Math.floor(((o.endedAt??now)-o.startedAt)/1000));
        const returnTo=()=>{revealOperation(o.id);if(o.page) window.dispatchEvent(new CustomEvent("ncforge-navigate",{detail:o.page}));if(o.panel==="svc" || o.panel==="debug") setSession({panelOpen:true,panelTab:o.panel});if(o.path) requestOpenFile({path:o.path});close();};
        return <article key={o.id} className="op-row" data-status={o.state}>
          <div className="op-title"><strong>{o.label}</strong><span>{stateText[o.state]} · {seconds} 秒</span></div>
          {o.scope && <p className="op-scope" title={o.scope}>{o.scope}</p>}
          <p>{o.endedAt!==undefined?(o.detail??stateText[o.state]):o.phase}</p>
          {o.endedAt===undefined && o.detail && <p>{o.detail}</p>}
          {o.progress && <div className="op-progress"><span>{o.progress.done.toLocaleString()}{o.progress.total!==undefined?` / ${o.progress.total.toLocaleString()}`:""}{o.progress.unit && ` ${o.progress.unit}`}</span>{o.progress.total!==undefined && o.progress.total>0 && <progress aria-label={`${o.label}进度`} value={o.progress.done} max={o.progress.total}/>}</div>}
          {o.state==="running" && <OperationEta estimate={o.estimate}/>}
          <div className="op-actions">{(o.page || o.path) && <Button size="sm" variant="outline" onClick={returnTo}>返回来源</Button>}
            {o.endedAt===undefined && canCancelOperation(o.id) && <Button size="sm" variant="outline" disabled={o.state==="cancelling"} onClick={()=>void cancelOperation(o.id)}>请求停止</Button>}
            {o.endedAt===undefined && !canCancelOperation(o.id) && <span className="op-note">此操作不支持中途停止</span>}
            {o.state==="failed" && canRetryOperation(o.id) && <Button size="sm" variant="outline" disabled={active.some(a=>a.key===o.key)} onClick={()=>void retryOperation(o.id).catch(e=>errorToast("重试", e))}>重试</Button>}
          </div>
        </article>;
      })}</div>
  </>;
}
