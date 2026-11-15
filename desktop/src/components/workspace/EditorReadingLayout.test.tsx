// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorReadingLayout } from "./EditorReadingLayout";
import type { EditorNavigation } from "./EditorNavRow";
import type { TabMeta } from "../../lib/workspaceSession";

const h = vi.hoisted(() => ({ instances: 0, resize: null as ((entries: { contentRect: { width: number } }[]) => void) | null }));
vi.mock("./OutlinePanel", () => ({ OutlinePanel: (props: { open: boolean; pinned: boolean; onTogglePin?: () => void }) =>
  props.open ? <div data-outline data-pinned={props.pinned} data-can-pin={!!props.onTogglePin} /> : null }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const noop = () => {};
const navigation = (path: string, virtual = false): EditorNavigation => ({
  active: { path, name: path.split("/").pop() ?? path, dirty: false,
    encoding: "UTF-8", hasBom: false, eol: "LF", mtimeMs: 1, eolChanged: false,
    readOnly: virtual, readOnlyReason: null, lines: 1, virtual: virtual ? "stub" : undefined } satisfies TabMeta,
  root: "C:/w", canBack: false, canForward: false,
  onBack: noop, onForward: noop, onJumpHistory: noop, outlineOpen: true,
});
function render(nav: EditorNavigation | null, split = false) {
  act(() => root.render(<EditorReadingLayout nav={nav} split={split} pinned onTogglePin={noop} onCloseOutline={noop} onJump={noop}>
    <div data-editors>编辑器组</div>
  </EditorReadingLayout>));
}
beforeEach(() => {
  h.instances = 0;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: typeof h.resize) { h.resize = callback; } observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("历史已迁往底部改动，阅读区仅保留按需固定的结构", () => {
  render(navigation("C:/w/A.java"), true);
  const next = navigation("C:/w/B.java");
  render(next, true);
  expect(host.querySelectorAll('[data-history]')).toHaveLength(0);
  expect(host.querySelectorAll('[data-outline]')).toHaveLength(1);
});

it("固定结构仍按单组与分屏宽度限制，窗口收窄时改用浮层", () => {
  render(navigation("C:/w/A.java"));
  act(() => h.resize!([{ contentRect: { width: 790 } }]));
  expect(host.querySelector('[data-outline]')?.getAttribute("data-pinned")).toBe("true");
  render(navigation("C:/w/A.java"), true);
  act(() => h.resize!([{ contentRect: { width: 1099 } }]));
  expect(host.querySelector('[data-outline]')?.getAttribute("data-pinned")).toBe("false");
  expect(host.querySelector('[data-outline]')?.getAttribute("data-can-pin")).toBe("false");
  act(() => h.resize!([{ contentRect: { width: 1100 } }]));
  expect(host.querySelector('[data-outline]')?.getAttribute("data-pinned")).toBe("true");
});

it("没有活动文件或打开依赖库文件时不显示历史和结构操作面板", () => {
  render(null);
  expect(host.querySelector('[data-history]')).toBeNull();
  expect(host.querySelector('[data-outline]')).toBeNull();
  render(navigation("jdt://dependencies/Library.class", true));
  expect(host.querySelector('[data-history]')).toBeNull();
  expect(host.querySelector('[data-outline]')).toBeNull();
});
