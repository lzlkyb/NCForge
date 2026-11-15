import { useDelayedBusy } from "../../hooks/useDelayedBusy";
import { Icon } from "./icon";

/** Stable icon slot; short operations never flash a spinner. Label the owner. */
export function BusyIndicator({ active = true, size = 14, className = "", operationKey }: {
  active?: boolean; size?: number; className?: string; operationKey?: string | number;
}) {
  const visible = useDelayedBusy(active, operationKey);
  return active ? <span className={`ui-busy-indicator ${className}`} data-visible={visible || undefined}
    style={{ width: size, height: size }} aria-hidden="true"><Icon name="spinner" size={size} className="animate-spin" /></span> : null;
}
