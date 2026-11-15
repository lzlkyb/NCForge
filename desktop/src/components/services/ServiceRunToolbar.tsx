import type { ReactNode } from "react";
import { Icon } from "../ui/icon";
import { BusyIndicator } from "../ui/BusyIndicator";
import { Menu, MenuItem } from "../ui/Menu";
import { serviceNames, servicePresentation, type ServiceBusy, type ServiceSource, type ServiceStatus } from "../../lib/servicePresentation";

export interface ServiceRunToolbarProps {
  source: ServiceSource;
  status: ServiceStatus | null;
  busy: ServiceBusy;
  failed?: boolean;
  debugMode: boolean;
  onStart: (debug?: boolean) => void;
  onStop: () => void;
  onRestart: () => void;
  onRetry: () => void;
  debugAttached: boolean;
  debugBusy: boolean;
  onAttachDebug: () => void;
  onDetachDebug: () => void;
  workflowBusy?: boolean;
  navigator?: ReactNode;
  /** 标题后的附加标记（如热替换的「代码不是最新」）。 */
  marker?: ReactNode;
  tools?: ReactNode;
}
export function ServiceRunToolbar({ source, status, busy, failed, debugMode, onStart, onStop, onRestart, onRetry, debugAttached, debugBusy, onAttachDebug, onDetachDebug, workflowBusy, navigator, marker, tools }: ServiceRunToolbarProps) {
  const view = servicePresentation(source, status, failed, busy);
  const preparing = view.state === "starting" || (view.conflict && status?.state === "starting");
  const running = view.state === "running";
  const disabled = !!busy || !!workflowBusy;
  const subtitle = status?.launchPhase || (status?.pid ? `PID ${status.pid} · ${view.endpoint}` : "下次启动使用当前工程配置");
  return <header className="sc-run-toolbar" data-state={view.state}>
    <div className="sc-run-heading">{navigator ?? <><strong>{serviceNames[source]}</strong><span className="sc-status-badge" data-tone={view.tone} role="status">
      <BusyIndicator active={["starting", "stopping", "loading"].includes(view.state)} size={11} operationKey={source} />{view.label}
    </span></>}{marker}<span className="sc-run-subtitle" title={subtitle}>{subtitle}</span></div>
    <div className="sc-run-actions">
      {["unknown", "loading"].includes(view.state) ? <button type="button" className="sv-btn" disabled={view.state === "loading"} onClick={onRetry}><Icon name="refresh" size={13} />重试状态</button> : view.conflict && !preparing ? <span className="sc-action-hint">检查端口占用后再启动</span> : running ? <>
        <button type="button" className="sv-btn sc-debug-action" aria-busy={debugBusy || undefined} disabled={disabled || debugBusy || !status?.debugPort} title={status?.debugPort ? `JDWP 127.0.0.1:${status.debugPort}` : "本次未开启调试；停止后选择调试启动"} onClick={debugAttached ? onDetachDebug : onAttachDebug}>{debugBusy ? <BusyIndicator size={13} operationKey={source} /> : <Icon name="bug" size={13} />}{debugBusy ? "处理中…" : debugAttached ? "断开调试" : "附加调试"}</button>
        <button type="button" className="sv-btn" disabled={disabled} onClick={onRestart}><Icon name="refresh" size={13} />重启</button>
        <button type="button" className="sv-btn sv-btn-danger" disabled={busy === "stop" || busy === "kill"} onClick={onStop}><Icon name="power" size={13} />停止</button>
      </> : preparing || view.state === "stopping" ? <button type="button" className="sv-btn" aria-busy={view.state === "stopping" || undefined} disabled={view.state === "stopping"} onClick={onStop}><Icon name="power" size={13} />{view.state === "stopping" ? "停止中…" : status?.pid ? "停止启动" : "取消启动"}</button> : <div className="sc-launch-split">
        <button type="button" className="sv-btn sv-btn-primary" disabled={disabled} onClick={() => onStart(debugMode)}><Icon name={debugMode ? "bug" : "play"} size={13} />{debugMode ? "调试启动" : "启动"}</button>
        <Menu portal trigger={(open, toggle) => <button type="button" className="sv-btn sv-btn-primary" disabled={disabled} aria-label={`${serviceNames[source]}启动方式`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="chevronDown" size={12} /></button>}>
          {close => <><MenuItem label="普通启动" icon="play" onClick={() => { close(); onStart(false); }} /><MenuItem label="调试启动" hint="开启 JDWP" icon="bug" onClick={() => { close(); onStart(true); }} /></>}
        </Menu>
      </div>}
    </div>
    {tools}
  </header>;
}
