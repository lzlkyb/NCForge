import { getModel } from "./editorStore";
import { localDocumentOutline } from "./localDocumentOutline";
import type { FlatSymbol } from "./symbols";

type Model = NonNullable<ReturnType<typeof getModel>>;
const empty: FlatSymbol[] = [];
export const OUTLINE_READY = "ncforge:outline-ready";
const pending = new WeakMap<Model, { version: number; worker: Worker }>();
const cache = new WeakMap<Model, { version: number; symbols: FlatSymbol[] }>();

export function currentDocumentOutline(path: string): FlatSymbol[] {
  const model = getModel(path);
  if (!model || model.getValueLength() > 512 * 1024) return empty;
  const version = model.getVersionId();
  const previous = cache.get(model);
  if (previous?.version === version) return previous.symbols;
  if (model.getValueLength() >= 32 * 1024 && typeof Worker !== "undefined") {
    const running = pending.get(model);
    if (running?.version !== version) {
      running?.worker.terminate();
      const worker = new Worker(new URL("./outlineWorker.ts", import.meta.url), { type: "module" });
      pending.set(model, { version, worker });
      const finish = () => { worker.terminate(); disposeListener?.dispose(); if (pending.get(model)?.worker === worker) pending.delete(model); };
      const disposeListener = model.onWillDispose?.(finish);
      worker.onmessage = (event: MessageEvent<FlatSymbol[]>) => {
        if (getModel(path) === model && model.getVersionId() === version) {
          cache.set(model, { version, symbols: event.data });
          window.dispatchEvent(new CustomEvent(OUTLINE_READY, { detail: path }));
        }
        finish();
      };
      worker.onerror = finish;
      worker.postMessage({ path, text: model.getValue() });
    }
    return previous?.symbols ?? empty;
  }
  const symbols = localDocumentOutline(path, model.getValue());
  cache.set(model, { version, symbols });
  return symbols;
}
