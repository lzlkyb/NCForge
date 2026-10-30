import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { svnStatus, svnInfo } from "../../lib/svn";
import { TreeSvnContext } from "./TreeSvnContext";
import { pathKey, treeSvnIndex } from "../../lib/treeSvn";

export function TreeSvnProvider({ root, children }: { root: string; children: ReactNode }) {
  const info = useQuery({ queryKey: ["svn-info"], queryFn: svnInfo, staleTime: 30_000, retry: false });
  // Shared with the review tool: no polling or separate scan per directory.
  const status = useQuery({ queryKey: ["svn-status"], queryFn: svnStatus, staleTime: 30_000, retry: false });
  const belongs = info.data && (pathKey(root) === pathKey(info.data.root) || pathKey(root).startsWith(pathKey(info.data.root) + "/"));
  const index = useMemo(() => treeSvnIndex(root, belongs ? status.data?.changes.groups.flatMap(g => g.items) ?? [] : []), [root, belongs, status.data]);
  const failed = info.isError || status.isError;
  return <TreeSvnContext.Provider value={index}>
    {children}
    <div className="wb-svn-summary"><span title={failed ? String(info.error ?? status.error) : "SVN 工作副本状态"}>
      {status.isFetching || info.isFetching ? "SVN · 正在扫描…" : failed ? "SVN · 读取失败" : !belongs ? "SVN · 非当前工作副本" : `${index.files.size} 个 SVN 变更`}
    </span><button type="button" disabled={status.isFetching || info.isFetching} onClick={() => { void info.refetch(); void status.refetch(); }}>刷新</button></div>
  </TreeSvnContext.Provider>;
}
