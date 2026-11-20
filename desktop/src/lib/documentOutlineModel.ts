import { getModel } from "./editorStore";
import { localDocumentOutline } from "./localDocumentOutline";
import { requestOutline } from "./outlineWorkerHost";
import type { FlatSymbol } from "./symbols";

type Model = NonNullable<ReturnType<typeof getModel>>;
const empty: FlatSymbol[] = [];
export const OUTLINE_READY = "ncforge:outline-ready";
const pending = new WeakMap<Model, { version: number; cancel: () => void }>();
const disposeHooks = new WeakMap<Model, { dispose(): void }>();
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
      running?.cancel();
      // 常驻共享 worker：只取消旧请求，不销毁实例。
      const cancel = requestOutline(path, model.getValue(), symbols => {
        if (getModel(path) === model && model.getVersionId() === version) {
          cache.set(model, { version, symbols });
          window.dispatchEvent(new CustomEvent(OUTLINE_READY, { detail: path }));
        }
        if (pending.get(model)?.cancel === cancel) pending.delete(model);
      }, () => {
        // worker 异常：清掉 pending，下次调用重试（否则同版本永远卡在空纲）。
        if (pending.get(model)?.cancel === cancel) pending.delete(model);
      });
      pending.set(model, { version, cancel });
      if (!disposeHooks.has(model)) {
        disposeHooks.set(model, model.onWillDispose?.(() => {
          pending.get(model)?.cancel();
          pending.delete(model);
        }) ?? { dispose() {} });
      }
    }
    return previous?.symbols ?? empty;
  }
  const symbols = localDocumentOutline(path, model.getValue());
  cache.set(model, { version, symbols });
  return symbols;
}
