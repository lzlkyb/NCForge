import { useRef } from "react";
import { Icon } from "../ui/icon";
import { serviceNames, servicePresentation, type ServiceBusy, type ServiceSource, type ServiceStatus } from "../../lib/servicePresentation";

export type ServiceDrawer = "details" | "config" | "deploy";
interface Props {
  source: ServiceSource;
  onSource: (source: ServiceSource) => void;
  onDrawer: (drawer: ServiceDrawer) => void;
  middleware: { status: ServiceStatus | null; busy: ServiceBusy; failed: boolean };
  client: { status: ServiceStatus | null; busy: ServiceBusy; failed: boolean };
}
export function ServiceNavigator({ source, onSource, onDrawer, middleware, client }: Props) {
  const buttons = useRef<Partial<Record<ServiceSource, HTMLButtonElement>>>({});
  const ids = ["middleware", "client"] as const;
  return <aside className="sc-services" aria-label="服务选择">
    <span className="sc-list-caption">服务</span>
    <div className="sc-service-tabs" role="tablist" aria-label="服务与日志来源" aria-orientation="vertical" onKeyDown={e => {
      const id = e.key === "Home" ? "middleware" : e.key === "End" ? "client" : ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) ? source === "client" ? "middleware" : "client" : null;
      if (id) { e.preventDefault(); onSource(id); buttons.current[id]?.focus(); }
    }}>
      {ids.map(id => {
        const item = id === "middleware" ? middleware : client;
        const view = servicePresentation(id, item.status, item.failed, item.busy);
        return <button key={id} ref={el => { if (el) buttons.current[id] = el; }} id={`sc-service-${id}`} role="tab" type="button" aria-selected={source === id} aria-controls="sc-service-console" tabIndex={source === id ? 0 : -1} onClick={() => onSource(id)}>
          <span className="sc-service-name"><Icon name={id === "middleware" ? "server" : "monitor"} size={15} /><strong>{serviceNames[id]}</strong><i data-tone={view.tone} /></span>
          <span className="sc-service-state">{view.label}</span>
          <span className="sc-service-endpoint" title={view.endpoint}>{id === "client" ? "连接 " : ""}{view.endpoint}</span>
        </button>;
      })}
    </div>
    <div className="sc-side-tools">
      <button type="button" onClick={() => onDrawer("details")}><Icon name="info" size={13} />运行详情</button>
      <button type="button" onClick={() => onDrawer("deploy")}><Icon name="layers" size={13} />元数据投送</button>
      <button type="button" onClick={() => onDrawer("config")}><Icon name="settings" size={13} />启动设置</button>
    </div>
  </aside>;
}
