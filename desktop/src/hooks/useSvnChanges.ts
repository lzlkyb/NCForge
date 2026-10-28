import { useCallback } from "react";
import { toast } from "../components/ui/toast";
import {
  friendlySvnError,
  parseSvnError,
  svnCommit,
  svnResolve,
  svnRevert,
  svnUpdate,
} from "../lib/svn";

type Busy = null | "commit" | "update" | "revert" | "resolve" | "auth";

/**
 * 会改工作副本/仓库的四个动作（更新、提交、撤销、解决冲突）。
 *
 * 单独一个 hook：这些动作都有「认证失败要弹账号框」这一条公共分支，
 * 放在页面里会和布局代码缠在一起。每个动作成功后都必须 `refresh()`——
 * 界面上显示的改动数、审查进度全来自那次扫描，不重扫就是错的。
 */
export function useSvnChanges({
  setBusy,
  setAuth,
  refresh,
  onCommitted,
  onReverted,
}: {
  setBusy: (b: Busy) => void;
  setAuth: (a: { open: boolean; error: string | null }) => void;
  refresh: () => void;
  onCommitted: () => void;
  onReverted: () => void;
}) {
  const handle = useCallback(
    (e: unknown) => {
      if (parseSvnError(e).code === "auth") {
        setAuth({ open: true, error: null });
        return;
      }
      toast(friendlySvnError(e), "error");
    },
    [setAuth],
  );

  const doUpdate = useCallback(async () => {
    setBusy("update");
    try {
      const r = await svnUpdate();
      if (r.conflicts.length > 0) {
        toast(`已更新到 r${r.revision}，${r.conflicts.length} 个文件有冲突待处理`, "warning");
      } else {
        toast(`已更新到 r${r.revision}`, "success");
      }
      refresh();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(null);
    }
  }, [handle, refresh, setBusy]);

  const doCommit = useCallback(
    async (message: string, paths: string[]) => {
      setBusy("commit");
      try {
        const r = await svnCommit(paths, message);
        const added = r.added.length > 0 ? `，新增 ${r.added.length} 个` : "";
        toast(`已提交为 r${r.revision}（${paths.length} 个文件${added}）`, "success");
        onCommitted();
        refresh();
      } catch (e) {
        handle(e);
      } finally {
        setBusy(null);
      }
    },
    [handle, onCommitted, refresh, setBusy],
  );

  const doRevert = useCallback(
    async (paths: string[], recursive: boolean) => {
      setBusy("revert");
      try {
        const r = await svnRevert(paths, recursive);
        // 给全路径：备份目录在工作区旁边而不是里面，只报个目录名用户找不到
        toast(`已撤销 ${r.count} 处改动，备份在 ${r.backupDir}`, "success");
        onReverted();
        refresh();
      } catch (e) {
        handle(e);
      } finally {
        setBusy(null);
      }
    },
    [handle, onReverted, refresh, setBusy],
  );

  const doResolve = useCallback(
    async (path: string, choice: "mine" | "theirs" | "base") => {
      setBusy("resolve");
      try {
        await svnResolve(path, choice);
        toast("冲突已解决，记得重新编译这个类", "success");
        onReverted();
        refresh();
      } catch (e) {
        handle(e);
      } finally {
        setBusy(null);
      }
    },
    [handle, onReverted, refresh, setBusy],
  );

  return { doUpdate, doCommit, doRevert, doResolve };
}
