import { useCallback, useContext, useLayoutEffect, useRef } from "react";
import { pathKey } from "../../lib/treeSvn";
import type { TreeRowsCtx } from "./TreeRows";
import { TreeSvnContext } from "./TreeSvnContext";

type FilterMode = "problems" | "changes";

export function useTreeViewFilter(
  mode: FilterMode | null,
  setMode: (mode: FilterMode | null) => void,
  baseFilter: TreeRowsCtx["filter"],
) {
  const { files, directories } = useContext(TreeSvnContext);
  const treeList = useRef<HTMLDivElement>(null);
  const savedScroll = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (mode || savedScroll.current === null) return;
    if (treeList.current) treeList.current.scrollTop = savedScroll.current;
    savedScroll.current = null;
  }, [mode]);

  const toggleMode = (next: FilterMode) => {
    if (!mode) savedScroll.current = treeList.current?.scrollTop ?? 0;
    setMode(mode === next ? null : next);
  };
  const filterFn: TreeRowsCtx["filter"] = useCallback((name, path, isDir, kind) =>
    baseFilter(name, path, isDir, kind) &&
    (mode !== "changes" || (isDir ? directories : files).has(pathKey(path))),
  [baseFilter, mode, directories, files]);

  return { filterFn, treeList, toggleMode, changeCount: files.size };
}
