import { useState } from "react";
import { invoke } from "../../lib/tauri";
import { errorToast } from "../../lib/errorToast";

export function JavaDiagnosticTools({ defaultPid }: { defaultPid: number | null }) {
  const [pid, setPid] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const target = Number(pid || defaultPid);
  const run = async (action: string) => {
    setBusy(true); setOutput("");
    try { setOutput(await invoke<string>("java_diagnostic", { pid: target, action })); }
    catch (error) { errorToast("JVM 诊断", error); }
    finally { setBusy(false); }
  };
  return <details className="jrun-diagnostics"><summary>JVM 诊断与性能记录</summary>
    <div className="jrun-toolbar"><label>本机 Java 进程号<input inputMode="numeric" value={pid} placeholder={defaultPid ? String(defaultPid) : "填写服务端或客户端 PID"} onChange={event => setPid(event.target.value)} /></label>
      {[['threads', '线程转储'], ['histogram', '对象内存统计'], ['vm', '虚拟机信息'], ['jfr-start', '开始性能记录'], ['jfr-stop', '停止并保存记录']].map(([action, label]) => <button type="button" className="wb-status-btn" key={action} disabled={busy || !Number.isSafeInteger(target) || target <= 0} onClick={() => void run(action)}>{label}</button>)}
    </div>
    <div className="wb-panel-note">调用当前完整 JDK 的 jstack / jcmd。内存统计可能短暂暂停目标 JVM；性能记录要求目标 JDK 支持 JFR，保存位置由工具输出给出。</div>
    {busy ? <div role="status">正在读取 JVM 诊断…</div> : output && <pre>{output}</pre>}
  </details>;
}
