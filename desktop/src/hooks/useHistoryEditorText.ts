import { useCallback, useSyncExternalStore } from "react";
import { getModel, getText, onModelLifecycle } from "../lib/editorStore";

/**
 * 历史对比用的「编辑器当前文本」。
 *
 * 🔴 必须订阅 model 的**创建/销毁**，不能只 `getModel(path)?.onDidChangeContent`：
 * 打开历史面板时目标文件的 model 常常还没建好（后台恢复的标签是「先有标签、后读到内容」），
 * 那一刻拿到 undefined 就成了空订阅，而 deps 只有 `[path, enabled]` ⇒ **model 后到位也不会重订阅**，
 * 历史对比静默退化成「与磁盘对比」，用户在编辑器里改了字却看不到差异。
 * 判据同 `EditorPane` 的 `modelGeneration` 依赖。
 */
export function useHistoryEditorText(path: string, enabled: boolean) {
  const subscribe = useCallback((listener: () => void) => {
    if (!enabled) return () => {};
    let content: { dispose: () => void } | undefined;
    const attach = () => {
      content?.dispose();
      content = getModel(path)?.onDidChangeContent(listener);
    };
    attach();
    // model 建好/换掉/关掉都要重挂：只关心本路径，别的文件的变化不该触发重订阅。
    const lifecycle = onModelLifecycle(
      opened => { if (opened === path) { attach(); listener(); } },
      closed => { if (closed === path) { content?.dispose(); content = undefined; listener(); } },
    );
    return () => { lifecycle(); content?.dispose(); };
  }, [path, enabled]);
  const read = useCallback(() => enabled ? getText(path) : undefined, [path, enabled]);
  return useSyncExternalStore(subscribe, read, read);
}
