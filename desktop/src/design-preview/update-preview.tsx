import { useState } from "react";
import { createRoot } from "react-dom/client";
import { UpdateNotesDialog } from "../components/update/UpdateNotesDialog";
import { AVAILABLE_PROCESS, type UpdateDialogProcess } from "../components/update/UpdateProcess";
import { updatePresentation } from "../lib/updatePresentation";
import { toggleTheme } from "../lib/theme";
import "../index.css";
import "../components/update/update-badge.css";

function Preview() {
  const [status,setStatus] = useState<UpdateDialogProcess["status"]>("ready");
  const [open,setOpen] = useState(true);
  const [message,setMessage] = useState("");
  const [failure,setFailure] = useState(false);
  const process = {...AVAILABLE_PROCESS,status,progress:status === "downloading"?100:0,error:failure?"模拟安装未完成":null};
  const presentation = updatePresentation({...process,version:"0.3.0"});
  return <main style={{minHeight:"100vh",padding:24,background:"hsl(var(--background))",color:"hsl(var(--foreground))"}}>
    <h1>软件更新体验 · 真实组件预览</h1>
    <p>0.2.0 → 0.3.0 · 使用正式更新说明，不下载、不安装。</p>
    <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
      <button className="header-badge" onClick={()=>setOpen(true)} title={presentation.title}>{presentation.label} · v0.3.0</button>
      <select aria-label="更新预览状态" value={status} onChange={event=>setStatus(event.target.value as UpdateDialogProcess["status"])}>{[["available","发现新版本"],["downloading","正在校验"],["ready","已准备好"],["error","下载失败"]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
      <label><input type="checkbox" checked={failure} onChange={event=>setFailure(event.target.checked)}/>模拟安装失败</label>
      <button onClick={toggleTheme}>切换主题</button>
    </div>
    <p role="status">{message}</p>
    <UpdateNotesDialog open={open} update={{version:"0.3.0",currentVersion:"0.2.0",body:""}} process={process} onClose={()=>setOpen(false)} onDismiss={()=>setOpen(false)} onDownload={()=>setStatus("downloading")} onRestart={()=>setMessage("预览已收到重启更新操作，未启动真实安装器。")} onRetry={()=>setStatus("ready")} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
