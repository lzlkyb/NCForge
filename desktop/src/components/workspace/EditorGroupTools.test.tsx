// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorGroupTools } from "./EditorGroupTools";
import { getSession, setSession, type TabMeta } from "../../lib/workspaceSession";
import { emptyEditorGroups } from "../../lib/editorGroups";

vi.mock("./TaskMenu", () => ({ TaskMenu: () => <span>任务</span> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const a = "C:/w/A.java", b = "C:/w/B.java";
const session = { selectTab: vi.fn(), openSplit: vi.fn(), closeSplit: vi.fn() };
beforeEach(() => {
  session.selectTab.mockClear();
  setSession({ tabs: [a, b].map((path): TabMeta => ({ path, name: path.split('/').pop() ?? path, dirty: true,
    encoding: "UTF-8", hasBom: false, eol: "LF", mtimeMs: 1, eolChanged: false, readOnly: false, readOnlyReason: null, lines: 1 })),
    editorGroups: { ...emptyEditorGroups(), left: [a], leftActive: a, right: [b], rightActive: b } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<EditorGroupTools root="C:/w" session={session} compiling={false} canCompile onCompile={vi.fn()} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

it("分组菜单也能切换焦点，窄区收起分段按钮后仍能访问左右组且保留未保存文件", async () => {
  for (const [label, path, group] of [["聚焦右编辑器组", b, "right"], ["聚焦左编辑器组", a, "left"]]) {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="编辑器组操作"]')!.click());
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent === label)!;
    await act(async () => item.click());
    expect(getSession().editorGroups?.focused).toBe(group);
    expect(session.selectTab).toHaveBeenLastCalledWith(path);
    expect(getSession().tabs).toHaveLength(2);
    expect(getSession().tabs.every(tab => tab.dirty)).toBe(true);
  }
});
