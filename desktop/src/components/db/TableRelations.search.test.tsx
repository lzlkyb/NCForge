// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => mocks);
vi.mock("../../lib/dbStore", () => ({ claimCursor: vi.fn(), connOf: () => ({ name: "开发库" }) }));
vi.mock("../../lib/dbRelations", () => ({ relationRows: () => [], relationQuery: vi.fn(), openRelated: vi.fn(), returnRelated: vi.fn() }));
vi.mock("../../lib/dbApi", () => ({ dbApi: { relations: async () => ({ foreign: { kind: "rows" }, references: { kind: "rows" }, notes: [] }) } }));
vi.mock("../../lib/mdDict", () => ({ mdDict: async () => ({ tables: [{ displayName: "凭证", entities: [{ fullClassName: "nc.vo.gl.Voucher" }], columns: [] }] }) }));
vi.mock("../../lib/operations", () => ({ trackOperation: (_spec: unknown, run: () => unknown) => run() }));
vi.mock("../ui/Modal", () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import { TableRelations } from "./TableRelations";
import { getSearchForm, resetSearchForm, setSearchForm } from "../../lib/searchStore";
import { closePalette, getPalette, openPalette } from "../../lib/paletteStore";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("数据库类引用先预填再发搜索导航，浮层读取同一查询词且不自动扫描", async () => {
  resetSearchForm(); setSearchForm({ query: "旧查询", regex: true, scope: "current" });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), close = vi.fn();
  const navigate = (event: Event) => { if ((event as CustomEvent).detail === "search") openPalette("search"); };
  window.addEventListener("ncforge-navigate", navigate);
  try {
    await act(async () => root.render(<TableRelations tab={{ kind: "table", id: "t", connId: "c", table: "gl_voucher", sub: "data" }} columns={[]} row={[]} onClose={close} />));
    const locate = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "在工程中查找类")!;
    await act(async () => locate.click());
    expect(getPalette()).toMatchObject({ open: true, mode: "search", query: "Voucher" });
    expect(getSearchForm()).toMatchObject({ query: "Voucher", regex: false, scope: "all", running: false });
    expect(close).toHaveBeenCalledOnce(); expect(mocks.invoke).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("ncforge-navigate", navigate);
    await act(async () => root.unmount()); host.remove(); closePalette(); resetSearchForm();
  }
});
