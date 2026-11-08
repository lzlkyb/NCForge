// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorGroupsPane } from "./EditorGroupsPane";
import { getSession, setSession, useWorkspaceSession, type TabMeta } from "../../lib/workspaceSession";
import { emptyEditorGroups } from "../../lib/editorGroups";
import { useFileTabLifecycle } from "../../hooks/useFileTabLifecycle";
import { getCursor } from "../../lib/cursorStore";
import type { useFileSession } from "../../hooks/useFileSession";
import type { EditorNavigation } from "./EditorNavRow";
const h = vi.hoisted(() => ({ closeModel: vi.fn(), resize: null as ((entries: { contentRect: { width: number } }[]) => void) | null }));
vi.mock("../../lib/editorStore", () => ({ closeModel: h.closeModel, renameModel: vi.fn() }));
vi.mock("./EmptyEditor", () => ({ EmptyEditor: () => <span>空编辑器</span> }));
vi.mock("./Breadcrumb", () => ({ Breadcrumb: (props: { active: TabMeta; showSymbols?: boolean }) => <span data-breadcrumb={props.active.path} data-symbols={props.showSymbols}>路径</span> }));
vi.mock("./EditorNavRow", () => ({ EditorNavRow: (props: EditorNavigation) => <div data-reading-tools={props.active.path}>阅读工具</div> }));
vi.mock("./EditorPane", () => ({ EditorPane: (props: { groupId: string; activePath: string; onFocus: () => void; onCursor: (line: number, column: number) => void; reveal: { line: number } | null }) => <button data-editor={props.groupId} data-path={props.activePath} data-reveal={props.reveal?.line} onClick={() => { props.onFocus(); props.onCursor(props.groupId === "right" ? 20 : 4, 3); }}>编辑器</button> }));
vi.mock("./TabStrip", () => ({ TabStrip: (props: { groupId: string; tabs: TabMeta[]; tools?: ReactNode; onClose: (path: string) => void; onCloseMany: (want: () => boolean) => number }) => <div data-tabs={props.groupId}>{props.tabs.map(tab => <button key={tab.path} data-close={tab.path} onClick={() => props.onClose(tab.path)}>{tab.name}</button>)}<button data-bulk={props.groupId} onClick={() => props.onCloseMany(() => true)}>关闭已保存</button>{props.tools}</div> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const a = "C:\\w\\A.java", b = "C:\\w\\B.java", c = "C:\\w\\C.java", d = "C:\\w\\D.java";
const tab = (path: string, extra: Partial<TabMeta> = {}) => ({ path, name: path.split("\\").pop(), dirty: false, eolChanged: false, ...extra }) as TabMeta;
let host: HTMLDivElement, root: Root;
let reveal: { line: number; nonce: number; path: string; group: "left" | "right" } | null;
function Harness() {
  const state = useWorkspaceSession(), lifecycle = useFileTabLifecycle();
  const session = { ...lifecycle, pin: vi.fn(), openSplit: vi.fn(), closeSplit: vi.fn(), saveFile: vi.fn(), openFile: vi.fn() } as unknown as ReturnType<typeof useFileSession>;
  const active = state.tabs.find(tab => tab.path === state.activePath);
  const noop = () => {};
  const nav: EditorNavigation | null = active ? { active, root: "C:\\w", canBack: false, canForward: false,
    onBack: noop, onForward: noop, onJumpHistory: noop, heavy: false, outlineOpen: false, onToggleOutline: noop,
    history: { open: false, dirty: active.dirty, onToggle: noop, onClose: noop, onRestored: noop } } : null;
  return <EditorGroupsPane root="C:\\w" tabs={state.tabs} session={session} reveal={reveal} nav={nav} tools={<span data-execution>执行工具</span>} />;
}
beforeEach(() => {
  h.closeModel.mockClear(); reveal = null;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: typeof h.resize) { h.resize = callback; } observe() {} disconnect() {} });
  setSession({ root: "C:\\w", tabs: [tab(a), tab(b)], closingPath: null, editorGroups: { ...emptyEditorGroups(), left: [a], leftActive: a, right: [b], rightActive: b } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const click = (selector: string) => act(() => host.querySelector<HTMLButtonElement>(selector)!.click());
it("点击右组同步活动文件与光标；旧定位不会跳到其他组或其他文件", () => {
  reveal = { path: a, group: "left", line: 9, nonce: 1 }; act(() => root.render(<Harness />));
  expect(host.querySelector('[data-editor="left"]')?.getAttribute("data-reveal")).toBe("9");
  click('[data-editor="right"]');
  expect(getSession().activePath).toBe(b); expect(getCursor()).toEqual({ line: 20, column: 3 });
  expect(host.querySelector('[data-editor="right"]')?.hasAttribute("data-reveal")).toBe(false);
  expect(host.querySelector('[data-editor="left"]')?.hasAttribute("data-reveal")).toBe(false);
});
it("编译定位使用不同分隔符与大小写时仍传递给正确编辑器组", () => {
  reveal = { path: "c:/w/A.java", group: "left", line: 9, nonce: 1 }; act(() => root.render(<Harness />));
  expect(host.querySelector('[data-editor="left"]')?.getAttribute("data-reveal")).toBe("9");
  expect(host.querySelector('[data-editor="right"]')?.hasAttribute("data-reveal")).toBe(false);
});
it("共享未保存文件关闭一个视图不关闭模型；最后视图关闭时进入确认", () => {
  act(() => setSession({ tabs: [tab(a, { dirty: true })], editorGroups: { ...emptyEditorGroups(), left: [a], leftActive: a, right: [a], rightActive: a, focused: "right" } }));
  click('[data-tabs="right"] [data-close]');
  expect(h.closeModel).not.toHaveBeenCalled(); expect(getSession().closingPath).toBeNull();
  expect(getSession().tabs).toHaveLength(1); expect(getSession().splitPath).toBeNull();
  click('[data-tabs="left"] [data-close]');
  expect(getSession().closingPath).toBe(a); expect(h.closeModel).not.toHaveBeenCalled();
});
it("组内批量关闭只销毁最后的已保存视图，保留独有未保存及钉住文件", () => {
  act(() => setSession({ tabs: [tab(a, { dirty: true }), tab(b, { dirty: true }), tab(c), tab(d, { pinned: true })], editorGroups: { ...emptyEditorGroups(), left: [a], leftActive: a, right: [a, b, c, d], rightActive: a } }));
  click('[data-bulk="right"]');
  expect(getSession().editorGroups?.right).toEqual([b, d]);
  expect(getSession().tabs.map(tab => tab.path)).toEqual([a, b, d]);
  expect(h.closeModel).toHaveBeenCalledExactlyOnceWith(c);
});
it("窄窗口仅显示焦点组，另一编辑器保持挂载；键盘分隔条夹住比例", () => {
  const leftEditor = host.querySelector('[data-editor="left"]');
  act(() => h.resize!([{ contentRect: { width: 700 } }]));
  expect(host.querySelector('[data-group="right"]')?.hasAttribute("hidden")).toBe(true);
  click('[data-editor="right"]');
  expect(host.querySelector('[data-group="left"]')?.hasAttribute("hidden")).toBe(true);
  expect(host.querySelectorAll("[data-execution]")).toHaveLength(1);
  expect(host.querySelector('[data-tabs="right"] [data-execution]')).toBeTruthy();
  act(() => h.resize!([{ contentRect: { width: 1100 } }]));
  expect(host.querySelector('[data-editor="left"]')).toBe(leftEditor);
  expect(host.querySelector('[data-tabs="left"] [data-execution]')).toBeTruthy();
  act(() => host.querySelector('[role="separator"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(getSession().editorGroups?.ratio).toBeCloseTo(.55);
});

it("标签、当前组路径、正文按顺序排列；切换焦点只移动阅读工具，路径不会串组", () => {
  const left = host.querySelector('[data-group="left"]')!;
  const tabs = left.querySelector('[data-tabs]')!, nav = left.querySelector('[data-reading-tools]')!, body = left.querySelector('[role="tabpanel"]')!;
  expect(tabs.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(nav.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(nav.getAttribute("data-reading-tools")).toBe(a);
  expect(host.querySelector('[data-group="right"] [data-breadcrumb]')?.getAttribute("data-breadcrumb")).toBe(b);
  expect(host.querySelector('[data-group="right"] [data-breadcrumb]')?.getAttribute("data-symbols")).toBe("false");
  const leftEditor = host.querySelector('[data-editor="left"]');
  click('[data-editor="right"]');
  expect(host.querySelectorAll('[data-reading-tools]')).toHaveLength(1);
  expect(host.querySelector('[data-reading-tools]')?.getAttribute("data-reading-tools")).toBe(b);
  expect(host.querySelector('[data-group="left"] [data-breadcrumb]')?.getAttribute("data-breadcrumb")).toBe(a);
  expect(host.querySelector('[data-editor="left"]')).toBe(leftEditor);
});

it("左组没有文件时仍保留路径行，右组的执行与阅读入口正常可达", () => {
  act(() => setSession({ tabs: [tab(b)], editorGroups: { ...emptyEditorGroups(), right: [b], rightActive: b, focused: "right" } }));
  expect(host.querySelector('[data-group="left"] .wb-group-path')?.textContent).toBe("尚未打开文件");
  expect(host.querySelector('[data-group="right"] [data-reading-tools]')?.getAttribute("data-reading-tools")).toBe(b);
  act(() => h.resize!([{ contentRect: { width: 700 } }]));
  expect(host.querySelector('[data-group="right"] [data-execution]')).toBeTruthy();
});
