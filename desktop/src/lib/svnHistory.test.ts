import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));
import { filterHistory, svnBlameSnapshot, svnResolveWorking, type HistoryEntry } from "./svnHistory";
import { getSession, setSession } from "./workspaceSession";
import { invalidateWorkspaceRequests } from "./workspaceEpoch";
import { getSvnWrite } from "./svnWrite";
let originalRoot: string | null | undefined;
beforeEach(() => { originalRoot = getSession().root; setSession({ root: "D:/source" }); mocks.invoke.mockReset(); });
afterEach(() => { setSession({ root: originalRoot }); });
describe("SVN 固定来源读取与冲突写操作", () => {
  it("工程切换后拒绝旧追溯结果", async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const request = svnBlameSnapshot("D:/source/A.java");
    await Promise.resolve();
    setSession({ root: "D:/other" }); finish({ sourceRevision: 3, text: "old", lines: [] });
    await expect(request).rejects.toThrow("来源工程已切换");
    expect(mocks.invoke).toHaveBeenCalledWith("svn_blame_snapshot", { root: "D:/source", path: "D:/source/A.java", revision: 0 });
  });
  it("切走再回同根目录也拒绝旧结果", async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const request = svnBlameSnapshot("D:/source/A.java"); await Promise.resolve(); invalidateWorkspaceRequests(); finish({ sourceRevision: 3, text: "old", lines: [] });
    await expect(request).rejects.toThrow("本次结果已忽略");
  });
  it("保留合并结果先同步锁住工作副本，重复触发只有一次写入", async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const request = svnResolveWorking("D:/source/A.java");
    expect(getSvnWrite("D:/source")?.kind).toBe("resolve");
    await expect(svnResolveWorking("D:/source/A.java")).rejects.toThrow("正在执行写操作");
    expect(mocks.invoke).toHaveBeenCalledTimes(1); finish({ backupDir: "D:/backup" });
    await expect(request).resolves.toEqual({ backupDir: "D:/backup" }); expect(getSvnWrite("D:/source")).toBeNull();
  });
});
it("已加载历史按说明或路径、作者与日期组合筛选", () => {
  const entries: HistoryEntry[] = [
    { revision: 5, author: "alice", date: new Date("2026-11-04T12:00:00").getTime(), message: "fix SQL", paths: [{ path: "/module/A.java", action: "M", copyFromPath: null, copyFromRevision: -1 }] },
    { revision: 4, author: "bob", date: new Date("2026-11-03T12:00:00").getTime(), message: "other", paths: [] },
  ];
  expect(filterHistory(entries, "a.java", "alice", "2026-11-04", "2026-11-04").map(entry => entry.revision)).toEqual([5]);
  expect(filterHistory(entries, "SQL", "bob", "", "")).toEqual([]);
});
