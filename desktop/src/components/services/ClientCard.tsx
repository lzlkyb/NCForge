import { ServiceRunToolbar, type ServiceRunToolbarProps } from "./ServiceRunToolbar";
/** 客户端保留独立生命周期，运行证据只描述 JVM 与真实连接目标。 */
export function ClientCard(props: Omit<ServiceRunToolbarProps, "source">) {
  return <ServiceRunToolbar {...props} source="client" />;
}
