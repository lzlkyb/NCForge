/**
 * 「编辑器里有未保存改动」的广播通道。
 *
 * 为什么单独一个模块：`workspaceSession` 要在标签栏上画未保存圆点，但它不能
 * `import editorStore`——那条链会拉进 Monaco（几 MB）。文件树、搜索页、补丁页
 * 都依赖 workspaceSession，以前等于把它们全绑上了 Monaco。现在 editorStore
 * 往这里发事件，workspaceSession 从这里收，两边互不认识。
 *
 * 事件只在 dirty **真正翻转**时发（不是每次击键），见 editorStore。
 */

type DirtyHandler = (path: string, dirty: boolean) => void;

const listeners = new Set<DirtyHandler>();

/** 订阅未保存状态翻转。返回取消订阅函数。 */
export function onDirtyChange(cb: DirtyHandler): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 由 editorStore 调用；不是 React 状态，不触发组件订阅。 */
export function emitDirty(path: string, dirty: boolean): void {
  listeners.forEach((cb) => cb(path, dirty));
}
