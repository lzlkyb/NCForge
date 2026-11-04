// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabMeta } from "./workspaceSession";
const h = vi.hoisted(() => ({
  session: { root: "", tabs: [] as TabMeta[] }, epoch: 0,
  status: vi.fn(), ask: vi.fn(), wait: vi.fn(), save: vi.fn(), update: vi.fn(),
}));
vi.mock("./workspaceSession", () => ({ getSession: () => h.session, setSession: (patch: { tabs: (tabs: TabMeta[]) => TabMeta[] }) => { h.session.tabs = patch.tabs(h.session.tabs); } }));
vi.mock("./workspaceEpoch", () => ({ workspaceEpoch: () => h.epoch }));
vi.mock("./dbConfirm", () => ({ askUnsavedFiles: h.ask }));
vi.mock("./operations", () => ({ waitForFileOperations: h.wait }));
vi.mock("./svn", () => ({ keyOf: (p: string) => p.replace(/\\/g, "/").toLowerCase(), svnStatus: h.status }));
vi.mock("./fileSave", () => ({ saveOne: h.save }));
vi.mock("./tabSession", () => ({ applySaved: (tabs: TabMeta[]) => tabs }));
import { assertSvnWorkspace, isUnknownSvnCommitError, prepareSvnSubmit } from "./svnSubmit";
import { getSvnDraft, setSvnMessage, syncSvnDraft } from "./svnDraft";
let id = 0;
beforeEach(() => {
  h.session.root = `C:/submit-test-${++id}`; h.session.tabs = []; h.epoch = 0;
  h.status.mockReset(); h.ask.mockReset(); h.wait.mockReset(); h.save.mockReset(); h.update.mockReset();
  h.wait.mockResolvedValue(undefined);
  h.ask.mockResolvedValue("cancel");
  h.status.mockResolvedValue({ changes: { groups: [{ items: [{ path: `${h.session.root}/a.java`, isDir: false, ignored: false, letter: "M" }] }] } });
});
const run = () => prepareSvnSubmit(h.session.root, 0, { message: "修复", paths: [`${h.session.root}/a.java`] }, { id: 1, update: h.update, finish: vi.fn() });
const dirty = () => { h.session.tabs = [{ path: `${h.session.root}/a.java`, name: "a.java", dirty: true, eolChanged: false, readOnly: false } as TabMeta]; };

describe("SVN 提交预检", () => {
  it("先等待已有保存，再确认状态；不会弹无关文件的保存框", async () => {
    h.session.tabs = [{ path: `${h.session.root}/unrelated.java`, dirty: true, readOnly: false } as TabMeta];
    expect((await run())?.paths).toEqual([`${h.session.root}/a.java`]);
    expect(h.wait).toHaveBeenCalledOnce(); expect(h.ask).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenCalledOnce();
  });
  it("保存确认取消时不扫描或提交", async () => {
    dirty(); expect(await run()).toBeNull(); expect(h.status).not.toHaveBeenCalled();
    expect(h.ask.mock.calls[0].slice(2)).toEqual(["提交选中文件", true, "svn"]);
  });
  it("选择磁盘版本保留未保存编辑，只允许提交本次磁盘路径", async () => {
    dirty(); h.ask.mockResolvedValue("discard");
    expect(await run()).toEqual({ message: "修复", paths: [`${h.session.root}/a.java`] });
    expect(h.session.tabs[0].dirty).toBe(true); expect(h.save).not.toHaveBeenCalled();
  });
  it("选择保存只写选中文件，完成后复查状态", async () => {
    dirty();
    h.save.mockImplementation(async () => { h.session.tabs[0].dirty = false; return { mtimeMs: 2 }; });
    h.ask.mockImplementation(async (_files, save) => { expect(await save(vi.fn())).toEqual([]); return "save"; });
    expect(await run()).not.toBeNull(); expect(h.save).toHaveBeenCalledOnce(); expect(h.status).toHaveBeenCalledOnce();
  });
  it("保存完成后继续输入阻止提交，不覆盖新编辑", async () => {
    dirty(); h.ask.mockResolvedValue("save");
    await expect(run()).rejects.toThrow("又有修改"); expect(h.status).not.toHaveBeenCalled();
  });
  it.each(["C", "!", "~"])("复查出现 %s 时停止，不静默缩小或扩大提交集合", async letter => {
    h.status.mockResolvedValue({ changes: { groups: [{ items: [{ path: `${h.session.root}/a.java`, isDir: false, ignored: false, letter }] }] } });
    await expect(run()).rejects.toThrow("不可提交");
  });
  it("选中文件消失时必须重新确认", async () => {
    h.status.mockResolvedValue({ changes: { groups: [] } });
    await expect(run()).rejects.toThrow("选中文件已消失");
  });
  it("同路径工程切走又切回使在途预检失效", async () => {
    h.wait.mockImplementation(async () => { h.epoch += 1; });
    await expect(run()).rejects.toThrow("工作副本已切换"); expect(h.status).not.toHaveBeenCalled();
    expect(() => assertSvnWorkspace("D:/other", h.epoch)).toThrow("工作副本已切换");
  });
  it("预检期间清空选择或编辑说明时停止", async () => {
    const path = `${h.session.root}/a.java`;
    syncSvnDraft(h.session.root, [{ path, isDir: false, ignored: false, letter: "M" } as never]);
    setSvnMessage(h.session.root, "已修改说明");
    await expect(run()).rejects.toThrow("提交说明或所选文件已变化");
    expect(getSvnDraft(h.session.root).message).toBe("已修改说明");
  });
  it("区分网络响应未知与明确认证/冲突拒绝", () => {
    expect(isUnknownSvnCommitError("timeout|提交等待超时")).toBe(true);
    expect(isUnknownSvnCommitError(new Error("other|svn E175002 unexpected EOF"))).toBe(true);
    expect(isUnknownSvnCommitError("auth|需要账号")).toBe(false);
    expect(isUnknownSvnCommitError("conflict|文件有冲突")).toBe(false);
  });
});
