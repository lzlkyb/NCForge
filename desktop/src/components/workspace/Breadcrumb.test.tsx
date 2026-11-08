// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Breadcrumb } from "./Breadcrumb";
import type { TabMeta } from "../../lib/workspaceSession";
import type { FlatSymbol } from "../../lib/symbols";

const h = vi.hoisted(() => ({ local: vi.fn(), symbols: vi.fn(), navigate: vi.fn() }));
vi.mock("../../hooks/useLocalOutline", () => ({ useLocalOutline: h.local }));
vi.mock("../../lib/cursorStore", () => ({ useCursor: () => ({ line: 10, column: 1 }) }));
vi.mock("../../lib/lang", () => ({ useLangView: () => ({ state: "ready", settled: 1 }), inLangModule: () => true, navigate: h.navigate }));
vi.mock("../../lib/symbols", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/symbols")>(), symbolsFor: h.symbols }));
vi.mock("./EditorTabTypeIcon", () => ({ EditorTabTypeIcon: () => <svg /> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const symbol: FlatSymbol = { name: "doAction", kind: 6, container: "Actions", line: 8, column: 3, startLine: 8, endLine: 12, depth: 1 };
const active: TabMeta = { path: "C:/w/src/Actions.java", name: "Actions.java", dirty: false, mtimeMs: 1,
  encoding: "UTF-8", hasBom: false, eol: "LF", eolChanged: false, readOnly: false, readOnlyReason: null, lines: 20 };
beforeEach(() => {
  h.local.mockReset().mockReturnValue([symbol]); h.symbols.mockReset().mockResolvedValue([symbol]); h.navigate.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("非焦点组只展示本组路径，不用其他组光标生成符号链或发起符号查询", async () => {
  await act(async () => root.render(<Breadcrumb root="C:/w" active={active} showSymbols={false} />));
  expect(host.textContent).toContain("Actions.java");
  expect(host.querySelectorAll('.wb-crumb-sym')).toHaveLength(0);
  expect(h.local).toHaveBeenLastCalledWith(null, 1);
  expect(h.symbols).not.toHaveBeenCalled();
});

it("焦点组保留声明跳转，失去焦点后立即移除已有符号链", async () => {
  await act(async () => root.render(<Breadcrumb root="C:/w" active={active} />));
  const item = host.querySelector<HTMLButtonElement>('.wb-crumb-sym')!;
  expect(item.textContent).toContain("doAction");
  act(() => item.click());
  expect(h.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "file", path: active.path, line: 8, column: 3 });
  await act(async () => root.render(<Breadcrumb root="C:/w" active={active} showSymbols={false} />));
  expect(host.querySelectorAll('.wb-crumb-sym')).toHaveLength(0);
});
