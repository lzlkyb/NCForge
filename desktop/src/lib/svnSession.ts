import type { RightMode } from "../components/svn/RightPane";
import { showWorkbenchDocument } from "./dockEvents";
import { createSessionStore, useSessionStore } from "./sessionStore";

/**
 * 版本控制页的两个视图。
 *
 * `patch` 不是独立页签：补丁清单与改动清单是同一份工作副本的两条读法
 * （一个用来审、一个用来打包），拆成两页等于为同一件事跑两遍扫描、还让
 * 「改完 → 打包」多一次跨页跳转。页签层面只保留「版本控制」。
 */
export type SvnPage = "review" | "patch";

/**
 * 版本控制页会话态（P2-9）：页内视图 / 选中项 / 右栏视图模式 / 是否显示忽略文件。
 *
 * 审查动线是「版本控制页看 diff → 文件页改代码 → 回来审下一个」，选中项与
 * 视图模式丢了就等于每切一次页重新找位置。提交/撤销成功后 selectedPath 会被
 * 清空（SvnReview 的 onCommitted / onReverted）——那是业务语义不是丢状态，
 * 清空同样走 set，切页回来后保持已清空的状态。
 *
 * busy / auth / revertOpen 等瞬时操作态**不**放这里：操作进行中切页属于
 * 异常路径，重新挂载理应回到干净的稳态。
 */
export interface SvnView {
  page: SvnPage;
  showIgnored: boolean;
  selectedPath: string | null;
  mode: RightMode;
}

export const svnSession = createSessionStore<SvnView>({
  page: "review",
  showIgnored: false,
  selectedPath: null,
  mode: "diff",
});

export const useSvnView = (): SvnView => useSessionStore(svnSession);

/**
 * 从别处（命令面板、编辑器的「打包补丁」入口）直达补丁视图。
 *
 * 先切页内视图再发导航事件：顺序反过来时 SvnTab 会先按 review 挂载一帧，
 * 再被切成 patch，补丁扫描白跑一次。事件与版本控制页签共用同一条管道，
 * 外壳仍是导航的唯一入口。
 */
export function openPatchPage(): void {
  svnSession.set({ page: "patch" });
  window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "svn" }));
  // 已经在版本控制页、但停在源码视图时，导航事件不改变任何 state；
  // 这条信号负责把文档区翻出来，否则「打开补丁打包」只是悄悄换了页内视图。
  showWorkbenchDocument();
}
