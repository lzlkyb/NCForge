// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  readOnly: false as boolean | null, status: "connected", request: vi.fn(), tx: vi.fn(), setTx: vi.fn(), patchTab: vi.fn(), claimCursor: vi.fn(), toast: vi.fn(),
  tabs: [] as { id: string; kind: string; connId: string; slot: string }[],
}));
vi.mock("../../lib/dbApi", () => ({ ENV_LABEL: { test: "测试" }, dbApi: { readOnly: mocks.request, tx: mocks.tx } }));
vi.mock("../../lib/dbStore", () => ({
  useConnOf: () => ({ name: "测试库", env: "test", user: "NC", url: "jdbc:oracle:thin:@localhost:1521/test", autoCommit: false }),
  useConnRt: () => ({ status: mocks.status }), getDb: () => ({ tabs: mocks.tabs }),
  claimCursor: mocks.claimCursor, patchTab: mocks.patchTab, setTx: mocks.setTx,
}));
vi.mock("../../lib/dbReadOnly", () => ({ useDbReadOnly: () => mocks.readOnly }));
vi.mock("../../lib/db", () => ({ friendlyDbError: (error: unknown) => String(error) }));
vi.mock("../../lib/dbOperations", () => ({ dbTaskSpec: () => ({}) }));
vi.mock("../../lib/operations", () => ({ trackOperation: (_spec: unknown, run: () => Promise<unknown>) => run() }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("./SchemaChip", () => ({ SchemaChip: () => <span>NC_SCHEMA</span> }));
import { DbContextBar } from "./DbContextBar";
let root: Root, host: HTMLDivElement;
const tx = { autoCommit: false, statements: 0, rows: 0, since: 0 };
beforeEach(() => {
  vi.clearAllMocks(); mocks.readOnly = false; mocks.status = "connected"; mocks.tabs = [];
  mocks.request.mockReset(); mocks.tx.mockReset().mockResolvedValue({ tx });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<DbContextBar connId="c1" independent transactionMode="手动提交" />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const toggle = () => host.querySelector<HTMLButtonElement>(".dbx-connection-readonly")!;

it("连接级只读切换一次请求覆盖所有所属会话，并释放旧游标", async () => {
  mocks.tabs = [{ id: "a", kind: "sql", connId: "c1", slot: "1" }, { id: "b", kind: "sql", connId: "c1", slot: "2" }, { id: "other", kind: "sql", connId: "c2", slot: "3" }];
  let finish!: (value: { readOnly: boolean; tx: typeof tx }) => void;
  mocks.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  expect(toggle().textContent).toContain("此连接全部会话");
  act(() => { toggle().click(); toggle().click(); });
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("c1", true);
  expect(toggle().disabled).toBe(true);
  await act(async () => finish({ readOnly: true, tx }));
  expect(mocks.setTx).toHaveBeenCalledWith("c1", tx);
  expect(mocks.claimCursor.mock.calls).toEqual([["c1", null, "readonly-toggle"], ["c1", "1", "readonly-toggle"], ["c1", "2", "readonly-toggle"]]);
  expect(mocks.tx.mock.calls).toEqual([["c1", "status", "1"], ["c1", "status", "2"]]);
  expect(mocks.patchTab).toHaveBeenCalledWith("a", { tx });
  expect(mocks.patchTab).toHaveBeenCalledWith("b", { tx });
  expect(toggle().disabled).toBe(false);
});

it("切换失败保留原状态并明确反馈，不能假装只读已经开启", async () => {
  mocks.request.mockRejectedValue("数据库未确认只读切换");
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(toggle().textContent).toContain("连接只读：关闭");
  expect(mocks.toast).toHaveBeenCalledWith("数据库未确认只读切换", "error");
  expect(mocks.setTx).not.toHaveBeenCalled();
  expect(mocks.claimCursor).not.toHaveBeenCalled();
});

it("只读状态待验证时禁用切换，模式和影响范围仍可读", () => {
  mocks.readOnly = null;
  act(() => root.render(<DbContextBar connId="c1" independent transactionMode="手动提交" />));
  expect(toggle().disabled).toBe(true);
  expect(toggle().textContent).toBe("连接只读：待验证此连接全部会话");
  expect(host.querySelector(".dbx-context-session")?.textContent).toBe("独立会话 · 手动提交");
});
