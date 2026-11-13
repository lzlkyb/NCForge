import { useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { onLocalSave } from "../../lib/localSaves";
import { onExternalJavaChanged } from "../../lib/externalJavaChanges";
import { initReviewMarks, syncReviewMarks } from "../../lib/reviewMarks";
import { getSvnWrite } from "../../lib/svnWrite";
import { svnStatus, svnInfo } from "../../lib/svn";
import { TreeSvnContext } from "./TreeSvnContext";
import { pathKey, treeSvnIndex } from "../../lib/treeSvn";

export function TreeSvnProvider({ root, children }: { root: string; children: ReactNode }) {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["svn-info", root], queryFn: svnInfo, staleTime: 30_000, retry: false });
  // Shared with the review tool: no polling or separate scan per directory.
  const status = useQuery({ queryKey: ["svn-status", root], queryFn: () => svnStatus(), staleTime: 30_000, retry: false });
  useEffect(() => { initReviewMarks(); if (status.data) syncReviewMarks(status.data); }, [status.data]);
  const belongs = info.data && (pathKey(root) === pathKey(info.data.root) || pathKey(root).startsWith(pathKey(info.data.root) + "/"));
  useEffect(() => {
    if (!belongs) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const base = pathKey(root) + "/";
    const schedule = (paths: readonly string[]) => {
      if (!paths.some(path => pathKey(path).startsWith(base))) return;
      clearTimeout(timer);
      // Wait for the watcher to mark the affected SVN modules dirty before scanning.
      timer = setTimeout(() => {
        if (getSvnWrite(root)) return; // 写操作结束时已有一次状态刷新。
        void qc.invalidateQueries({ queryKey: ["svn-status", root] }, { cancelRefetch: false });
      }, 2200);
    };
    const stopSave = onLocalSave(path => schedule([path]));
    const stopExternal = onExternalJavaChanged(schedule);
    return () => { clearTimeout(timer); stopSave(); stopExternal(); };
  }, [belongs, qc, root]);
  const index = useMemo(() => treeSvnIndex(root, belongs ? status.data?.changes.groups.flatMap(g => g.items) ?? [] : []), [root, belongs, status.data]);
  const failed = info.isError || status.isError;
  const fetching = info.isFetching || status.isFetching;
  const errorText = failed ? String(info.error ?? status.error) : undefined;
  const refetchInfo = info.refetch, refetchStatus = status.refetch;
  /**
   * `summary` 与整个 context value 都必须稳定。
   *
   * context 换了引用就会绕过 `TreeRow` 那批 `memo`，让展开着的成千行全部重渲染——
   * 而这里原本每渲染一次就造一个新对象 + 新元素，等于每次父组件抖动都白算一遍。
   */
  const summary = useMemo(
    () => (
      <div className="wb-svn-summary">
        <span title={errorText}>
          {fetching ? "SVN · 正在扫描…" : failed ? "SVN · 读取失败" : !belongs ? "SVN · 非当前工作副本" : `${index.files.size} 个 SVN 变更`}
        </span>
        <button type="button" disabled={fetching} onClick={() => { void refetchInfo(); void refetchStatus(); }}>刷新</button>
      </div>
    ),
    [errorText, fetching, failed, belongs, index, refetchInfo, refetchStatus],
  );
  const value = useMemo(() => ({ ...index, summary }), [index, summary]);
  return <TreeSvnContext.Provider value={value}>{children}</TreeSvnContext.Provider>;
}
