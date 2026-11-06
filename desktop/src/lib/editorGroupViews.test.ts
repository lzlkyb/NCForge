import { expect, it, vi } from "vitest";
import { readGroupView, storeGroupView } from "./editorGroupViews";
import type { monaco } from "./monacoSetup";
const state = vi.hoisted(() => ({ model: {} as object | undefined, common: null as unknown }));
vi.mock("./editorStore", () => ({ getModel: () => state.model, getViewState: () => state.common, saveViewState: (_path: string, value: unknown) => { state.common = value; } }));
type View = monaco.editor.ICodeEditorViewState;
it("共享文本模型保留两组独立光标和滚动；重建模型后不恢复失效缓存", () => {
  const left = { viewState: { scrollTop: 40 } } as View, right = { viewState: { scrollTop: 800 } } as View;
  storeGroupView("left", "A.java", left);
  storeGroupView("right", "A.java", right);
  expect(readGroupView("left", "A.java")).toBe(left);
  expect(readGroupView("right", "A.java")).toBe(right);
  state.model = {}; state.common = null;
  expect(readGroupView("left", "A.java")).toBeNull();
});
