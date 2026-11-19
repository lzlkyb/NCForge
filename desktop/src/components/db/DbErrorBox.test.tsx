// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SqlQuickFix } from "../../lib/sqlQuickFix";

vi.mock("./CodePreview", () => ({ CodePreview: () => <div /> }));
vi.mock("../../lib/dbActions", () => ({ openTable: vi.fn() }));
vi.mock("../../lib/dbConfirm", () => ({ reconnectSession: vi.fn() }));
vi.mock("../../lib/dbStore", () => ({ openSessionPanel: vi.fn(), rtOf: vi.fn(), connOf: vi.fn() }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const sql = "select vbillcod from po_order where vbillcod = 'x'";
const fixes: SqlQuickFix[] = [
  { start: 7, end: 15, text: "vbillcode" },
  { start: 36, end: 44, text: "vbillcode" },
];

async function renderBox(onApply?: (fix: SqlQuickFix) => void) {
  const { DbErrorBox } = await import("./DbErrorBox");
  act(() => root.render(<DbErrorBox error={'ORA-00904: "VBILLCOD": invalid identifier'} sql={sql} knownTables={["PO_ORDER"]}
    onFixes={async () => fixes} onApply={onApply} />));
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent?.includes("检查可用修复"))!.click(); });
}

it("同一错列名多处修复：候选带位置区分，点击应用对应那一处", async () => {
  const applied: SqlQuickFix[] = [];
  await renderBox(fix => applied.push(fix));
  const buttons = [...host.querySelectorAll("button")].filter(b => b.textContent?.startsWith("替换为"));
  expect(buttons).toHaveLength(2);
  expect(buttons[0].textContent).toContain("第 1 行第 8 列");
  expect(buttons[1].textContent).toContain("第 1 行第 37 列");
  await act(async () => { buttons[1].click(); });
  expect(applied).toEqual([fixes[1]]);
});

it("单处修复不加位置后缀（保持原样）", async () => {
  const { DbErrorBox } = await import("./DbErrorBox");
  act(() => root.render(<DbErrorBox error={'ORA-00904: "VBILLCOD": invalid identifier'} sql={sql} knownTables={["PO_ORDER"]}
    onFixes={async () => [fixes[0]]} />));
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent?.includes("检查可用修复"))!.click(); });
  const button = [...host.querySelectorAll("button")].find(b => b.textContent?.startsWith("替换为"))!;
  expect(button.textContent).toBe("替换为 vbillcode");
});

it("ORA-00942：摆出登录账号与执行时 schema（解析上下文）", async () => {
  const { rtOf, connOf } = await import("../../lib/dbStore");
  vi.mocked(rtOf).mockReturnValue({ info: { user: "AIER" }, currentSchema: "NOW" } as never);
  vi.mocked(connOf).mockReturnValue({ user: "AIER" } as never);
  const { DbErrorBox } = await import("./DbErrorBox");
  act(() => root.render(<DbErrorBox error="ORA-00942: table or view does not exist" sql="select * from t"
    knownTables={[]} connId="c1" contextSchema="AIER633" />));
  expect(host.textContent).toContain("登录账号 AIER");
  expect(host.textContent).toContain("AIER633");
  expect(host.textContent).not.toContain("NOW");
});

it("ORA-00942：没给执行时 schema 就用连接当前值；空 schema 显示登录账号自身", async () => {
  const { rtOf, connOf } = await import("../../lib/dbStore");
  vi.mocked(rtOf).mockReturnValue({ info: { user: "AIER" }, currentSchema: "" } as never);
  vi.mocked(connOf).mockReturnValue({ user: "AIER" } as never);
  const { DbErrorBox } = await import("./DbErrorBox");
  act(() => root.render(<DbErrorBox error="ORA-00942: table or view does not exist" sql="select * from t"
    knownTables={[]} connId="c1" />));
  expect(host.textContent).toContain("登录账号自身");
});

it("schema 修复：按钮文案是切到 schema，点击原样交回调用方", async () => {
  const applied: SqlQuickFix[] = [];
  const fix: SqlQuickFix = { start: 0, end: 0, text: "", schema: "AIER633" };
  const { DbErrorBox } = await import("./DbErrorBox");
  act(() => root.render(<DbErrorBox error="ORA-00942: table or view does not exist" sql="select * from t"
    knownTables={[]} onFixes={async () => [fix]} onApply={f => applied.push(f)} />));
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent?.includes("检查可用修复"))!.click(); });
  const button = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("切到 schema"))!;
  expect(button.textContent).toBe("切到 schema AIER633");
  await act(async () => { button.click(); });
  expect(applied).toEqual([fix]);
});