import type { SecurityBadge } from "../components/layout/SecurityBadgeGroup";

/**
 * 顶栏安全徽章的**数据源范式**（壳子版）。
 *
 * 业务把自家风险标志填进 `SecurityFlags`（全部可选，缺省 = 无风险），
 * 本函数换算成徽章数组；布局件 `Header` 只消费结果，不认识具体风险。
 * 这样「加一种风险」= 加一个 flag + 加一条映射，不动布局。
 *
 * 徽章点击跳转 `tab` 由 App 的导航表解释（壳子里只有 "settings"）。
 */
export interface SecurityFlags {
  /** 边界（白名单/安全开关）是否开启；关闭 = 高危徽章。 */
  boundaryEnabled?: boolean;
  /** 是否只读模式。 */
  readonlyMode?: boolean;
  /** 命令执行是否开启。 */
  shellEnabled?: boolean;
}

export function headerSecurityBadges(flags?: SecurityFlags): SecurityBadge[] {
  return [
    {
      key: "boundary",
      show: !!flags && flags.boundaryEnabled === false,
      label: "边界关闭",
      icon: "alertTriangle",
      danger: true,
      tab: "settings",
      title: "安全边界已关闭，点击前往设置开启",
    },
    {
      key: "readonly",
      show: !!flags?.readonlyMode,
      label: "只读",
      icon: "lock",
      danger: false,
      tab: "settings",
      title: "只读模式已开启",
    },
    {
      key: "shell",
      show: !!flags?.shellEnabled,
      label: "命令执行已开启",
      icon: "terminal",
      danger: true,
      tab: "settings",
      title: "命令执行已开启，点击前往设置关闭",
    },
  ];
}
