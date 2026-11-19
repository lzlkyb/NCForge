import { computeChanged } from "./changedLines";

self.onmessage = (event: MessageEvent<{ base: string; text: string }>) => {
  self.postMessage(computeChanged(event.data.base, event.data.text));
};
