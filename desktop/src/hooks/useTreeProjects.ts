import { useEffect, useState } from "react";
import type { LinkedProject } from "../lib/linkedProjects";
import { resolvableProjects, treeProjects } from "../lib/treeProjects";

interface CacheEntry {
  at: number;
  projects: LinkedProject[];
}

/** 读 `.classpath` 不贵但也不该每次切页都来一遍；30 秒后允许重读。 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export interface TreeProjectsState {
  /** 只有磁盘上真实存在的工程根；当前工作区永远排第一。 */
  projects: LinkedProject[];
  loading: boolean;
  /**
   * 解析失败（`set_workspace` 刚切走、盘暂时不可读等）。
   *
   * 不弹 toast：树退回单工程仍然可用，失败信息留给「工程关联」弹框去说。
   */
  error: string | null;
}

/**
 * 文件树的工程列表。`root` 变了才重新解析；同一 root 下切页回来走缓存。
 */
export function useTreeProjects(root: string | null): TreeProjectsState {
  const key = root ?? "";
  const [state, setState] = useState<TreeProjectsState>(() => {
    const hit = key ? cache.get(key) : undefined;
    return hit
      ? { projects: hit.projects, loading: false, error: null }
      : { projects: [], loading: root !== null, error: null };
  });

  useEffect(() => {
    if (!root) {
      setState({ projects: [], loading: false, error: null });
      return;
    }
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      setState({ projects: hit.projects, loading: false, error: null });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    treeProjects()
      .then((list) => {
        if (!alive) return;
        const projects = resolvableProjects(list);
        cache.set(key, { at: Date.now(), projects });
        setState({ projects, loading: false, error: null });
      })
      .catch((e) => {
        if (!alive) return;
        setState({ projects: [], loading: false, error: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [key, root]);

  return state;
}
