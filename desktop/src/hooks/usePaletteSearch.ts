/**
 * 快速导航的查询编排：发查询、接收分批结果、维护选中项与加载态、滚动跟随。
 *
 * 从 `QuickPalette` 里搬出来的（组件体量门禁规则 7：单文件 useState+useEffect
 * 不超过 8 个，组件里只剩输入框 / 键盘 / 面板结构）。搬动是逐行搬运，行为不变：
 *
 * - 查询变化时**不清空**上一轮结果：清空会让列表每按一键闪成空白 +「查询中…」，
 *   慢一点就像卡死；代价是列表短暂与输入不匹配，所以 `loadState === "loading"`
 *   期间回车不执行（判定留在组件里，它才知道是回车）。
 * - `#内容` 搜索支持分批：先到的命中立刻铺到列表，不必等全量扫完。
 * - 换词 / 关面板时让后端停掉旧的内容搜索，把磁盘还回去。
 */
import { useEffect, useRef, useState } from "react";
import { failureText } from "../lib/friendlyError";
import { cancelSearch } from "../lib/search";
import { buildItems, PALETTE_SEARCH_SOURCE, type PaletteCtx, type PaletteResult } from "../lib/paletteSources";
import type { PaletteMode } from "../lib/keymap";

export type PaletteLoadState = "loading" | "ready" | "error";

export function usePaletteSearch({ mode, query, ctx }: { mode: PaletteMode; query: string; ctx: PaletteCtx }) {
  const [result, setResult] = useState<PaletteResult>({ items: [], note: "" });
  const [sel, setSel] = useState(0);
  const [loadState, setLoadState] = useState<PaletteLoadState>("loading");
  const [retryTick, setRetryTick] = useState(0);
  const lastKey = useRef("");
  const listRef = useRef<HTMLDivElement>(null);
  // 查询变化很频繁，异步查询的闭包用 ref 拿最新的 ctx，不把它列进 effect 依赖
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    let alive = true;
    const key = `${mode}\u0000${query}`;
    if (lastKey.current !== key) {
      lastKey.current = key;
      setSel(0);
    }
    setLoadState("loading");
    // 类型搜索要问语言服务、`#` 内容搜索要扫整个工程：输入时稍等一下再发，
    // 免得每个字符一个请求（`:行号` 是本地解析，不延迟）
    const slow = mode === "type" || (mode === "file" && query.trim().startsWith("#"));
    const t = setTimeout(() => {
      buildItems(mode, query, ctxRef.current, (partial) => {
        // `#内容` 边扫边出：先到的几批立刻铺到列表里，用户不必盯着空列表等全量扫完。
        // 这些条目都是本次查询的真实命中，所以可以直接回车（不必等到全部扫完）。
        if (!alive) return;
        setResult(partial);
        setSel((s) => Math.min(s, Math.max(0, partial.items.length - 1)));
        setLoadState("ready");
      })
        .then((r) => {
          if (!alive) return;
          setResult(r);
          setSel(0);
          setLoadState("ready");
        })
        .catch((e) => {
          // 不能吞：工程根读不到、语言服务挂了都会走到这里，静默空列表会被当成「没有这个类」
          if (!alive) return;
          setResult({ items: [], note: failureText("查询", e) });
          setSel(0);
          setLoadState("error");
        });
    }, slow && query ? 200 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
      // 换词 / 关面板：旧的 `#` 内容搜索结果已经没人要了，让后端停掉扫描、让出磁盘
      if (mode === "file" && query.trim().startsWith("#")) void cancelSearch(PALETTE_SEARCH_SOURCE);
    };
  }, [mode, query, retryTick]);

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, result]);

  /** 查询失败后的重试：不换词也要重跑一次 effect。 */
  const retry = () => setRetryTick((n) => n + 1);

  return { result, sel, setSel, loadState, retry, listRef };
}
