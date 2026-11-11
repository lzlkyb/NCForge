import { useEffect } from "react";

/**
 * 数据库面板内的 Ctrl+S / Cmd+S = 写回（DBeaver 的「Apply data changes」）。
 *
 * 必须限定在结果表里：代码编辑器里 Ctrl+S 是保存文件，两个动作抢同一个键时，
 * 用户在表页按保存会顺手把源文件也写一遍。用事件目标向上找结果表容器来判定，
 * 标签隐藏（`hidden`）时焦点不在里面，因此不会误触发。
 */
export function useSaveShortcut(save: () => void, enabled: boolean, owner: string) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "s") return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target?.closest(".dbx-result-table")) return;
      // 多份结果保活/双栏时，只有焦点所属的结果能接管写回快捷键。
      if (target.closest("[data-result-edit-owner]")?.getAttribute("data-result-edit-owner") !== owner) return;
      // 捕获阶段就要拦：编辑器与浏览器的默认「保存页面」都在冒泡阶段之前生效。
      event.preventDefault();
      event.stopPropagation();
      save();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save, enabled, owner]);
}
