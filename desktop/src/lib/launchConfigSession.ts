import { createSessionStore } from "./sessionStore";
import type { LaunchKind } from "./launchConfigs";

/**
 * 「当前选中哪条启动配置」的会话态（模块级，P2-9 store）。
 *
 * 为什么不能放组件 state：服务页按 tab 切换整棵卸载，选中态放组件里
 * 「切走再回来就丢」；而读这份选择的有三处——服务抽屉的启动按钮、底部
 * 「开始开发」流程、右侧 Java 运行面板。各放一份就会出现
 * 「抽屉里选了 8G、开发流程起的还是 4G」。
 *
 * 存的是配置 id，`null` = 「默认」（不覆盖任何启动参数）。id 解析成配置
 * 对象要配列表查询（`useLaunchConfigs`）：换工程后 `launches.json` 换了，
 * 旧 id 在新列表里解析不到，自然回落默认——所以这里不监听工作区，
 * 只在切换时整体清空（见 `clearLaunchSelection`）。
 */
export interface LaunchSelection {
  middleware: string | null;
  client: string | null;
  java: string | null;
}

export const launchSelectionStore = createSessionStore<LaunchSelection>({
  middleware: null,
  client: null,
  java: null,
});

export function selectLaunchConfig(kind: LaunchKind, id: string | null): void {
  launchSelectionStore.set(
    kind === "middleware" ? { middleware: id } : kind === "client" ? { client: id } : { java: id },
  );
}

/** 换工作区时调用：旧工程的配置 id 在新工程不存在，选择作废。 */
export function clearLaunchSelection(): void {
  launchSelectionStore.set({ middleware: null, client: null, java: null });
}
