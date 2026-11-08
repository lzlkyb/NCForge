import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { toggleTheme } from "../lib/theme";
function PreviewControls() {
 const [scenario,setScenario]=useState("success"),[busy,setBusy]=useState(false),[reduced,setReduced]=useState(false);
 useEffect(()=>{
  const handle=(event:Event)=>{const state=(event as CustomEvent<{state:string}>).detail.state;setBusy(state==="running"||state==="cancelling");};
  window.addEventListener("preview-query",handle);
  const timer=setTimeout(()=>window.dispatchEvent(new CustomEvent("ncforge-navigate",{detail:"db"})),600);
  return()=>{clearTimeout(timer);window.removeEventListener("preview-query",handle);};
 },[]);
 const select=(value:string)=>{setScenario(value);(window as unknown as {previewScenario:string}).previewScenario=value;};
 return <><div className="qp-controls"><strong>交互设计预览</strong><span>真实组件 · 模拟查询</span><label>返回场景 <select aria-label="查询场景" disabled={busy} value={scenario} onChange={e=>select(e.target.value)}>{[["success","正常 · 3秒"],["fast","极速 · 90ms"],["slow","慢查询 · 12秒"],["empty","空结果"],["error","执行失败"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><button onClick={toggleTheme}>切换深浅色</button><label><input type="checkbox" checked={reduced} onChange={e=>{setReduced(e.target.checked);document.documentElement.dataset.reduced=String(e.target.checked);}}/>减少动态效果</label><span className="qp-how">编辑 SQL 后点击「执行当前语句」或 Ctrl+Enter</span></div>
 </>;
}
createRoot(document.getElementById("preview-controls")!).render(<PreviewControls/>);
