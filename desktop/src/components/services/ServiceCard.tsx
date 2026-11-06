import { ServiceRunToolbar, type ServiceRunToolbarProps } from "./ServiceRunToolbar";
/** 中间件操作与当前控制台绑定，运行详情在按需侧栏中展示。 */
export function ServiceCard(props: Omit<ServiceRunToolbarProps, "source">) {
  return <ServiceRunToolbar {...props} source="middleware" />;
}
