import { useState } from "react";
import { useOperations } from "../../lib/operations";
import { useDevelopmentFlow } from "../../hooks/useDevelopmentFlow";
import { developmentControlsBusy } from "../../lib/developmentFlowSession";
import type { DevelopmentOptions } from "../../lib/developmentFlow";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/icon";
import "../../development-flow.css";

interface Props { onChanged?: () => void; compileAll?: () => Promise<boolean>; disabled?: boolean; }
/** 底部标签行的紧凑入口；进度由 DevelopmentFlowProgress 放进控制台。 */
export function DevelopmentFlowControl({ onChanged, compileAll, disabled = false }: Props) {
  const flow = useDevelopmentFlow(onChanged, compileAll);
  useOperations(); // 服务或编译动作结束时同步解除入口限制。
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DevelopmentOptions>(flow.config);
  const [error, setError] = useState("");
  const locked = disabled || !flow.root || flow.running || developmentControlsBusy();
  const edit = () => { setDraft({ ...flow.config }); setError(""); setOpen(true); };
  const change = (field: keyof DevelopmentOptions, checked: boolean) => setDraft((old) => ({ ...old, [field]: checked, ...(field === "debug" && !checked ? { autoAttach: false } : {}) }));
  const save = (start: boolean) => {
    try { flow.save(draft); setError(""); setOpen(false); if (start) void flow.start(draft); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const title = !flow.root ? "先打开工程" : flow.running ? flow.snapshot.phase : "按配置编译、投送并启动服务；已运行的服务按当前参数复用";
  return <div className="development-control">
    <button type="button" className="sv-btn development-start" disabled={locked} title={title} onClick={() => void flow.start()}>
      <Icon name={flow.running ? "spinner" : "play"} size={13} className={flow.running ? "animate-spin" : ""} />
      {flow.running ? flow.snapshot.state === "cancelling" ? "取消中…" : "开发中…" : "开始开发"}
    </button>
    <button type="button" className="sv-icon-btn" aria-label="配置开始开发流程" title="配置开始开发流程" disabled={!flow.root || flow.running} onClick={edit}><Icon name="settings" size={14} /></button>
    <Dialog open={open} onClose={() => setOpen(false)} ariaLabel="开始开发流程设置">
      <DialogHeader><DialogTitle>开始开发</DialogTitle><button type="button" className="sv-icon-btn" aria-label="关闭开发流程设置" onClick={() => setOpen(false)}><Icon name="close" size={16} /></button></DialogHeader>
      <p className="development-note">按顺序完成准备与启动，失败或取消时停止后续步骤。</p>
      <div className="development-steps">
        <label><input type="checkbox" checked={draft.compile} onChange={(e) => change("compile", e.target.checked)} /><span>编译工程</span><small>可选 · 读取磁盘版本</small></label>
        <label><input type="checkbox" checked={draft.deploy} onChange={(e) => change("deploy", e.target.checked)} /><span>投送元数据</span><small>可选 · 本流程只投送一次</small></label>
        <div><Icon name="server" size={14} /><span>启动或复用中间件</span></div>
        {draft.client && <div><Icon name="plug" size={14} /><span>等待客户端实际连接目标可达</span></div>}
        <label><input type="checkbox" checked={draft.client} onChange={(e) => change("client", e.target.checked)} /><span>启动客户端</span></label>
      </div>
      <label className="development-option"><input type="checkbox" checked={draft.debug} onChange={(e) => change("debug", e.target.checked)} /><span>下次启动带调试</span></label>
      <label className="development-option"><input type="checkbox" checked={draft.autoAttach} disabled={!draft.debug} onChange={(e) => change("autoAttach", e.target.checked)} /><span>启动完成后自动附加调试器</span></label>
      <p className="development-note">已运行的服务保留当前参数。取消会停止本流程尚未完成的新启动，原有运行服务保留。编译前请先保存文件。</p>
      {error && <p className="development-error" role="alert">{error}</p>}
      <div className="development-dialog-actions"><button type="button" className="sv-btn" onClick={() => save(false)}>保存设置</button><button type="button" className="sv-btn sv-btn-primary" disabled={locked} onClick={() => save(true)}><Icon name="play" size={13} />保存并开始</button></div>
    </Dialog>
  </div>;
}
