// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ tab: "manual", columns: vi.fn() }));
vi.mock("../ui/Modal", () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("./ConnManualForm", () => ({ ConnManualForm: () => { const [value, set] = useState(""); return <input aria-label="draft" value={value} onChange={e => set(e.target.value)} />; } }));
vi.mock("./ConnImportPanes", () => ({ PropImportPane: () => <p>prop</p> }));
vi.mock("./PropsFileImportPane", () => ({ PropsFileImportPane: () => <p>file</p> }));
vi.mock("../../lib/dbStore", () => ({ useConnOf: () => null, useDbSelector: (select: (value: unknown) => unknown) => select({ dialog: { tab: mocks.tab }, tabs: [] }), openConnDialog: (_: unknown, tab: string) => { mocks.tab = tab; }, closeConnDialog: vi.fn(), columnsOf: (...args: unknown[]) => mocks.columns(...args) }));
vi.mock("../../lib/dbActions", () => ({ openTable: vi.fn() }));
import { ConnDialog } from "./ConnDialog";
import { TableRow } from "./ConnTableRow";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("keeps manual draft when changing import source", async () => {
 const host = document.createElement("div"); const root = createRoot(host);
 await act(async () => root.render(<ConnDialog />));
 const input = host.querySelector("input")!;
 await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "draft value"); input.dispatchEvent(new Event("input", { bubbles: true })); });
 mocks.tab = "prop"; await act(async () => root.render(<ConnDialog />));
 mocks.tab = "manual"; await act(async () => root.render(<ConnDialog />));
 expect(host.querySelector("input")!.value).toBe("draft value");
 await act(async () => root.unmount());
});
it("keyboard expansion reports failure and can retry", async () => {
 const host = document.createElement("div"); const root = createRoot(host);
 mocks.columns.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce([{ name: "ID", full: "NUMBER" }]);
 await act(async () => root.render(<TableRow connId="c" table={{ name: "TEST", kind: "TABLE" } as never} zh={undefined} fav={false} onToggleFav={() => {}} onMenu={() => {}} />));
 const row = host.querySelector<HTMLButtonElement>(".dbx-trow")!;
 await act(async () => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
 expect(host.textContent).toContain("读取字段失败");
 await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "重试")!.click());
 expect(row.getAttribute("aria-expanded")).toBe("true"); expect(host.textContent).toContain("id");
 await act(async () => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
 expect(row.getAttribute("aria-expanded")).toBe("false");
 await act(async () => root.unmount());
});
