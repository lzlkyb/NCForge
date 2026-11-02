/**
 * 「把文档区切到前台」的跨组件信号。
 *
 * 命令面板与外部事件能直接往模块仓库里开标签，但它们拿不到 WorkbenchFrame 的
 * `showDocument`（那在 dock context 里）。没有这条信号时，从命令面板打开补丁 /
 * 数据字典、而人正停在源码视图，结果只是多了一个标签，屏幕上什么都不变。
 * 外壳由 `ShowDocumentBridge` 监听。
 */
export const SHOW_DOCUMENT_EVENT = "ncforge-show-document";

export function showWorkbenchDocument(): void {
  window.dispatchEvent(new Event(SHOW_DOCUMENT_EVENT));
}
