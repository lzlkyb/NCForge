import { useEffect, useState } from "react";
import { useLocalOutline } from "./useLocalOutline";
import { inLangModule, useLangView } from "../lib/lang";
import { symbolsFor, type FlatSymbol } from "../lib/symbols";
import { isXmlFamily } from "../lib/ncDeclarationOutline";

/** 本地先显示；未保存时只使用当前模型，避免磁盘符号覆盖正在编辑的声明。 */
export function useDocumentSymbols(path: string | null, mtimeMs?: number, dirty = false) {
  const lang = useLangView();
  const supported = !!path && !path.includes("://") && (/\.java$/i.test(path) || isXmlFamily(path));
  const local = useLocalOutline(supported ? path : null, mtimeMs);
  const [remote, setRemote] = useState<{ path: string; symbols: FlatSymbol[] } | null>(null);
  const canAsk = supported && !!path && /\.java$/i.test(path) && !dirty && lang.state === "ready" && inLangModule(path);
  useEffect(() => {
    setRemote(null);
    if (!canAsk || !path) return;
    let alive = true;
    void symbolsFor(path, mtimeMs).then(symbols => { if (alive) setRemote({ path, symbols }); }).catch(() => {});
    return () => { alive = false; };
  }, [path, mtimeMs, canAsk]);
  return { supported, symbols: canAsk && remote?.path === path ? remote.symbols : local };
}
