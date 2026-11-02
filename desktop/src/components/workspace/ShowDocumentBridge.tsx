import { useEffect } from "react";
import { SHOW_DOCUMENT_EVENT } from "../../lib/dockEvents";

/**
 * 把「显示文档区」的跨组件信号接到外壳上。
 *
 * 单独一个组件而不是往 WorkbenchFrame 里再加一个 effect：那个文件已经贴着
 * 8 个 useState/useEffect 的体量门禁，外壳的尺寸/命中区逻辑也不该再挤进
 * 一条与本文件无关的事件桥。
 */
export function ShowDocumentBridge({ show }: { show: () => void }) {
  useEffect(() => {
    const onShow = () => show();
    window.addEventListener(SHOW_DOCUMENT_EVENT, onShow);
    return () => window.removeEventListener(SHOW_DOCUMENT_EVENT, onShow);
  }, [show]);
  return null;
}
