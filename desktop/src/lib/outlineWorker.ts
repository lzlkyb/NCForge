import { localDocumentOutline } from "./localDocumentOutline";
// id 由 outlineWorkerHost 发放并原样带回：常驻实例上多个请求靠它区分。
self.onmessage = (event: MessageEvent<{ id: number; path: string; text: string }>) => {
  const symbols = localDocumentOutline(event.data.path, event.data.text);
  self.postMessage({ id: event.data.id, symbols });
};
