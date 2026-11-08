import { useRef } from "react";
import { Icon } from "../ui/icon";
import { serviceNames, servicePresentation, type ServiceBusy, type ServiceSource, type ServiceStatus } from "../../lib/servicePresentation";

export type ServiceDrawer = "details" | "config" | "deploy";
interface Props {
  source: ServiceSource;
  onSource: (source: ServiceSource) => void;
  middleware: { status: ServiceStatus | null; busy: ServiceBusy; failed: boolean };
  client: { status: ServiceStatus | null; busy: ServiceBusy; failed: boolean };
}
export function ServiceNavigator({ source, onSource, middleware, client }: Props) {
  const buttons = useRef<Partial<Record<ServiceSource, HTMLButtonElement>>>({});
  const ids = ["middleware", "client"] as const;
  return <div className="sc-services">
    <div className="sc-service-tabs" role="tablist" aria-label="服务与日志来源" aria-orientation="horizontal" onKeyDown={e => {
      if (e.nativeEvent.isComposing) return;
      const id = e.key === "Home" ? "middleware" : e.key === "End" ? "client" : ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) ? source === "client" ? "middleware" : "client" : null;
      if (id) { e.preventDefault(); onSource(id); buttons.current[id]?.focus(); }
    }}>
      {ids.map(id => {
        const item = id === "middleware" ? middleware : client;
        const view = servicePresentation(id, item.status, item.failed, item.busy);
        return <button key={id} ref={el => { if (el) buttons.current[id] = el; }} id={`sc-service-${id}`} role="tab" type="button" aria-selected={source === id} aria-controls="sc-service-console" tabIndex={source === id ? 0 : -1} title={`${serviceNames[id]} · ${view.label} · ${id === "client" ? "连接 " : ""}${view.endpoint}`} onClick={() => onSource(id)}>
          <span className="sc-service-name"><Icon name={id === "middleware" ? "server" : "monitor"} size={14} /><strong>{serviceNames[id]}</strong></span>
          <span className="sc-service-state sc-status-badge" data-tone={view.tone}>{view.label}</span>
        </button>;
      })}
    </div>
  </div>;
}
