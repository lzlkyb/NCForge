import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportFileOut } from "./dbApi";

vi.mock("./dbApi", () => ({
  dbApi: { exportFile: vi.fn(), cancelExport: vi.fn() },
}));
vi.mock("./dbStore", () => ({ sqlTabOf: vi.fn(), execOne: vi.fn(), patchTab: vi.fn() }));
vi.mock("./dbConfirm", () => ({ ensureConnected: vi.fn(async () => true) }));
vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));

import { dbApi } from "./dbApi";
import { sqlTabOf } from "./dbStore";
import { cancelResultExport, exportResultFile } from "./dbResultActions";

const tab = { id: "t1", connId: "c1", timeoutSec: 30 } as never;

/** 一个手动控制何时结束的导出，模拟后端还在写盘。 */
function pending() {
  let resolve!: (v: ExportFileOut) => void;
  const p = new Promise<ExportFileOut>((r) => (resolve = r));
  return { p, resolve };
}

const out: ExportFileOut = {
  path: "C:/x.csv",
  fileName: "x.csv",
  rows: 3,
  bytes: 10,
  truncated: false,
  canceled: false,
  ms: 1,
};

const exportMock = vi.mocked(dbApi.exportFile);
const cancelMock = vi.mocked(dbApi.cancelExport);

/** 从调用参数里取这次导出的实例号。 */
function idOf(call: number): number {
  const id = exportMock.mock.calls[call]?.[0]?.exportId;
  expect(id).toBeTypeOf("number");
  return id as number;
}

describe("流式导出的取消令牌", () => {
  beforeEach(() => {
    exportMock.mockReset();
    cancelMock.mockReset();
    vi.mocked(sqlTabOf).mockReturnValue(tab as never);
  });

  it("取消只停这个标签那一次导出", async () => {
    const a = pending();
    exportMock.mockReturnValueOnce(a.p);
    const run = exportResultFile("t1", "select 1", "csv", "T");

    cancelResultExport("t1");
    expect(cancelMock).toHaveBeenCalledWith(idOf(0));

    // 没在导出别的标签不能顺带停掉任何东西
    cancelResultExport("t2");
    expect(cancelMock).toHaveBeenCalledTimes(1);

    a.resolve(out);
    await run;

    // 结束后再点取消不会打到已经关掉的那一次上
    cancelResultExport("t1");
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("同标签先后两次导出：先结束的那次不能抹掉后一次的登记", async () => {
    const a = pending();
    const b = pending();
    exportMock.mockReturnValueOnce(a.p).mockReturnValueOnce(b.p);

    const runA = exportResultFile("t1", "select 1", "csv", "T");
    const runB = exportResultFile("t1", "select 2", "csv", "T");

    a.resolve(out);
    await runA;

    // A 的 finally 只清理自己；现在的登记应该还是 B 的实例号
    cancelResultExport("t1");
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledWith(idOf(1));

    b.resolve(out);
    await runB;
    cancelResultExport("t1");
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });
});
