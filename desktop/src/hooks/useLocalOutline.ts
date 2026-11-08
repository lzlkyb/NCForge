import { useEffect, useState } from "react";
import { getModel } from "../lib/editorStore";
import { currentDocumentOutline } from "../lib/documentOutlineModel";
import type { FlatSymbol } from "../lib/symbols";

const empty: FlatSymbol[] = [];

export function useLocalOutline(path: string | null, mtimeMs?: number): FlatSymbol[] {
  const [data, setData] = useState<{ path: string; symbols: FlatSymbol[] }>();
  useEffect(() => {
    if (!path) return;
    let worker: Worker | undefined;
    let disposed = false;
    const update = () => {
      worker?.terminate();
      worker = undefined;
      const model = getModel(path);
      if (!model || model.getValueLength() < 32 * 1024 || typeof Worker === "undefined") {
        setData({ path, symbols: currentDocumentOutline(path) });
        return;
      }
      if (model.getValueLength() > 512 * 1024) { setData({ path, symbols: [] }); return; }
      const version = model.getVersionId();
      const task = new Worker(new URL("../lib/outlineWorker.ts", import.meta.url), { type: "module" });
      worker = task;
      task.onmessage = (event: MessageEvent<FlatSymbol[]>) => {
        // A stale parse must never overwrite symbols for a newer edit or replacement model.
        if (!disposed && getModel(path) === model && model.getVersionId() === version) setData({ path, symbols: event.data });
        task.terminate();
        if (worker === task) worker = undefined;
      };
      task.onerror = () => { task.terminate(); if (worker === task) worker = undefined; };
      task.postMessage({ path, text: model.getValue() });
    };
    update();
    let timer = 0;
    const subscription = getModel(path)?.onDidChangeContent(() => {
      worker?.terminate();
      worker = undefined;
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 180);
    });
    return () => { disposed = true; worker?.terminate(); window.clearTimeout(timer); subscription?.dispose(); };
  }, [path, mtimeMs]);
  return data?.path === path && path !== null ? data.symbols : empty;
}
