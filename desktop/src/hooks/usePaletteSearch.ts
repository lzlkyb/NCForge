import { useEffect, useRef, useState } from "react";
import { failureText } from "../lib/friendlyError";
import { buildItems, type PaletteCtx, type PaletteResult } from "../lib/paletteSources";
import type { PaletteMode } from "../lib/keymap";
import { cancelLibrarySearch } from "../lib/libraryFiles";
import { startUnifiedPalette } from "../lib/unifiedPalette";

export type PaletteLoadState = "loading" | "ready" | "error";

export function usePaletteSearch({ mode, query, ctx }: { mode: PaletteMode; query: string; ctx: PaletteCtx }) {
  const [result, setResult] = useState<PaletteResult>({ items: [], note: "" });
  const [sel, setSel] = useState(0);
  const [loadState, setLoadState] = useState<PaletteLoadState>("loading");
  const [retryTick, setRetryTick] = useState(0);
  const selection = useRef<string | null>(null);
  const queryKey = JSON.stringify([mode, query, ctx.root, ctx.activePath, retryTick]);
  const [resultKey, setResultKey] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // 执行回调用 ref 取最新值；文件与符号数据单独列入依赖，切文件时必须撤销旧查询。
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    if (mode === "search") return;
    selection.current = null;
    setSel(0);
    setLoadState("loading");
    if (mode === "file") {
      return startUnifiedPalette(query, ctxRef.current, (next, pending) => {
        setResult(next);
        setResultKey(queryKey);
        const index = selection.current ? next.items.findIndex(item => item.key === selection.current) : -1;
        if (index < 0) selection.current = null;
        setSel(Math.max(0, index));
        setLoadState(pending ? "loading" : next.retryable ? "error" : "ready");
      });
    }
    let alive = true;
    // 类型搜索要问语言服务：输入时稍等一下再发，
    // 免得每个字符一个请求（`:行号` 是本地解析，不延迟）
    const slow = mode === "type";
    const t = setTimeout(() => {
      buildItems(mode, query, ctxRef.current)
        .then((r) => {
          if (!alive) return;
          setResult(r);
          setResultKey(queryKey);
          setSel(0);
          setLoadState("ready");
        })
        .catch((e) => {
          // 不能吞：工程根读不到、语言服务挂了都会走到这里，静默空列表会被当成「没有这个类」
          if (!alive) return;
          setResult({ items: [], note: failureText("查询", e) });
          setResultKey(queryKey);
          setSel(0);
          setLoadState("error");
        });
    }, slow && query ? 200 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
      if (slow) void cancelLibrarySearch(`library-names:${query.trim()}`);
    };
  }, [mode, query, queryKey, ctx.documentSymbols, ctx.methodsOnly]);

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, result]);

  /** 查询失败后的重试：不换词也要重跑一次 effect。 */
  const retry = () => setRetryTick((n) => n + 1);

  const current = resultKey === queryKey;
  const select = (index: number | ((prev: number) => number)) => {
    if (!current) return;
    const next = typeof index === "number" ? index : index(sel);
    selection.current = result.items[next]?.key ?? null;
    setSel(next);
  };
  return { result, sel, setSel: select, loadState, retry, listRef, canExecute: current && (mode === "file" || loadState === "ready") };
}
