// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DangerItem } from "./SqlDangerDialog";

const mocks = vi.hoisted(() => ({
  execResult: vi.fn(),
  closeResult: vi.fn(),
  connected: vi.fn(),
}));
vi.mock("../../lib/dbApi", () => ({ dbApi: { execResult: mocks.execResult, closeResult: mocks.closeResult } }));
vi.mock("../../lib/dbConfirm", () => ({ ensureConnected: mocks.connected }));

import { SqlDangerDialog } from "./SqlDangerDialog";

const items: DangerItem[] = [
  { index: 0, sql: "delete from bd_material", finding: { kind: "delete-all", verb: "DELETE", table: "bd_material", advisory: false, countSql: "select count(*) from bd_material" } },
];

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connected.mockResolvedValue(true);
  mocks.closeResult.mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** Modal 走 portal，内容在 body 上，不在测试容器里。 */
const screen = () => document.body;
const button = (label: string) => [...screen().querySelectorAll("button")].find(b => b.textContent?.includes(label))!;
const render = (onCancel = vi.fn(), onConfirm = vi.fn()) =>
  act(() => root.render(<SqlDangerDialog items={items} connId="c1" slot={null} onCancel={onCancel} onConfirm={onConfirm} />));

describe("危险语句确认框", () => {
  it("说清它会动整张表，并摆出语句与表名", () => {
    render();
    const text = screen().textContent!;
    expect(text).toContain("会改动整张表");
    expect(text).toContain("delete from bd_material");
    expect(text).toContain("bd_material");
  });

  it("取消与仍要执行分别回调", () => {
    const cancel = vi.fn(), confirm = vi.fn();
    render(cancel, confirm);
    act(() => button("取消，不执行").click());
    expect(cancel).toHaveBeenCalledOnce();
    act(() => button("仍要执行").click());
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("预估影响行数：点一下才查，显示命中与占比", async () => {
    mocks.execResult.mockImplementation(async (_id: string, sql: string) => ({
      kind: "rows", columns: [], hasMore: false, ms: 1, output: [], tx: { autoCommit: true, statements: 0, rows: 0, since: 0 },
      rows: [[sql.includes("1=1") ? 12438 : 40000]],
    }));
    const withWhere: DangerItem[] = [{ index: 0, sql: "delete from bd_material where 1=1",
      finding: { kind: "delete-all", verb: "DELETE", table: "bd_material", advisory: false, countSql: "select count(*) from bd_material where 1=1" } }];
    act(() => root.render(<SqlDangerDialog items={withWhere} connId="c1" slot={null} onCancel={vi.fn()} onConfirm={vi.fn()} />));
    expect(mocks.execResult).not.toHaveBeenCalled();
    await act(async () => button("预估影响行数").click());
    const text = screen().textContent!;
    expect(text).toContain("12,438");
    expect(text).toContain("40,000");
    expect(text).toContain("31%");
    // 用完的游标必须释放，不能留在结果标签里
    expect(mocks.closeResult).toHaveBeenCalledTimes(2);
  });

  it("没有 WHERE 时只查一次（这条 COUNT 本身就是全表）", async () => {
    mocks.execResult.mockResolvedValue({ kind: "rows", columns: [], hasMore: false, ms: 1, output: [], tx: { autoCommit: true, statements: 0, rows: 0, since: 0 }, rows: [[40000]] });
    render();
    await act(async () => button("预估影响行数").click());
    expect(mocks.execResult).toHaveBeenCalledTimes(1);
    expect(screen().textContent).toContain("会影响 40,000 行");
  });

  it("连接已断开时把原因说出来，并留一个重试入口", async () => {
    mocks.connected.mockResolvedValue(false);
    render();
    await act(async () => button("预估影响行数").click());
    // 静默 return 会让人反复点「预估影响行数」却永远没反应
    expect(screen().textContent).toContain("连接已断开");
    expect(mocks.execResult).not.toHaveBeenCalled();
    expect(button("重试").disabled).toBe(false);
  });
});
