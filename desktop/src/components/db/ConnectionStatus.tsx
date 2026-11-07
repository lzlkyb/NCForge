import { Icon } from "../ui/icon";
import type { ConnRuntime } from "../../lib/dbStore";

const statusInfo = {
  connected: {label:"已连接", icon:"check"},
  connecting: {label:"连接中", icon:"clock"},
  error: {label:"连接失败", icon:"alert"},
  idle: {label:"未连接", icon:"minimize"},
} as const;

export function ConnectionStatus({ status, className = "" }: { status: ConnRuntime["status"]; className?: string }) {
  const {label, icon} = statusInfo[status];
  return <span className={("dbx-conn-status " + className).trim()} data-state={status}><Icon name={icon} size={12} />{label}</span>;
}
