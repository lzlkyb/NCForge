/** 功能页发起下载，不把资源 Context 的实现耦合到业务页面。 */
export const RESOURCE_DOWNLOAD_EVENT = "ncforge-resource-download";
export const RESOURCE_OPEN_EVENT = "ncforge-resource-open";
export function requestResourceDownload(id: string): void {
  window.dispatchEvent(new CustomEvent(RESOURCE_DOWNLOAD_EVENT, { detail: { id } }));
}
export function openResourceDownloads(): void {
  window.dispatchEvent(new CustomEvent(RESOURCE_OPEN_EVENT));
}
