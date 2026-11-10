// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../lib/dbStore", () => ({ connOf: vi.fn(), connect: vi.fn(), getDb: vi.fn(), rtOf: vi.fn(), txAction: vi.fn() }));
vi.mock("../../lib/db", () => ({ friendlyDbError: String }));
vi.mock("../../lib/dbApi", () => ({ dbApi: {}, ENV_LABEL: { dev: "开发", test: "测试", prod: "生产", other: "其他" } }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
import { askQuit, usePending, type QuitChoice, type QuitRow } from "../../lib/dbConfirm";
import { QuitTxBody } from "./QuitTxBody";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pendingRow = (over: Partial<QuitRow> = {}): QuitRow => ({
  connId: "c1", name: "测试库", env: "test", kind: "pending",
  statements: 3, rows: 12, since: Date.now() - 120_000, ...over,
});
const unknownRow = (over: Partial<QuitRow> = {}): QuitRow => ({
  connId: "c2", name: "生产库", env: "prod", kind: "unknown",
  reason: "disconnected", statements: 0, rows: 0, since: 0, ...over,
});

function Harness() {
  const p = usePending();
  return p?.kind === "quit" ? <QuitTxBody p={p} /> : null;
}

/** 打开真实弹框状态（`askQuit` 产生的 pending），拿到 DOM 与结算 Promise。 */
async function open(rows: QuitRow[]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  let result!: Promise<QuitChoice>;
  await act(async () => {
    result = askQuit(rows);
  });
  const click = async (text: string) => {
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === text);
    if (!btn) throw new Error(`找不到按钮「${text}」：${host.textContent}`);
    await act(async () => btn.click());
  };
  return {
    text: () => host.textContent ?? "",
    buttons: () => [...host.querySelectorAll("button")].map((b) => b.textContent),
    click,
    result,
    close: () => act(async () => root.unmount()),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("退出前的事务确认框", () => {
  it("全是无法确认的连接：只给取消与仍要退出，不说能提交", async () => {
    const dlg = await open([unknownRow()]);
    expect(dlg.text()).toContain("有连接无法确认事务状态");
    expect(dlg.text()).toContain("会话已经结束");
    expect(dlg.buttons()).toEqual(["取消", "仍要退出"]);
    await dlg.click("仍要退出");
    expect(await dlg.result).toBe("exit");
    await dlg.close();
  });

  it("断开前有写语句时把计数说清楚，不让用户以为没有改动", async () => {
    const dlg = await open([unknownRow({ statements: 5, rows: 20 })]);
    expect(dlg.text()).toContain("断开前记录到 5 条写语句 / 影响 20 行");
    await dlg.close();
  });

  it("已知事务与未知连接混在一起：可以提交已知事务，并说明另有几个未知", async () => {
    const dlg = await open([pendingRow(), unknownRow()]);
    expect(dlg.text()).toContain("退出前还有未提交的事务");
    expect(dlg.text()).toContain("另有 1 个连接无法确认");
    await dlg.click("提交已知事务");
    expect(await dlg.result).toBe("commit");
    await dlg.close();
  });

  it("只有已知事务时按钮仍是全部提交/全部回滚", async () => {
    const dlg = await open([pendingRow()]);
    expect(dlg.text()).toContain("3 条写语句 / 影响 12 行");
    expect(dlg.text()).toContain("已持续约 2 分钟");
    await dlg.click("全部回滚");
    expect(await dlg.result).toBe("rollback");
    await dlg.close();
  });

  it("取消不会当成提交或退出", async () => {
    const dlg = await open([pendingRow(), unknownRow()]);
    await dlg.click("取消");
    expect(await dlg.result).toBe("cancel");
    await dlg.close();
  });

  it("未知原因缺省时按探测超时解释", async () => {
    const dlg = await open([unknownRow({ reason: undefined })]);
    expect(dlg.text()).toContain("探测超时");
    await dlg.close();
  });
});
