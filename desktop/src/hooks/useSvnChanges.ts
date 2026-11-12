import { useCallback } from "react";
import { toast } from "../components/ui/toast";
import { friendlySvnError, keyOf, parseSvnError, svnCommit, svnResolve, svnRevert, svnUpdate, type CommitResult, type StatusResult } from "../lib/svn";
import { completeSvnDraft, getSvnDraft, markSvnUnknown } from "../lib/svnDraft";
import { assertSvnWorkspace, isUnknownSvnCommitError, prepareSvnSubmit } from "../lib/svnSubmit";
import { getSession } from "../lib/workspaceSession";
import { workspaceEpoch } from "../lib/workspaceEpoch";
import { trackOperation, waitForFileOperations } from "../lib/operations";
import { getSvnWrite, useSvnWrite, withSvnWriteLock } from "../lib/svnWrite";
import { invalidateBaselines } from "../lib/changedLinesStore";

type Busy = null | "commit" | "update" | "revert" | "resolve" | "auth";

/** 工作副本写锁从预检起保持到扫描收尾；服务器确认与扫描失败分别记账。 */
export function useSvnChanges({ setBusy, setAuth, refresh, onCommitted, onReverted }: {
  setBusy: (busy: Busy) => void;
  setAuth: (auth: { open: boolean; error: string | null }) => void;
  refresh: (force?: boolean) => Promise<StatusResult | undefined>;
  onCommitted: () => void;
  onReverted: () => void;
}) {
  const root = getSession().root ?? "";
  const writeBusy = useSvnWrite(root);
  const handle = useCallback((error: unknown) => {
    if (parseSvnError(error).code === "auth") { setAuth({ open: true, error: null }); return; }
    toast(friendlySvnError(error), "error");
  }, [setAuth]);
  const rescan = useCallback(async (actionRoot: string, epoch: number, prefix: string) => {
    if (getSession().root !== actionRoot || workspaceEpoch() !== epoch) return undefined;
    try {
      assertSvnWorkspace(actionRoot, epoch);
      // 写操作之后一律全量：更新/提交/撤销改的是盘上的真实状态，靠脏模块省几秒，
      // 一旦 watcher 漏标就是「界面说已提交、实际没动」。
      const scanned = await refresh(true);
      assertSvnWorkspace(actionRoot, epoch);
      if (!scanned) throw new Error("扫描结果未返回");
      // commit / update / revert / resolve 都会改 BASE：清掉基线缓存，
      // 让当前挂载的编辑器按需重取，色条立刻归零（P0-3）。不清的话直到重启都在误报。
      invalidateBaselines();
      return scanned;
    } catch (error) {
      if (getSession().root !== actionRoot || workspaceEpoch() !== epoch) return undefined;
      toast(`${prefix}，但刷新未完成：${friendlySvnError(error)}。请刷新清单核对。`, "warning");
      return undefined;
    }
  }, [refresh]);

  const doCommit = useCallback(async (message: string, paths: string[]): Promise<CommitResult | null> => {
    const actionRoot = getSession().root ?? "";
    const epoch = workspaceEpoch();
    const snapshot = { message: message.trim(), paths: [...new Map(paths.map(path => [keyOf(path), path])).values()] };
    if (!snapshot.message || snapshot.paths.length === 0) return null;
    if (getSvnDraft(actionRoot).unknown) { toast("上次提交结果尚未确认，请先核实服务器历史", "warning"); return null; }
    try {
      return await withSvnWriteLock(actionRoot, "commit", async guard => {
        setBusy("commit");
        return trackOperation<CommitResult | null>({ key: `svn.commit:${actionRoot}`, label: "提交 SVN 改动", scope: actionRoot, page: "svn", phase: "检查本次提交范围与未保存内容", errorDetail: error => getSvnDraft(actionRoot).unknown ? "提交结果待确认，请核实服务器历史，确认前不要重试提交" : friendlySvnError(error) }, async operation => {
          const prepared = await prepareSvnSubmit(actionRoot, epoch, snapshot, operation);
          if (!prepared) return null;
          operation.update({ phase: "提交选中文件，等待服务器确认" });
          let result: CommitResult;
          try { result = await svnCommit(prepared.paths, prepared.message, guard); }
          catch (error) {
            if (isUnknownSvnCommitError(error)) markSvnUnknown(actionRoot, prepared, friendlySvnError(error));
            throw error;
          }
          completeSvnDraft(actionRoot, prepared, result);
          toast(`服务器已确认 r${result.revision}，提交 ${prepared.paths.length} 个文件`, "success");
          operation.update({ phase: `服务器已确认 r${result.revision}，刷新工作副本状态` });
          // 旧工程完成只写自己的草稿，不能清空新工程选择或发起新工程扫描。
          if (getSession().root === actionRoot && workspaceEpoch() === epoch) {
            try { onCommitted(); } catch (error) { console.warn("[svn] commit UI callback failed", error); }
            await rescan(actionRoot, epoch, `r${result.revision} 已提交`);
          }
          return result;
        }, result => ({ state: result ? "success" : "cancelled", detail: result ? `服务器已确认提交 r${result.revision}` : "已取消提交，草稿保留" }));
      });
    } catch (error) {
      if (getSvnDraft(actionRoot).unknown) toast("提交结果待确认。请查看服务器历史，核实后再解除待确认状态。", "warning");
      else handle(error);
      return null;
    } finally {
      if (getSession().root === actionRoot && !getSvnWrite(actionRoot)) setBusy(null);
    }
  }, [setBusy, onCommitted, rescan, handle]);

  const doUpdate = useCallback(async () => {
    const actionRoot = getSession().root ?? "", epoch = workspaceEpoch();
    try {
      await withSvnWriteLock(actionRoot, "update", async guard => {
        setBusy("update"); await waitForFileOperations(); assertSvnWorkspace(actionRoot, epoch);
        const result = await svnUpdate(guard);
        if (getSession().root !== actionRoot || workspaceEpoch() !== epoch) return;
        const scanned = await rescan(actionRoot, epoch, `已更新到 r${result.revision}`);
        if (!scanned) return;
        const conflicts = scanned.changes.groups.flatMap(group => group.items).filter(item => item.letter === "C").length;
        toast(`已更新到 r${result.revision}${conflicts ? `，${conflicts} 个文件有冲突待处理` : "，工作副本状态已核对"}`, conflicts ? "warning" : "success");
      });
    } catch (error) { handle(error); }
    finally { if (getSession().root === actionRoot && !getSvnWrite(actionRoot)) setBusy(null); }
  }, [setBusy, rescan, handle]);

  const doRevert = useCallback(async (paths: string[], recursive: boolean) => {
    const actionRoot = getSession().root ?? "", epoch = workspaceEpoch();
    try {
      await withSvnWriteLock(actionRoot, "revert", async guard => {
        setBusy("revert"); await waitForFileOperations(); assertSvnWorkspace(actionRoot, epoch);
        const result = await svnRevert([...paths], recursive, guard);
        toast(`已撤销 ${result.count} 处改动，备份在 ${result.backupDir}`, "success");
        if (getSession().root !== actionRoot || workspaceEpoch() !== epoch) return;
        onReverted(); await rescan(actionRoot, epoch, "本地改动已撤销");
      });
    } catch (error) { handle(error); }
    finally { if (getSession().root === actionRoot && !getSvnWrite(actionRoot)) setBusy(null); }
  }, [setBusy, onReverted, rescan, handle]);

  const doResolve = useCallback(async (path: string, choice: "mine" | "theirs" | "base") => {
    const actionRoot = getSession().root ?? "", epoch = workspaceEpoch();
    try {
      await withSvnWriteLock(actionRoot, "resolve", async guard => {
        setBusy("resolve"); await waitForFileOperations(); assertSvnWorkspace(actionRoot, epoch);
        const result = await svnResolve(path, choice, guard);
        toast(result.backupDir ? `冲突已解决，另一版备份在 ${result.backupDir}。请重新编译这个类` : "冲突已解决，请重新编译这个类", "success");
        if (getSession().root !== actionRoot || workspaceEpoch() !== epoch) return;
        onReverted(); await rescan(actionRoot, epoch, "冲突处理已完成");
      });
    } catch (error) { handle(error); }
    finally { if (getSession().root === actionRoot && !getSvnWrite(actionRoot)) setBusy(null); }
  }, [setBusy, onReverted, rescan, handle]);

  return { doUpdate, doCommit, doRevert, doResolve, writeBusy };
}
