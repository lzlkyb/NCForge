// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), busy: vi.fn(), auth: vi.fn(), committed: vi.fn(), reverted: vi.fn(), refresh: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: h.invoke, listen: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toast: h.toast }));
vi.mock("../lib/dbConfirm", () => ({ askUnsavedFiles: vi.fn() }));
import { useSvnChanges } from "./useSvnChanges";
import { setSession } from "../lib/workspaceSession";
import { acknowledgeSvnUnknown, getSvnDraft, setSvnMessage, syncSvnDraft } from "../lib/svnDraft";
import { getSvnWrite } from "../lib/svnWrite";
import { clearCompletedOperations, getOperations } from "../lib/operations";
import { invalidateWorkspaceRequests } from "../lib/workspaceEpoch";
import type { ChangeItem } from "../lib/svn";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, workspace = "", path = "", index = 0;
let actions: ReturnType<typeof useSvnChanges>;
let commitResolve: ((value: unknown) => void) | null;
const status = () => ({ changes: { groups: [{ module: "a", items: [{ path, rel: "a.java", module: "a", letter: "M", revision: 1, isDir: false, ignored: false } as ChangeItem] }], shown: 1, total: 1, ignored: 0 }, scanned: 1, reviewed: [], generatedAtMs: 1, hasConflict: false });
function Harness() {
  actions = useSvnChanges({ setBusy: h.busy, setAuth: h.auth, refresh: h.refresh, onCommitted: h.committed, onReverted: h.reverted });
  return <span>{actions.writeBusy?.kind ?? "idle"}</span>;
}
beforeEach(async () => {
  workspace = `C:/changes-hook-${++index}`; path = `${workspace}/a.java`; commitResolve = null;
  Object.values(h).forEach(mock => mock.mockReset());
  setSession({ root: workspace, tabs: [] });
  syncSvnDraft(workspace, status().changes.groups[0].items); setSvnMessage(workspace, "修复保存");
  h.refresh.mockImplementation(async () => status());
  h.invoke.mockImplementation(async (command: string) => {
    if (command === "svn_status") return status();
    if (command === "svn_commit") return { revision: 8, author: "dev", added: [] };
    if (command === "svn_update") return { revision: 9 };
    return null;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  if (commitResolve) await act(async () => commitResolve?.({ revision: 8, author: "dev", added: [] }));
  await act(async () => root.unmount()); host.remove(); clearCompletedOperations();
});

describe("SVN 提交及状态收尾", () => {
  it("同帧重复提交与更新受共同锁保护，只发一次提交", async () => {
    h.invoke.mockImplementation(async (command: string) => {
      if (command === "svn_status") return status();
      if (command === "svn_commit") return new Promise(resolve => { commitResolve = resolve; });
      return { revision: 9 };
    });
    let first!: Promise<unknown>;
    await act(async () => {
      first = actions.doCommit("修复保存", [path]);
      await actions.doCommit("修复保存", [path]);
      await actions.doUpdate();
    });
    expect(getSvnWrite(workspace)?.kind).toBe("commit");
    expect(h.busy.mock.calls[h.busy.mock.calls.length - 1]?.[0]).toBe("commit");
    expect(h.invoke.mock.calls.filter(([command]) => command === "svn_commit")).toHaveLength(1);
    expect(h.invoke.mock.calls.filter(([command]) => command === "svn_update")).toHaveLength(0);
    await act(async () => { commitResolve?.({ revision: 8, author: "dev", added: [] }); await first; });
    commitResolve = null;
    expect(getSvnWrite(workspace)).toBeNull(); expect(h.committed).toHaveBeenCalledOnce();
  });
  it("服务器确认后刷新失败仍保留提交成功，草稿完成且不重放", async () => {
    h.refresh.mockRejectedValueOnce(new Error("扫描失败"));
    await act(async () => { expect((await actions.doCommit("修复保存", [path]))?.revision).toBe(8); });
    expect(getSvnDraft(workspace).message).toBe(""); expect(getSvnDraft(workspace).picked.size).toBe(0);
    expect(getSvnDraft(workspace).lastCommit?.revision).toBe(8);
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("但刷新未完成"), "warning");
    expect(getOperations().find(task => task.key === `svn.commit:${workspace}`)?.state).toBe("success");
  });
  it("服务器响应超时保留草稿并阻止重试，用户核实后才放行", async () => {
    h.invoke.mockImplementation(async command => {
      if (command === "svn_status") return status();
      if (command === "svn_commit") throw new Error("timeout|提交等待超时");
      return null;
    });
    await act(async () => { await actions.doCommit("修复保存", [path]); await actions.doCommit("修复保存", [path]); });
    expect(h.invoke.mock.calls.filter(([command]) => command === "svn_commit")).toHaveLength(1);
    expect(getSvnDraft(workspace).unknown?.paths).toEqual([path]);
    expect(getSvnDraft(workspace).message).toBe("修复保存");
    expect(h.committed).not.toHaveBeenCalled();
    acknowledgeSvnUnknown(workspace);
    await act(async () => { await actions.doCommit("修复保存", [path]); });
    expect(h.invoke.mock.calls.filter(([command]) => command === "svn_commit")).toHaveLength(2);
  });
  it("明确认证拒绝保留草稿并打开账号框，没有未知结果标记", async () => {
    h.invoke.mockImplementation(async command => {
      if (command === "svn_status") return status();
      throw new Error("auth|凭据拒绝");
    });
    await act(async () => { await actions.doCommit("修复保存", [path]); });
    expect(h.auth).toHaveBeenCalledWith({ open: true, error: null });
    expect(getSvnDraft(workspace).unknown).toBeNull(); expect(getSvnDraft(workspace).message).toBe("修复保存");
  });
  it("提交完成前切工程，只记原工程结果，不清新工程选择或刷新", async () => {
    h.invoke.mockImplementation(async command => {
      if (command === "svn_status") return status();
      if (command === "svn_commit") return new Promise(resolve => { commitResolve = resolve; });
      return null;
    });
    let first!: Promise<unknown>;
    await act(async () => { first = actions.doCommit("修复保存", [path]); });
    setSession({ root: "D:/new-workspace" }); invalidateWorkspaceRequests();
    await act(async () => { commitResolve?.({ revision: 8, author: "dev", added: [] }); await first; });
    commitResolve = null;
    expect(getSvnDraft(workspace).lastCommit?.revision).toBe(8);
    expect(h.committed).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });
  it("更新后刷新未返回时不宣称无冲突", async () => {
    h.refresh.mockResolvedValueOnce(undefined);
    await act(async () => { await actions.doUpdate(); });
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("已更新到 r9，但刷新未完成"), "warning");
    expect(h.toast.mock.calls.some(([message, tone]) => tone === "success" && String(message).includes("状态已核对"))).toBe(false);
  });
});
