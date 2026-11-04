import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), handlers: new Map<string, (value: unknown) => void>(), unlisten: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke, listen: mocks.listen }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: "D:/project" }) }));
import { getOperations, clearCompletedOperations, cancelOperation, canRetryOperation } from "./operations";
import { patchBuild, type PatchBuildArgs } from "./patch";
import { searchWorkspace, searchProjects, replaceWorkspace } from "./search";
import { svnStatus, svnAuthSet, svnBackupDelete } from "./svn";
import { deployApply, deployStatus } from "./deploy";
import { queryLogs, searchLogs } from "./ncLog";

const BUILD: PatchBuildArgs = { files: ["D:/project/X.java"], outDir: "D:/patch", desc: "change", note: "", sqls: [], date: "20261104" };
const SEARCH = { hits: [], filesScanned: 8, filesMatched: 0, truncated: false, scopeFallback: false, missingDirs: [], scopeDirs: [], elapsedMs: 1 };
const last = () => { const operations = getOperations(); return operations[operations.length - 1]!; };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.listen.mockReset(); mocks.handlers.clear(); mocks.unlisten.mockReset();
  mocks.listen.mockImplementation(async (event, handler) => { mocks.handlers.set(event, handler); return mocks.unlisten; });
  clearCompletedOperations();
});
afterEach(() => { clearCompletedOperations(); });

describe("领域任务反馈", () => {
  it("后台 status、日志轮询和语言兜底搜索不生成任务", async () => {
    mocks.invoke.mockResolvedValue(SEARCH);
    await Promise.all([svnStatus(), deployStatus(), queryLogs({}), searchWorkspace({ text: "X" })]);
    expect(getOperations()).toHaveLength(0);
  });
  it("只有显式搜索产生任务，并准确描述截断与范围回落", async () => {
    mocks.invoke.mockResolvedValue({ ...SEARCH, truncated: true, scopeFallback: true });
    await searchWorkspace({ text: "sensitive-value" }, true);
    expect(last().detail).toContain("结果不完整");
    expect(last().detail).toContain("回落");
    expect(last().label + last().phase + last().detail).not.toContain("sensitive-value");
  });
  it("跨工程读取失败和替换部分失败不会标成全成功", async () => {
    mocks.invoke.mockResolvedValueOnce({ projects: [], errors: ["p: unreadable"], truncated: true, elapsedMs: 1 });
    await searchProjects({ text: "x" });
    expect(last().state).toBe("failed"); expect(last().detail).toContain("未查全");
    mocks.invoke.mockResolvedValueOnce({ filesChanged: 2, replacements: 3, filesScanned: 4, skippedUnsafe: 1, errors: ["read failed"], truncated: true, elapsedMs: 1 });
    await replaceWorkspace({ text: "x" }, "y");
    expect(last().state).toBe("failed"); expect(last().detail).toContain("尚未全部替换");
    expect(canRetryOperation(last().id)).toBe(false);
  });
  it("SVN验证同帧连点只调用一次，不把凭据放入任务摘要", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await Promise.all([svnAuthSet("private-user", "private-password"), svnAuthSet("private-user", "private-password")]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(last())).not.toContain("private-password");
    expect(canRetryOperation(last().id)).toBe(false);
  });
  it("SVN备份部分删除失败保留失败数", async () => {
    mocks.invoke.mockResolvedValue({ deleted: 1, bytes: 10, failed: [{ name: "old", message: "locked" }] });
    await svnBackupDelete(["old"]);
    expect(last().state).toBe("failed"); expect(last().detail).toContain("1 个未删除");
  });
  it("投送部分跳过与优先级冲突写入结果摘要", async () => {
    mocks.invoke.mockResolvedValue({ applied: true, created: [{}], updated: [], conflicts: [{}], skipped: ["gone"] });
    await deployApply();
    expect(last().detail).toContain("跳过 1 个"); expect(last().detail).toContain("1 个冲突");
  });
  it("补丁注册真实条目进度，并等待原操作确认取消", async () => {
    let reject!: (error: unknown) => void;
    mocks.invoke.mockImplementation((cmd) => cmd === "patch_build" ? new Promise((_, rej) => { reject = rej; }) : Promise.resolve());
    const pending = patchBuild(BUILD);
    const observed = pending.catch(e => e);
    await tick();
    mocks.handlers.get("patch:build-progress")?.({ done: 2, total: 10 });
    expect(last().progress).toEqual({ done: 2, total: 10 });
    await cancelOperation(last().id);
    expect(last().state).toBe("cancelling");
    reject("已取消出包：没有生成新的补丁包（旧包未动）");
    await observed;
    expect(last().state).toBe("cancelled"); expect(mocks.unlisten).toHaveBeenCalledOnce();
    const completed = last();
    mocks.handlers.get("patch:build-progress")?.({ done: 9, total: 10 });
    expect(last()).toBe(completed);
  });
  it("取消发出后补丁刚好成功，不谎报未生成", async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockImplementation((cmd) => cmd === "patch_build" ? new Promise(res => { resolve = res; }) : Promise.resolve());
    const pending = patchBuild(BUILD); await tick();
    await cancelOperation(last().id);
    resolve({ zipPath: "D:/patch/out.zip", entries: 12 }); await pending;
    expect(last().state).toBe("success"); expect(last().detail).toContain("12 个 zip 条目");
  });
  it("日志检索截断不会说成全量读取", async () => {
    mocks.invoke.mockResolvedValue({ scannedFiles: ["a"], entries: [], stoppedEarly: true, truncatedFiles: 1 });
    await searchLogs({ query: "private-value", regex: false, caseSensitive: false });
    expect(last().detail).toContain("结果不完整");
    expect(last().detail).not.toContain("private-value");
  });
});
