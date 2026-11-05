import { useEffect, useState } from "react";
import { getModel } from "../lib/editorStore";
import { currentDocumentOutline } from "../lib/documentOutlineModel";
import type { FlatSymbol } from "../lib/symbols";

const empty: FlatSymbol[] = [];

export function useLocalOutline(path: string | null, mtimeMs?: number): FlatSymbol[] {
  const [data, setData] = useState<{ path: string; symbols: FlatSymbol[] }>();
  useEffect(() => {
    if (!path) return;
    const update = () => setData({ path, symbols: currentDocumentOutline(path) });
    update();
    let timer = 0;
    const subscription = getModel(path)?.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 180);
    });
    return () => { window.clearTimeout(timer); subscription?.dispose(); };
  }, [path, mtimeMs]);
  return data?.path === path && path !== null ? data.symbols : empty;
}
