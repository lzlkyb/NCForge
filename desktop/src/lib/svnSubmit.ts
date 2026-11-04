import { askUnsavedFiles } from "./dbConfirm";
import { getSession, setSession } from "./workspaceSession";
import { isUnsaved } from "./tabDirty";
import { waitForFileOperations, type OperationHandle } from "./operations";
import { workspaceEpoch } from "./workspaceEpoch";
import { keyOf, svnStatus } from "./svn";
import { getSvnDraft, isSvnCommittable, isSvnPicked, type SvnCommitSnapshot } from "./svnDraft";

export function assertSvnWorkspace(root: string, epoch: number): void {
  if (keyOf(getSession().root ?? "") !== keyOf(root) || workspaceEpoch() !== epoch) {
    throw new Error("工作副本已切换，本次提交已停止，请回到原工程重新检查");
  }
}

/** 网络响应丢失不等于服务器没提交：先核实历史，绝不自动重放。 */
export function isUnknownSvnCommitError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  if (/^(auth|conflict|wc)\|/i.test(text)) return false;
  return /^(timeout|unknown)\|/i.test(text) || /E175002|E170013|E170004|connection.*(reset|closed)|unexpected.*eof|broken pipe|桥.*(退出|断开)|响应.*(丢失|超时)/i.test(text);
}

/** 检查的是本次选中文件，不会为了提交一个文件把无关编辑一起保存。 */
export async function prepareSvnSubmit(root: string, epoch: number, snapshot: SvnCommitSnapshot, handle: OperationHandle): Promise<SvnCommitSnapshot | null> {
  handle.update({ phase: "等待已有文件保存，核对编辑器修改" });
  await waitForFileOperations();
  assertSvnWorkspace(root, epoch);
  const keys = new Set(snapshot.paths.map(keyOf));
  const dirty = () => getSession().tabs.filter(tab => keys.has(keyOf(tab.path)) && isUnsaved(tab));
  const targets = dirty();
  let allowDirtyDisk = false;
  if (targets.length > 0) {
    const choice = await askUnsavedFiles(targets.map(tab => ({ path: tab.path, name: tab.name, preview: !!tab.preview })), async onProgress => {
      const [{ saveOne }, { applySaved }] = await Promise.all([import("./fileSave"), import("./tabSession")]);
      const failed: { path: string; name: string; reason: string }[] = [];
      for (let i = 0; i < targets.length; i += 1) {
        assertSvnWorkspace(root, epoch);
        const target = targets[i];
        handle.update({ phase: `保存选中文件 ${i + 1} / ${targets.length}`, progress: { done: i, total: targets.length } });
        const tab = getSession().tabs.find(t => keyOf(t.path) === keyOf(target.path));
        onProgress(i + 1, targets.length);
        if (!tab || !isUnsaved(tab)) continue;
        try {
          const result = await saveOne(tab);
          assertSvnWorkspace(root, epoch);
          setSession({ tabs: tabs => applySaved(tabs, tab.path, result) });
        } catch (error) {
          failed.push({ path: tab.path, name: tab.name, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return failed;
    }, "提交选中文件", true, "svn");
    assertSvnWorkspace(root, epoch);
    if (choice === "cancel") return null;
    allowDirtyDisk = choice === "discard";
    if (!allowDirtyDisk && dirty().length > 0) throw new Error("选中文件在保存期间又有修改，请先保存再提交");
  }
  handle.update({ phase: "重新核对本次文件与冲突状态", progress: undefined });
  const status = await svnStatus();
  assertSvnWorkspace(root, epoch);
  const current = status.changes.groups.flatMap(group => group.items);
  const byKey = new Map(current.map(item => [keyOf(item.path), item]));
  const invalid = snapshot.paths.filter(path => !byKey.has(keyOf(path)) || !isSvnCommittable(byKey.get(keyOf(path))!));
  if (invalid.length > 0) throw new Error(`${invalid.length} 个选中文件已消失、发生冲突或不可提交，请刷新清单后重新选择`);
  if (!allowDirtyDisk && dirty().length > 0) throw new Error("预检期间选中文件又有未保存修改，本次提交已停止");
  const draft = getSvnDraft(root);
  if (draft.unknown) throw new Error("上次提交结果尚未确认，请先核实服务器历史");
  if (draft.initialized && (draft.message.trim() !== snapshot.message || snapshot.paths.some(path => !isSvnPicked(draft.picked,path)))) {
    throw new Error("提交说明或所选文件已变化，本次提交已停止，请重新确认");
  }
  return { message: snapshot.message, paths: snapshot.paths.map(path => byKey.get(keyOf(path))!.path) };
}
