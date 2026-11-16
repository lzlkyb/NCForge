// @vitest-environment jsdom
import { act, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTreeKeyboard, type TreeKeyDeps } from "./useTreeKeyboard";
import type { FlatRow, TreeSelection } from "../../lib/treeNav";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flat: FlatRow[] = [
  { path: "D:/p", isDir: true, parent: null, project: true },
  { path: "D:/p/A.java", isDir: false, parent: "D:/p" },
];
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
let state!: ReturnType<typeof useTreeKeyboard>;
let deps: TreeKeyDeps;
let filterValue: string;

beforeEach(() => {
  filterValue = "";
  deps = {
    flat, selected: { path: "D:/p/A.java", isDir: false } as TreeSelection,
    setSelected: vi.fn(), expanded: new Set(["D:/p"]), memberPaths: new Set(),
    editing: false, cancelEdit: vi.fn(),
    get filter() { return filterValue; },
    filterOpen: false,
    setFilter: vi.fn((next: unknown) => {
      filterValue = typeof next === "function" ? (next as (f: string) => string)(filterValue) : next as string;
    }),
    closeFilter: vi.fn(), root: "D:/p",
    toggleFileMembers: vi.fn(), toggle: vi.fn(), toggleVisibleRow: vi.fn(),
    onOpen: vi.fn(), isEditable: () => true, beginRename: vi.fn(), askDelete: vi.fn(),
  } as unknown as TreeKeyDeps;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

async function mount() {
  function Harness() { state = useTreeKeyboard(deps); return null; }
  await act(async () => root.render(<Harness />));
}

/** 造一次按键：`native` 直接决定 nativeEvent 上的字段（isComposing / keyCode）。 */
function press(key: string, native: { isComposing?: boolean; keyCode?: number } = {}) {
  const event = {
    key, ctrlKey: false, altKey: false, metaKey: false,
    target: host, preventDefault: vi.fn(),
    nativeEvent: { isComposing: native.isComposing ?? false, keyCode: native.keyCode ?? 0 },
  };
  state.onKeyDown(event as unknown as ReactKeyboardEvent);
  return event;
}

it("speed search 把单字符收进筛选框", async () => {
  await mount();
  const event = press("a");
  expect(filterValue).toBe("a");
  expect(event.preventDefault).toHaveBeenCalled();
});

// 🔴 IME 判据必须走真源 isImeComposing（含 keyCode===229）：组词中的第一个按键
// 在部分输入法上 isComposing 仍是 false，只判它会把拼音首字母吞进筛选框。
it("输入法组词期间不吞按键（isComposing 与 keyCode 229 都要认）", async () => {
  await mount();
  for (const native of [{ isComposing: true }, { keyCode: 229 }, { isComposing: false, keyCode: 229 }]) {
    filterValue = "";
    const event = press("n", native);
    expect(filterValue, JSON.stringify(native)).toBe("");
    expect(event.preventDefault, JSON.stringify(native)).not.toHaveBeenCalled();
  }
  // 非组词状态照常收字
  const normal = press("n", { isComposing: false, keyCode: 78 });
  expect(filterValue).toBe("n");
  expect(normal.preventDefault).toHaveBeenCalled();
});

it("编辑态只让 Escape 走，其它按键留给输入行", async () => {
  deps = { ...deps, editing: true } as TreeKeyDeps;
  await mount();
  press("a");
  expect(filterValue).toBe("");
  press("Escape");
  expect(deps.cancelEdit).toHaveBeenCalled();
});
