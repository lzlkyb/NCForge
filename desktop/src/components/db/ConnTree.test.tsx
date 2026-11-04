// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../lib/dbActions", () => ({ deleteConn: vi.fn(), disconnectConn: vi.fn(), duplicateConn: vi.fn(), moveConn: vi.fn(), newConsole: vi.fn(), refreshMeta: vi.fn() }));
vi.mock("../../lib/dbConfirm", () => ({ ensureConnected: vi.fn() }));
vi.mock("../../lib/dbStore", () => {
  const S = { conns: [{ id: "c1", name: "开发库", env: "dev", url: "", user: "u" }], tabs: [], active: null, loaded: true, loadError: null, rt: {} };
  return { useDbSelector: (sel: (s: typeof S) => unknown) => sel(S), useDbConns: () => S.conns, useDbRt: () => S.rt, rtOf: () => ({ status: "connected" }), defaultConnId: vi.fn(), loadConns: vi.fn(), openConnDialog: vi.fn(), openDictTab: vi.fn() };
});
vi.mock("./ConnObjects", () => ({ ConnObjects: () => <span>连接对象</span> }));
vi.mock("./FavoriteSection", () => ({ FavoriteSection: () => null }));
vi.mock("./PasswordResetDialog", () => ({ PasswordResetDialog: () => null }));
import { ConnTree } from "./ConnTree";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root.render(<ConnTree />)); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
it("连接行明确报告展开状态并关联真实对象区域", () => {
  const row = host.querySelector<HTMLButtonElement>(".dbx-crow")!;
  expect(row.getAttribute("aria-expanded")).toBe("false");
  act(() => row.click());
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(row.getAttribute("aria-controls")!)?.textContent).toContain("连接对象");
  act(() => row.click());
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(row.hasAttribute("aria-controls")).toBe(false);
});
