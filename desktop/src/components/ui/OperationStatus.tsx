import { errorToast } from "../../lib/errorToast";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOperations, cancelOperation, canCancelOperation, retryOperation, canRetryOperation, clearCompletedOperations, revealOperation } from "../../lib/operations";
import { requestOpenFile } from "../../lib/openFileRequest";
import { setSession } from "../../lib/workspaceSession";
import { Icon } from "./icon";
import { Button } from "./button";
import { usePresence } from "../../hooks/usePresence";
import "../../operation-feedback.css";
const stateText={running:"处理中",cancelling:"停止中",success:"已完成",failed:"失败",cancelled:"已取消"};
export function OperationStatus({compact=false}:{compact?:boolean}) {
  const tasks=useOperations();const [open,setOpen]=useState(false),[now,setNow]=useState(Date.now());
  const panelId=useId();
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement|null>(null);
  const {mounted,entered}=usePresence(open);
  const active=tasks.filter(o=>o.endedAt===undefined),visible=active.filter(o=>o.visible),failed=tasks.filter(o=>o.state==="failed");
  useEffect(()=>{if(!open && !active.length) return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[open,active.length]);
  useEffect(()=>{
    if(!open) return;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const other=(e:Event)=>{if((e as CustomEvent).detail!==panelId) setOpen(false);};
    const outside=(e:PointerEvent)=>{if(!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false);};
    const key=(e:KeyboardEvent)=>{if(e.isComposing || e.key!=="Escape") return;e.preventDefault();e.stopPropagation();setOpen(false);trigger.current?.focus();};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",key);document.addEventListener("ncforge-operation-open",other);
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",key);document.removeEventListener("ncforge-operation-open",other);};
  },[open,panelId]);
  if(compact && !open && !visible.length && !failed.length) return null;
  const close=()=>{setOpen(false);trigger.current?.focus();};
  return <>
    <button type="button" ref={trigger} className={compact?"wb-status-chip op-status":"wb-header-icon op-status"} data-busy={visible.length>0 || undefined} aria-label="运行任务" aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} title="查看运行任务与本次结果" onClick={()=>{if(!open) document.dispatchEvent(new CustomEvent("ncforge-operation-open",{detail:panelId}));setOpen(v=>!v);}}>
      <Icon name={visible.length?"spinner":"activity"} size={14} className={visible.length?"animate-spin":""}/>{compact?<span>{visible.length?`${visible.length} 项处理中`:`${failed.length} 项失败`}</span>:<span className="op-count">{visible.length || failed.length || ""}</span>}
    </button>
    {mounted && createPortal(<section id={panelId} ref={node=>{panel.current=node;if(node) node.inert=!open;}} role="dialog" aria-label="运行任务" aria-hidden={!open || undefined} data-state={entered?"open":"closed"} data-exiting={!open || undefined} className="ui-surface op-panel">
      <div className="op-head"><h2>运行任务</h2><Button size="sm" variant="ghost" onClick={clearCompletedOperations}>清除已结束</Button><Button size="icon" variant="ghost" aria-label="关闭运行任务" onClick={close}><Icon name="close" size={14}/></Button></div>
      <p className="op-note">只保留本次运行的最近结果 · 关闭面板不会停止任务</p>
      {!tasks.length && <p className="op-empty">暂无运行任务。耗时操作开始后会在这里显示。</p>}
      <div className="op-list">{[...tasks].reverse().map(o=>{
        const seconds=Math.max(0,Math.floor(((o.endedAt??now)-o.startedAt)/1000));
        const returnTo=()=>{revealOperation(o.id);if(o.page) window.dispatchEvent(new CustomEvent("ncforge-navigate",{detail:o.page}));if(o.panel==="svc" || o.panel==="debug") setSession({panelOpen:true,panelTab:o.panel});if(o.path) requestOpenFile({path:o.path});close();};
        return <article key={o.id} className="op-row" data-status={o.state}>
          <div className="op-title"><strong>{o.label}</strong><span>{stateText[o.state]} · {seconds} 秒</span></div>
          {o.scope && <p className="op-scope" title={o.scope}>{o.scope}</p>}
          <p>{o.endedAt!==undefined?(o.detail??stateText[o.state]):o.phase}</p>
          {o.endedAt===undefined && o.detail && <p>{o.detail}</p>}
          {o.endedAt===undefined && seconds>=10 && <p className="op-note">操作耗时较长，可继续处理其他内容。</p>}
          {o.progress && <div className="op-progress" role="status">{o.progress.done}{o.progress.total!==undefined?` / ${o.progress.total}`:""}{o.progress.total!==undefined && o.progress.total>0 && <progress value={o.progress.done} max={o.progress.total}/>}</div>}
          <div className="op-actions">{(o.page || o.path) && <Button size="sm" variant="outline" onClick={returnTo}>返回来源</Button>}
            {o.endedAt===undefined && canCancelOperation(o.id) && <Button size="sm" variant="outline" disabled={o.state==="cancelling"} onClick={()=>void cancelOperation(o.id)}>请求停止</Button>}
            {o.endedAt===undefined && !canCancelOperation(o.id) && <span className="op-note">此操作不支持中途停止</span>}
            {o.state==="failed" && canRetryOperation(o.id) && <Button size="sm" variant="outline" disabled={active.some(a=>a.key===o.key)} onClick={()=>void retryOperation(o.id).catch(e=>errorToast("重试", e))}>重试</Button>}
          </div>
        </article>;
      })}</div>
    </section>,document.body)}
  </>;
}
