import { useEffect, useRef } from "react";
import { treeFilterFor, useTreeFilter } from "../../lib/treeFilter";
import { Icon } from "../ui/icon";

/** 输入框里这些键该继续操作树，而不是留在框里。 */
const TREE_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter"]);

export function TreeQuickFilter({ root, onNavigate }: { root: string; onNavigate?: (key: string) => boolean }) {
  const state = useTreeFilter(root), store = treeFilterFor(root);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!state.open) return;
    // 树上打字（speed search）也会把这条过滤条打开。此时焦点还在树里，抢过来会让
    // ↑↓/Enter 全落进输入框，整棵树的键盘导航当场失效——那比过滤条没聚焦难用得多。
    if (document.activeElement?.closest(".wb-tree-list")) return;
    input.current?.focus();
  }, [state.open]);
  if (!state.open) return null;
  return <div className="wb-tree-quick-filter">
    <div data-focus-container><Icon name="filter" size={14} /><input ref={input} aria-label="过滤资源树" placeholder="文件名或包名" value={state.text}
      onChange={event => store.set({ text: event.target.value })}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        // 敲了名字总要能选中它：方向键 / 回车转给树，焦点仍留在框里继续改词
        if (onNavigate && TREE_KEYS.has(event.key) && onNavigate(event.key)) { event.preventDefault(); return; }
        if (event.key === "Escape") {
          event.preventDefault();
          store.set({ text: "", open: false });
          document.querySelector<HTMLButtonElement>('[aria-label="过滤资源树入口"]')?.focus();
        }
      }} />
      <button type="button" className="wb-icon-btn" aria-label="关闭资源树过滤" onClick={() => store.set({ text: "", open: false })}><Icon name="close" size={16} /></button>
    </div><small>过滤已加载的文件和包，目录展开后继续筛选</small>
  </div>;
}
