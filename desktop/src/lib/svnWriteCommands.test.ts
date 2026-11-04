import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: h.invoke, listen: vi.fn() }));
import { svnCommit, svnResolve, svnRevert, svnUpdate } from "./svn";
import { setSession } from "./workspaceSession";
import { clearCompletedOperations } from "./operations";
let root = "", id = 0;
beforeEach(() => {
  root = `C:/write-command-${++id}`; setSession({ root, tabs: [] }); h.invoke.mockReset();
  h.invoke.mockImplementation(async command => command === "svn_commit" ? { revision: 3, author: "dev", added: [] } : command === "svn_update" ? { revision: 4 } : { count: 1, backupDir: "backup" });
});
afterEach(clearCompletedOperations);
describe("SVN 写命令携带预检来源工作副本", () => {
  it("提交冻结路径数组，expectedRoot由调用时捕获", async () => {
    const paths = [`${root}/a.java`];
    const running = svnCommit(paths, "修复"); paths.push(`${root}/b.java`); setSession({ root: "D:/changed" });
    await running;
    expect(h.invoke).toHaveBeenCalledWith("svn_commit", { paths: [`${root}/a.java`], message: "修复", expectedRoot: root });
  });
  it("更新、撤销和冲突处理都带来源root，撤销冻结数组", async () => {
    await svnUpdate(); expect(h.invoke).toHaveBeenCalledWith("svn_update", { expectedRoot: root });
    const paths = [`${root}/a.java`], pending = svnRevert(paths, false); paths.length = 0;
    await pending;
    expect(h.invoke).toHaveBeenCalledWith("svn_revert", { paths: [`${root}/a.java`], recursive: false, expectedRoot: root });
    await svnResolve(`${root}/a.java`, "mine");
    expect(h.invoke).toHaveBeenCalledWith("svn_resolve", { path: `${root}/a.java`, choice: "mine", expectedRoot: root });
  });
});
