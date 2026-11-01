import { useEffect } from "react";
import { loadBreakpoints } from "../lib/breakpoints";

/**
 * 换工作区时把断点存储切到对应那份 localStorage。
 *
 * 单独成一个 hook：文件页的 useState/useEffect 已经到体量门禁的边上，
 * 而这条接线只服务编辑器行号槽（EditorPane 拿不到 root）。
 */
export function useBreakpointsRoot(root: string | null | undefined): void {
  useEffect(() => {
    loadBreakpoints(root ?? "");
  }, [root]);
}
