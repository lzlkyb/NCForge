// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { SearchResults } from "./SearchResults";
import { getSearchForm, resetSearchForm, type SearchForm } from "../../lib/searchStore";
import type { SearchOutcome } from "../../lib/search";
const mocks = vi.hoisted(() => ({ text: vi.fn(), read: vi.fn() }));
vi.mock("../../lib/editorStore", () => ({ getText: mocks.text }));
vi.mock("../../lib/workspace", () => ({ baseName: (path: string) => path.split(/[\\/]/).pop(), readFile: mocks.read }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, form: SearchForm;
const open = vi.fn();
const hits = [{ path: "gl/A.java", line: 1, text: "match first", ranges: [{ start: 0, end: 5 }] }, { path: "gl/A.java", line: 3, text: "match second", ranges: [{ start: 0, end: 5 }] }, { path: "ar/B.java", line: 2, text: "match third", ranges: [{ start: 0, end: 5 }] }];
const outcome = (): SearchOutcome => ({ hits, filesMatched: 2, filesScanned: 2, elapsedMs: 2, truncated: false, scopeDirs: [], missingDirs: [], scopeFallback: false });
const render = () => root.render(<SearchResults form={form} update={patch => { form = { ...form, ...patch }; render(); }} loading={false} onOpen={open} resolvePath={hit => `${hit.root ?? form.outcomeRoot}/${hit.path}`} />);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
const press = (element: HTMLElement, key: string, composing = false) => act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, isComposing: composing })));
beforeEach(async () => {
  open.mockReset(); mocks.text.mockReset(); mocks.read.mockReset(); mocks.text.mockReturnValue("match first\ncontext\nmatch second"); resetSearchForm();
  form = { ...getSearchForm(), scope: "current", outcome: outcome(), outcomeRoot: "D:/p", query: "match" };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => render());
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("continuous navigation expands folded files and uses Enter to open the selected hit, including IME protection", async () => {
  await act(async () => button("全部折叠").click()); expect(host.querySelectorAll("[data-hit-key]")).toHaveLength(0);
  await act(async () => button("下一结果").click()); expect(open).toHaveBeenLastCalledWith(hits[0]); expect(host.querySelectorAll("[data-hit-key]")).toHaveLength(2);
  const list = host.querySelector<HTMLElement>('[aria-label="搜索结果列表"]')!;
  await press(list, "ArrowDown"); await press(list, "Enter"); expect(open).toHaveBeenLastCalledWith(hits[1]);
  await press(list, "ArrowDown", true); await press(list, "Enter", true); expect(open).toHaveBeenCalledTimes(2);
  await press(list, "ArrowDown"); await press(list, "Enter"); expect(open).toHaveBeenLastCalledWith(hits[2]);
});
it("expanded results keep one DOM/list scroll and restore the sidebar without changing search options", async () => {
  const list = host.querySelector<HTMLElement>('[aria-label="搜索结果列表"]')!; list.scrollTop = 84;
  const savedOptions = form.outcomeOptions;
  await act(async () => button("展开结果").click());
  const expanded = document.querySelector<HTMLElement>(".dw-search-expanded")!;
  expect(expanded.hidden).toBe(false); expect(expanded.querySelector('[aria-label="搜索结果列表"]')).toBe(list); expect(list.scrollTop).toBe(84);
  await press(list, "Escape");
  expect(expanded.hidden).toBe(true); expect(host.querySelector('[aria-label="搜索结果列表"]')).toBe(list); expect(list.scrollTop).toBe(84); expect(form.outcomeOptions).toBe(savedOptions);
});
it("returning to the same results restores scroll while a fresh search starts from the top", async () => {
  let list = host.querySelector<HTMLElement>('[aria-label="搜索结果列表"]')!;
  await act(async () => { list.scrollTop = 84; list.dispatchEvent(new Event("scroll")); });
  await act(async () => root.render(null)); await act(async () => render());
  list = host.querySelector<HTMLElement>('[aria-label="搜索结果列表"]')!; expect(list.scrollTop).toBe(84);
  form = { ...form, outcome: outcome() }; await act(async () => render()); expect(list.scrollTop).toBe(0);
});
it("previews use the source result's project root, do not open an editor, and disappear for a new result", async () => {
  form = { ...form, scope: "all", outcome: null, projectOutcome: { projects: [{ root: "D:/other", project: "other", outcome: { ...outcome(), hits: [hits[0]] } }], errors: [], elapsedMs: 2, truncated: false } };
  await act(async () => render());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="预览 A.java 第 1 行上下文"]')!.click());
  expect(mocks.text).toHaveBeenCalledWith("D:/other/gl/A.java"); expect(open).not.toHaveBeenCalled(); expect(host.textContent).toContain("行号来自搜索结果");
  form = { ...form, projectOutcome: { projects: [], errors: [], elapsedMs: 2, truncated: false } }; await act(async () => render());
  expect(host.querySelector('[aria-label="源码上下文预览"]')).toBeNull();
});

// 10000 条命中在单跑时 0.35s，但整套并行跑 jsdom 抢 CPU 会顶到默认 5s 超时（实测 pre-push 偶发红）。
// 这里显式放宽：用例要验的是「大结果只渲染窗口内节点」，不是性能。
it("bounds large-result DOM and reveals a keyboard-selected last hit", async () => {
  const many = Array.from({ length: 10000 }, (_, i) => ({ ...hits[0], line: i + 1 }));
  form = { ...form, outcome: { ...outcome(), hits: many } };
  await act(async () => render());
  expect(host.querySelectorAll("[data-hit-key]").length).toBeLessThan(40);
  const list = host.querySelector<HTMLElement>('[aria-label="搜索结果列表"]')!;
  await press(list, "ArrowUp");
  expect(host.querySelector('[data-selected="true"]')?.getAttribute("data-hit-key")).toContain("10000");
  await press(list, "Enter");
  expect(open).toHaveBeenLastCalledWith(many[9999]);
  await act(async () => button("全部折叠").click());
  expect(host.querySelectorAll("[data-hit-key]")).toHaveLength(0);
}, 30000);

it("bounds DOM for ten thousand hits while keeping keyboard navigation", async () => {
  const many = Array.from({ length: 10000 }, (_, i) => ({ path: "large.java", line: i + 1, text: "match", ranges: [{ start: 0, end: 5 }] }));
  form = { ...form, outcome: { ...outcome(), hits: many, filesMatched: 1 }, collapsed: [] };
  await act(async () => render());
  expect(host.querySelectorAll("[data-hit-key]").length).toBeLessThan(40);
  expect(host.querySelectorAll("[data-hit-key]").length).toBeGreaterThan(0);
});
