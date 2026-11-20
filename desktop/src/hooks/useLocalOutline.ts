import { useEffect, useState } from "react";
import { getModel } from "../lib/editorStore";
import { currentDocumentOutline } from "../lib/documentOutlineModel";
import { requestOutline } from "../lib/outlineWorkerHost";
import { upmFile } from "../lib/upm";
import { upmSymbols } from "../lib/upmOutline";
import type { FlatSymbol } from "../lib/symbols";

const empty: FlatSymbol[] = [];

export function useLocalOutline(path: string | null, mtimeMs?: number): FlatSymbol[] {
  const [data, setData] = useState<{ path: string; symbols: FlatSymbol[] }>();
  useEffect(() => {
    if (!path) return;
    let cancel: (() => void) | undefined;
    let disposed = false;
    const update = () => {
      cancel?.();
      cancel = undefined;
      const model = getModel(path);
      if (/\.upm$/i.test(path)) {
        // upm 走后端结构化解析（真源 nc_upm::parse），传当前模型文本含未保存修改。
        // 异步回包同样要过陈旧守卫：编辑后的旧结果不能盖掉新内容。
        const version = model?.getVersionId();
        const text = model?.getValue();
        void upmFile(path, text).then(file => {
          if (!disposed && getModel(path) === model && (model == null || model.getVersionId() === version)) {
            setData({ path, symbols: upmSymbols(file, text ?? "") });
          }
        }).catch(() => {
          if (!disposed && getModel(path) === model) setData({ path, symbols: [] });
        });
        return;
      }
      if (!model || model.getValueLength() < 32 * 1024 || typeof Worker === "undefined") {
        setData({ path, symbols: currentDocumentOutline(path) });
        return;
      }
      if (model.getValueLength() > 512 * 1024) { setData({ path, symbols: [] }); return; }
      const version = model.getVersionId();
      // 常驻共享 worker（outlineWorkerHost）：不再每次解析新建 / 销毁实例。
      cancel = requestOutline(path, model.getValue(), symbols => {
        // A stale parse must never overwrite symbols for a newer edit or replacement model.
        if (!disposed && getModel(path) === model && model.getVersionId() === version) setData({ path, symbols });
      });
    };
    update();
    let timer = 0;
    const subscription = getModel(path)?.onDidChangeContent(() => {
      cancel?.();
      cancel = undefined;
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 180);
    });
    return () => { disposed = true; cancel?.(); window.clearTimeout(timer); subscription?.dispose(); };
  }, [path, mtimeMs]);
  return data?.path === path && path !== null ? data.symbols : empty;
}
