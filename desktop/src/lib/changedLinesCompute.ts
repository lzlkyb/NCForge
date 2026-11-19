import { computeChanged, type ChangedSnapshot } from "./changedLines";

interface Model {
  getVersionId(): number;
  getValue(): string;
  isDisposed(): boolean;
}

const cache = new WeakMap<Model, { version: number; base: string; snapshot: ChangedSnapshot }>();

export function cachedChanged(model: Model, base: string): ChangedSnapshot | undefined {
  const previous = cache.get(model);
  return previous?.version === model.getVersionId() && previous.base === base ? previous.snapshot : undefined;
}

/** Model lifetime bounds the cache; version and baseline together prevent stale restore actions. */
export function computeModelChanged(model: Model, base: string, signal: AbortSignal): Promise<ChangedSnapshot | null> {
  if (signal.aborted || model.isDisposed()) return Promise.resolve(null);
  const previous = cachedChanged(model, base);
  if (previous) return Promise.resolve(previous);
  const version = model.getVersionId();
  return new Promise(resolve => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (snapshot: ChangedSnapshot | null) => {
      if (done) return;
      done = true;
      worker?.terminate();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted || model.isDisposed() || model.getVersionId() !== version) snapshot = null;
      if (snapshot) cache.set(model, { version, base, snapshot });
      resolve(snapshot);
    };
    const abort = () => finish(null);
    // Older hosts and test environments can lack workers. Keep fallback out of the model switch stack.
    const fallback = () => { worker?.terminate(); timer = setTimeout(() => {
      if (signal.aborted || model.isDisposed() || model.getVersionId() !== version) finish(null);
      else finish(computeChanged(base, model.getValue()));
    }, 0); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (typeof Worker === "undefined") { fallback(); return; }
      worker = new Worker(new URL("./changedLinesWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<ChangedSnapshot>) => finish(event.data);
      worker.onerror = fallback;
      worker.postMessage({ base, text: model.getValue() });
    } catch { fallback(); }
  });
}
