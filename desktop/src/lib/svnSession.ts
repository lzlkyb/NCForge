import type { RightMode } from "../components/svn/RightPane";
import { createSessionStore, useSessionStore } from "./sessionStore";

/**
 * 版本控制页会话态（P2-9）：选中项 / 右栏视图模式 / 是否显示忽略文件。
 *
 * 审查动线是「版本控制页看 diff → 文件页改代码 → 回来审下一个」，选中项与
 * 视图模式丢了就等于每切一次页重新找位置。提交/撤销成功后 selectedPath 会被
 * 清空（SvnTab 的 onCommitted / onReverted）——那是业务语义不是丢状态，
 * 清空同样走 set，切页回来后保持已清空的状态。
 *
 * busy / auth / revertOpen 等瞬时操作态**不**放这里：操作进行中切页属于
 * 异常路径，重新挂载理应回到干净的稳态。
 */
export interface SvnView {
  showIgnored: boolean;
  selectedPath: string | null;
  mode: RightMode;
}

export const svnSession = createSessionStore<SvnView>({
  showIgnored: false,
  selectedPath: null,
  mode: "diff",
});

export const useSvnView = (): SvnView => useSessionStore(svnSession);
