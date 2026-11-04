// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { acknowledgeSvnUnknown, clearSvnPicked, completeSvnDraft, getSvnDraft, isSvnCommittable, isSvnPicked, markSvnUnknown, selectSvnPaths, selectSvnReviewed, setSvnMessage, syncSvnDraft, toggleSvnPicked } from "./svnDraft";
import { keyOf, type ChangeItem } from "./svn";
let root = "", id = 0;
const file = (name: string, patch: Partial<ChangeItem> = {}): ChangeItem => ({ path: `${root}/${name}`, rel: name, module: "a", letter: "M", status: "modified", revision: 1, isDir: false, ignored: false, ...patch });
beforeEach(() => { root = `C:/draft-test-${++id}`; localStorage.clear(); });

describe("SVN 提交草稿", () => {
  it("第一次选可提交文件，后续刷新新文件不自动加入", () => {
    const a = file("a.java"), b = file("b.java");
    syncSvnDraft(root, [a]);
    expect(getSvnDraft(root).picked).toEqual(new Set([a.path]));
    syncSvnDraft(root, [a, b]);
    expect(getSvnDraft(root).picked).toEqual(new Set([a.path]));
    expect(getSvnDraft(root).known.has(b.path)).toBe(true);
  });
  it("草稿按工作副本隔离，Windows 大小写和斜杠复用", () => {
    syncSvnDraft(root, [file("a.java")]); setSvnMessage(root, "修复保存");
    const same = root.toUpperCase().replace(/\//g, "\\");
    expect(getSvnDraft(same).message).toBe("修复保存");
    expect(getSvnDraft(`${root}-other`).message).toBe("");
    expect(JSON.parse(localStorage.getItem(`ncforge.svn.draft:${keyOf(root)}`)!).message).toBe("修复保存");
  });
  it("构建产物、冲突、缺失、节点替换和目录不可选；已删除可提交", () => {
    for (const patch of [{ ignored: true }, { letter: "C" }, { letter: "!" }, { letter: "~" }, { isDir: true }]) {
      expect(isSvnCommittable(file("a", patch as Partial<ChangeItem>))).toBe(false);
    }
    expect(isSvnCommittable(file("a", { letter: "D" }))).toBe(true);
  });
  it("刷新移除消失与新冲突文件，不清说明", () => {
    const a = file("a.java"), b = file("b.java");
    syncSvnDraft(root, [a, b]); setSvnMessage(root, "待提交");
    syncSvnDraft(root, [{ ...a, letter: "C" }]);
    expect(getSvnDraft(root).picked.size).toBe(0);
    expect(getSvnDraft(root).message).toBe("待提交");
  });
  it("勾选操作归一路径，清空与仅选已审范围明确", () => {
    const a = file("a.java"), b = file("b.java"); syncSvnDraft(root, [a, b]);
    clearSvnPicked(root); toggleSvnPicked(root, a.path.toUpperCase());
    expect(isSvnPicked(getSvnDraft(root).picked, a.path)).toBe(true);
    expect(getSvnDraft(root).picked.size).toBe(1);
    selectSvnReviewed(root, new Set([keyOf(b.path)]));
    expect(getSvnDraft(root).picked).toEqual(new Set([b.path]));
    selectSvnPaths(root, [a.path, `${root}/not-in-status`]);
    expect(getSvnDraft(root).picked).toEqual(new Set([a.path]));
  });
  it("服务器确认只移除本次项，保留后来编辑的说明", () => {
    const a = file("a.java"), b = file("b.java"); syncSvnDraft(root, [a, b]); setSvnMessage(root, "后续说明");
    completeSvnDraft(root, { message: "本次说明", paths: [a.path] }, { revision: 7, author: "dev", added: [] });
    expect(getSvnDraft(root).picked).toEqual(new Set([b.path]));
    expect(getSvnDraft(root).message).toBe("后续说明");
    expect(getSvnDraft(root).lastCommit?.revision).toBe(7);
  });
  it("完成相同说明会清空说明，刷新不重新勾选刚提交项", () => {
    const a = file("a.java"); syncSvnDraft(root, [a]); setSvnMessage(root, " 本次说明 ");
    completeSvnDraft(root, { message: "本次说明", paths: [a.path] }, { revision: 7, author: "dev", added: [] });
    syncSvnDraft(root, [a]);
    expect(getSvnDraft(root).message).toBe(""); expect(getSvnDraft(root).picked.size).toBe(0);
  });
  it("结果未知持久化，刷新不会自动解除，必须显式核实", () => {
    const a = file("a.java"); syncSvnDraft(root, [a]); setSvnMessage(root, "提交说明");
    markSvnUnknown(root, { message: "提交说明", paths: [a.path] }, "服务器响应丢失");
    syncSvnDraft(root, []);
    expect(getSvnDraft(root).unknown?.paths).toEqual([a.path]);
    expect(JSON.parse(localStorage.getItem(`ncforge.svn.draft:${keyOf(root)}`)!).unknown).toBeTruthy();
    acknowledgeSvnUnknown(root); expect(getSvnDraft(root).unknown).toBeNull();
  });
});
