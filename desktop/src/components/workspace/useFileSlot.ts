import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { useWorkbenchDock, type FileSlotName } from "./WorkbenchDock";

/**
 * 槽位投递器。
 *
 * 宿主在首帧还没挂上（frame 的 ref 回调比渲染晚一拍），返回 null 即可：
 * `fileHosts` 变化会让 dock context 换新值，订阅它的组件下一帧就进去了。
 * 没有 dock（单测里直接渲染）时退回行内渲染，至少内容还在。
 */
export function useFileSlot() {
  const dock = useWorkbenchDock();
  return (name: FileSlotName, node: ReactNode) => {
    if (!node) return null;
    const host = dock?.fileHosts[name];
    return host ? createPortal(node, host) : dock ? null : node;
  };
}
