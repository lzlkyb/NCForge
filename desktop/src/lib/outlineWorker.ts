import { localDocumentOutline } from "./localDocumentOutline";
self.onmessage = (event: MessageEvent<{ path: string; text: string }>) => {
  self.postMessage(localDocumentOutline(event.data.path, event.data.text));
};
