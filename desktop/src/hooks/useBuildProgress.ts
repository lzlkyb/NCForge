import { useEffect } from "react";
import { onBuildProgress } from "../lib/compile";
import { setSession } from "../lib/workspaceSession";

/**
 * 订阅模块级构建进度（`build-progress`）。
 *
 * 单独成 hook：`useModuleCompile` 已经顶着组件体量门禁，而这段订阅与编译动作
 * 没有耦合——只是把事件写进会话，状态栏和面板各自订阅切片。
 */
export function useBuildProgress(): void {
  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;
    void onBuildProgress((p) => setSession({ buildProgress: p }))
      .then((f) => {
        if (cancelled) f();
        else off = f;
      })
      // 拿不到事件通道（测试环境 / WebView 未就绪）时只是没有进度，
      // 不能变成未处理的 rejection。
      .catch(() => {});
    return () => {
      cancelled = true;
      off?.();
      // 卸载（切页）不代表构建结束；保留最后一条进度，回来仍能看到。
      // 真正的清理在下一轮 start() 与 finally 里。
    };
  }, []);
}
