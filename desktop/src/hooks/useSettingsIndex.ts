import { useLayoutEffect, useState, type RefObject } from "react";
import { collectSettings, type SettingsSearchItem } from "../lib/settingsSearch";

/** 正文异步加载或偏好变化时同步索引；不需要重复维护搜索项或另起轮询。 */
export function useSettingsIndex(pages: RefObject<HTMLElement | null>): SettingsSearchItem[] {
  const [index, setIndex] = useState<SettingsSearchItem[]>([]);
  useLayoutEffect(() => {
    const root = pages.current;
    if (!root) return;
    const refresh = () => {
      const next = collectSettings(root);
      setIndex((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-setting-value", "data-settings-description", "data-settings-keywords", "aria-checked"] });
    return () => observer.disconnect();
  }, [pages]);
  return index;
}
