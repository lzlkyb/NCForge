import { useCallback, useEffect, useRef, useState } from "react";
import { linkedProjects, type LinkedGraph } from "../lib/linkedProjects";
import { useWorkspaceRoot } from "../lib/workspaceSession";

export interface LinkedGraphState {
  graph: LinkedGraph | null;
  error: string | null;
  loading: boolean;
  /** 上次成功读到依赖链的时间；失败时清空（旧图也一起清了）。 */
  at: number | null;
}

interface CacheEntry {
  graph: LinkedGraph;
  at: number;
}

/**
 * 读盘解析 .classpath 不便宜，关掉弹框再打开时不必重来一遍。
 * 60 秒后仍会重读：用户改完 `.classpath` 回来看，不该还停在旧图上。
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/** 测试用：模块级缓存会跨用例活着，清掉才能断言「这次到底有没有读盘」。 */
export function clearLinkedGraphCache(): void {
  cache.clear();
}

const freshEntry = (key: string): CacheEntry | null => {
  const entry = cache.get(key);
  return entry && Date.now() - entry.at < CACHE_TTL_MS ? entry : null;
};

const fromCache = (key: string): LinkedGraphState => {
  const entry = freshEntry(key);
  return entry
    ? { graph: entry.graph, error: null, loading: false, at: entry.at }
    : { graph: null, error: null, loading: false, at: null };
};

/**
 * 读当前工作区的依赖闭包。
 *
 * `enabled = false`（弹框关着）时一次盘都不读：模块级缓存只负责「重开时别重复扫」，
 * 不能让它变成隐藏页也在后台扫描。
 *
 * 竞态用序号挡：先点「重新读取」再切工作区，两次请求会同时在路上，**晚发出的那次
 * 才作数**。没有这层保护的话先返回的旧结果会把新图覆盖掉，界面显示一个已经不存在的
 * 工作区，而用户刚点完切换会以为切换失败了。
 */
export function useLinkedGraph(enabled = true) {
  const root = useWorkspaceRoot();
  const key = root ?? "";
  const [state, setState] = useState<LinkedGraphState>(() => fromCache(key));
  const seq = useRef(0);

  const reload = useCallback(
    async (force = false) => {
      const cached = force ? null : freshEntry(key);
      if (cached) {
        setState({ graph: cached.graph, error: null, loading: false, at: cached.at });
        return;
      }
      const mine = seq.current + 1;
      seq.current = mine;
      setState((s) => ({ graph: s.graph, error: null, loading: true, at: s.at }));
      try {
        const graph = await linkedProjects(root ?? undefined);
        if (seq.current !== mine) return;
        const at = Date.now();
        cache.set(key, { graph, at });
        setState({ graph, error: null, loading: false, at });
      } catch (e) {
        // 出错时把旧图一起清掉：留着的话用户看着上一份目录数，会以为「其实读到了」
        if (seq.current === mine) setState({ graph: null, error: String(e), loading: false, at: null });
      }
    },
    [key, root],
  );

  // 工作区换了：旧图和旧缓存都不属于当前目录，先清掉再让下面的 effect 重读
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    seq.current += 1;
    setState(fromCache(key));
  }, [key]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  return { ...state, reload };
}
