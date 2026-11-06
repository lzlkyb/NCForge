import { useEffect, useRef } from "react";
import { treeFilterFor, useTreeFilter } from "../../lib/treeFilter";
import { Icon } from "../ui/icon";

export function TreeQuickFilter({ root }: { root: string }) {
  const state = useTreeFilter(root), store = treeFilterFor(root);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (state.open) input.current?.focus(); }, [state.open]);
  if (!state.open) return null;
  return <div className="wb-tree-quick-filter">
    <div><Icon name="search" size={13} /><input ref={input} aria-label="过滤资源树" placeholder="文件名或包名" value={state.text}
      onChange={event => store.set({ text: event.target.value })}
      onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); store.set({ text: "", open: false }); document.querySelector<HTMLButtonElement>('[aria-label="过滤资源树入口"]')?.focus(); } }} />
      <button type="button" className="wb-icon-btn" aria-label="关闭资源树过滤" onClick={() => store.set({ text: "", open: false })}><Icon name="close" size={12} /></button>
    </div><small>过滤已加载的文件和包，目录展开后继续筛选</small>
  </div>;
}
