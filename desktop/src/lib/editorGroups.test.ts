import { beforeEach, describe, expect, it } from "vitest";
import { closeRightGroup, emptyEditorGroups, moveGroupFile, removeGroupView, selectGroupFile, swapEditorGroups } from "./editorGroups";
import { getSession, setSession, type TabMeta } from "./workspaceSession";
const a = "C:\\w\\A.java", b = "C:\\w\\B.java", c = "C:\\w\\C.java";
const tab = (path: string) => ({ path, dirty: false, eolChanged: false }) as TabMeta;
beforeEach(() => setSession({ root: "C:\\w", tabs: [tab(a), tab(b), tab(c)], editorGroups: { ...emptyEditorGroups(), left: [a, b, c], leftActive: a } }));
describe("双编辑器组会话", () => {
  it("同一文件可在两组显示，焦点组决定活动上下文", () => {
    setSession({ editorGroups: old => selectGroupFile(old!, "right", b) });
    expect(getSession()).toMatchObject({ activePath: b, splitPath: b });
    expect(getSession().tabs).toHaveLength(3);
    setSession({ editorGroups: old => ({ ...old!, focused: "left" }) });
    expect(getSession().activePath).toBe(a);
    expect(getSession().splitPath).toBe(b);
  });
  it("移走左组最后文件后聚焦右组，不留下空的活动上下文", () => {
    setSession({ tabs: [tab(a)], editorGroups: { ...emptyEditorGroups(), left: [a], leftActive: a } });
    setSession({ editorGroups: old => moveGroupFile(old!, "left", a) });
    expect(getSession()).toMatchObject({ activePath: a, splitPath: a, editorGroups: { left: [], right: [a], focused: "right" } });
  });
  it("仅关闭右组共享视图时保留左组文件，合并时保留所有模型标签", () => {
    setSession({ editorGroups: old => selectGroupFile(old!, "right", b) });
    setSession({ editorGroups: old => removeGroupView(old!, "right", b) });
    expect(getSession().splitPath).toBeNull();
    expect(getSession().tabs).toHaveLength(3);
    setSession({ editorGroups: old => selectGroupFile(moveGroupFile(old!, "left", c), "right", b) });
    setSession({ editorGroups: old => closeRightGroup(old!) });
    expect(getSession()).toMatchObject({ activePath: b, splitPath: null, editorGroups: { left: [a, b, c], right: [] } });
  });
  it("关闭或删除文件清理两组视图、最近列表与活动路径", () => {
    setSession({ editorGroups: old => selectGroupFile(old!, "right", b) });
    setSession({ tabs: tabs => tabs.filter(t => t.path !== b) });
    const state = getSession();
    expect(state.editorGroups?.left).toEqual([a, c]);
    expect(state.editorGroups?.right).toEqual([]);
    expect(state.editorGroups?.recent).not.toContain(b);
    expect(state.activePath).toBe(a);
  });
  it("兼容旧 splitPath API，限制拖动比例且修复大小写重复与失效路径", () => {
    setSession({ splitPath: b });
    setSession({ editorGroups: old => ({ ...old!, left: [a.toLowerCase(), a, "missing"], ratio: 4 }) });
    expect(getSession().editorGroups).toMatchObject({ left: [a, c], right: [b], ratio: .75 });
    setSession({ splitPath: null });
    expect(getSession().editorGroups).toMatchObject({ left: [a, c, b], right: [] });
  });
  it("交换组后保持活动文件并翻转比例，换工程清除旧分组", () => {
    setSession({ editorGroups: old => ({ ...selectGroupFile(old!, "right", b), ratio: .3 }) });
    setSession({ editorGroups: old => swapEditorGroups(old!) });
    expect(getSession()).toMatchObject({ activePath: b, editorGroups: { focused: "left", ratio: .7 } });
    setSession({ root: "D:\\other", tabs: [], activePath: null });
    expect(getSession().editorGroups).toEqual(emptyEditorGroups());
  });
});
