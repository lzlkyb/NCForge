import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferFileOut, TransferFileReq, TransferProgress } from "./dbTransferApi";
import type { TransferSource } from "./resultTransferContext";
import { defaultTransferOptions } from "./resultTransfer";

const mocks = vi.hoisted(() => ({
  file: vi.fn<(req: TransferFileReq) => Promise<TransferFileOut | null>>(),
  cancel: vi.fn<(exportId: number) => Promise<void>>(),
  toast: vi.fn(),
  handlers: [] as ((progress: TransferProgress) => void)[],
  unlisteners: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock("./dbTransferApi", () => ({ dbTransferApi: { file: mocks.file } }));
vi.mock("./dbApi", () => ({ dbApi: { cancelExport: mocks.cancel } }));
vi.mock("./tauri", () => ({ listen: async (_event: string, handler: (progress: TransferProgress) => void) => {
  mocks.handlers.push(handler); const un = vi.fn(); mocks.unlisteners.push(un); return un;
} }));
vi.mock("./dbOperations", () => ({ dbTaskSpec: (key: string, label: string) => ({ key: `db.${key}`, label, page: "db", errorDetail: () => "返回来源页查看错误" }) }));
vi.mock("./db", () => ({ friendlyDbError: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const source = (connId = "conn-a", resultId = "result-a"): TransferSource => ({ connId, resultId, sql: "select secret from T", source: "测试连接", complete: false });
const request = (id = "conn-a"): Omit<TransferFileReq, "exportId"> => ({ id, sql: "select secret from T", format: "csv", fileName: "result.csv", options: defaultTransferOptions("csv"), data: { columns: [{ name: "ID", type: "VARCHAR2", precision: 0, scale: 0 }], rows: [["private bind"]] } });
const out: TransferFileOut = { path: "D:/exports/result.csv", fileName: "result.csv", rows: 1, bytes: 20, truncated: false, canceled: false, ms: 100, destinationToken: "token-a", warnings: [] };
const progress = (id: string, exportId: number, rows: number): TransferProgress => ({ id, exportId, rows, bytes: rows * 20, elapsedMs: 100, rowsPerSec: 10, bytesPerSec: 200, phase: "writing" });
let jobs: typeof import("./resultTransferJobs");
let operations: typeof import("./operations");

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1000);
  mocks.file.mockReset(); mocks.cancel.mockReset().mockResolvedValue(undefined); mocks.toast.mockClear(); mocks.handlers.length = 0; mocks.unlisteners.length = 0;
  operations = await import("./operations"); jobs = await import("./resultTransferJobs");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("导出任务隔离与取消", () => {
  it("仅最近5个完成任务保留重试快照，同来源再次完成也按最近处理",async()=>{
    mocks.file.mockResolvedValue(out);
    for(let i=0;i<8;i++){
      const s=source("conn-a",`r${i}`),req=request(),data=req.data!;
      await jobs.startTransferJob(s,req,"输出",{frame:{source:s,data,order:[0],visible:[0],selection:null,labels:["ID"]},seed:{options:req.options,scope:"filtered",edited:false,columnOrder:[0]}});
    }
    expect(jobs.getTransferJob(jobs.transferJobKey(source("conn-a","r0")))?.retry).toBeUndefined();
    expect(jobs.getTransferJob(jobs.transferJobKey(source("conn-a","r7")))?.retry).toBeDefined();
    const s=source("conn-a","r0"),req=request();await jobs.startTransferJob(s,req,"重试",{frame:{source:s,data:req.data!,order:[0],visible:[0],selection:null,labels:["ID"]},seed:{options:req.options,scope:"filtered",edited:false,columnOrder:[0]}});
    expect(jobs.getTransferJob(jobs.transferJobKey(s))?.retry).toBeDefined();
    expect(jobs.getTransferJob(jobs.transferJobKey(source("conn-a","r3")))?.retry).toBeUndefined();
  });
  it.each([false,true])("晚到取消错误不复活已完成任务或污染后续实例（后续=%s）",async next=>{
    const first=pending<TransferFileOut|null>(),second=pending<TransferFileOut|null>(),cancel=pending<void>();
    mocks.file.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);mocks.cancel.mockReturnValue(cancel.promise);
    const running=jobs.startTransferJob(source(),request(),"首次");await Promise.resolve();
    const id=mocks.file.mock.calls[0][0].exportId,key=jobs.transferJobKey(source());mocks.handlers[0](progress("conn-a",id,1));
    const stopping=jobs.stopTransferJob(key);first.resolve(out);await running;expect(jobs.getTransferJob(key)?.state).toBe("success");
    const again=next ? jobs.startTransferJob(source(),request(),"再次") : undefined;await Promise.resolve();
    cancel.reject(Error("导出已经结束"));await stopping;expect(jobs.getTransferJob(key)?.state).toBe(next ? "running" : "success");expect(jobs.getTransferJob(key)?.notice).toBeUndefined();
    if(next){expect(jobs.getTransferJob(key)?.exportId).not.toBe(id);second.resolve(out);await again;}
  });
  it("两个连接相同结果ID仍是独立任务，进度需同时匹配连接和实例", async () => {
    const a = pending<TransferFileOut | null>(), b = pending<TransferFileOut | null>();
    mocks.file.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const runA = jobs.startTransferJob(source("conn-a", "same-result"), request("conn-a"), "来源A");
    const runB = jobs.startTransferJob(source("conn-b", "same-result"), request("conn-b"), "来源B");
    await Promise.resolve();
    const idA = mocks.file.mock.calls[0][0].exportId, idB = mocks.file.mock.calls[1][0].exportId;
    expect(idA).not.toBe(idB);
    mocks.handlers.forEach(handler => handler(progress("conn-a", idA, 7)));
    const keyA = jobs.transferJobKey(source("conn-a", "same-result")), keyB = jobs.transferJobKey(source("conn-b", "same-result"));
    expect(jobs.getTransferJob(keyA)?.progress.rows).toBe(7); expect(jobs.getTransferJob(keyB)?.progress.rows).toBe(0);
    mocks.handlers[0](progress("conn-b", idA, 90)); expect(jobs.getTransferJob(keyA)?.progress.rows).toBe(7);
    mocks.handlers[1](progress("conn-b", idB, 3)); expect(jobs.getTransferJob(keyB)?.progress.rows).toBe(3);
    await jobs.stopTransferJob(keyA); expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(idA);
    expect(jobs.getTransferJob(keyA)?.state).toBe("cancelling"); expect(jobs.getTransferJob(keyB)?.state).toBe("running");
    a.resolve({ ...out, canceled: true }); b.resolve(out); await Promise.all([runA, runB]);
    expect(jobs.getTransferJob(keyA)?.state).toBe("partial"); expect(jobs.getTransferJob(keyB)?.state).toBe("success");
    expect(mocks.unlisteners.every(un => un.mock.calls.length === 1)).toBe(true);
  });

  it("准备阶段重复点击只发一次，完成后再导出使用新实例并忽略晚到旧进度", async () => {
    const first = pending<TransferFileOut | null>(), second = pending<TransferFileOut | null>();
    mocks.file.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const runFirst = jobs.startTransferJob(source(), request(), "首次");
    await jobs.startTransferJob(source(), request(), "重复"); expect(mocks.file).toHaveBeenCalledTimes(1);
    const oldId = mocks.file.mock.calls[0][0].exportId, oldHandler = mocks.handlers[0];
    first.resolve(out); await runFirst;
    const runSecond = jobs.startTransferJob(source(), request(), "再次"); await Promise.resolve();
    const newId = mocks.file.mock.calls[1][0].exportId; expect(newId).not.toBe(oldId);
    oldHandler(progress("conn-a", oldId, 999)); expect(jobs.getTransferJob(jobs.transferJobKey(source()))?.progress.rows).toBe(0);
    mocks.handlers[1](progress("conn-a", newId, 2)); expect(jobs.getTransferJob(jobs.transferJobKey(source()))?.progress.rows).toBe(2);
    second.resolve(out); await runSecond;
    expect(JSON.stringify(operations.getOperations())).not.toMatch(/secret|private bind/);
  });

  it("准备取消失败恢复running，首次有效进度后仍能重试停止", async () => {
    const writing = pending<TransferFileOut | null>(); mocks.file.mockReturnValue(writing.promise);
    const run = jobs.startTransferJob(source(), request(), "当前结果"); await Promise.resolve();
    const key = jobs.transferJobKey(source()), id = mocks.file.mock.calls[0][0].exportId;
    await jobs.stopTransferJob(key);
    expect(mocks.cancel).not.toHaveBeenCalled(); expect(jobs.getTransferJob(key)?.state).toBe("running");
    expect(operations.getOperations()[0]).toMatchObject({ state: "running", detail: "停止请求失败：返回来源页查看错误" });
    mocks.handlers[0](progress("conn-a", id, 1)); await jobs.stopTransferJob(key);
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(id); expect(jobs.getTransferJob(key)?.state).toBe("cancelling");
    writing.resolve({ ...out, canceled: true }); await run; expect(jobs.getTransferJob(key)?.state).toBe("partial");
  });

  it("后端停止请求失败恢复running，原导出成功后不能再取消已结束实例", async () => {
    const writing = pending<TransferFileOut | null>(); mocks.file.mockReturnValue(writing.promise); mocks.cancel.mockRejectedValueOnce(new Error("connection lost"));
    const run = jobs.startTransferJob(source(), request(), "当前结果"); await Promise.resolve();
    const key = jobs.transferJobKey(source()), id = mocks.file.mock.calls[0][0].exportId;
    mocks.handlers[0](progress("conn-a", id, 1)); await jobs.stopTransferJob(key);
    expect(jobs.getTransferJob(key)?.state).toBe("running"); expect(operations.getOperations()[0].state).toBe("running");
    writing.resolve(out); await run; await jobs.stopTransferJob(key);
    expect(mocks.cancel).toHaveBeenCalledTimes(1); expect(jobs.getTransferJob(key)?.state).toBe("success");
  });

  it("未保存、截断与写入失败的状态不同，失败后解绑进度并保留来源错误", async () => {
    mocks.file.mockResolvedValueOnce(null); await jobs.startTransferJob(source(), request(), "取消保存");
    expect(jobs.getTransferJob(jobs.transferJobKey(source()))?.state).toBe("cancelled");
    mocks.file.mockResolvedValueOnce({ ...out, truncated: true }); await jobs.startTransferJob(source("conn-a", "truncated"), request(), "达到上限");
    expect(jobs.getTransferJob(jobs.transferJobKey(source("conn-a", "truncated")))?.state).toBe("partial");
    mocks.file.mockRejectedValueOnce(new Error("disk is full")); await jobs.startTransferJob(source("conn-a", "failed"), request(), "失败");
    expect(jobs.getTransferJob(jobs.transferJobKey(source("conn-a", "failed")))).toMatchObject({ state: "failed", error: "disk is full" });
    expect(mocks.unlisteners.every(un => un.mock.calls.length === 1)).toBe(true);
    expect(operations.getOperations().map(operation => operation.state)).toEqual(["cancelled", "success", "failed"]);
  });
});
