import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportFileOut } from "./dbApi";
const feedback=vi.hoisted(()=>({handler:null as null|((progress:{id:string;exportId?:number;rows:number})=>void),un:vi.fn()}));
vi.mock("./tauri",()=>({listen:vi.fn(async(_event:string,handler:typeof feedback.handler)=>{feedback.handler=handler;return feedback.un;})}));

vi.mock("./dbApi", () => ({
  dbApi: { exportFile: vi.fn(), cancelExport: vi.fn() },
}));
vi.mock("./dbStore", () => ({ connOf:()=>({name:"测试连接"}),sqlTabOf: vi.fn(), isRunning: (t:{run?:unknown}|null|undefined)=>!!t?.run, execOne: vi.fn(), patchTab: vi.fn() }));
vi.mock("./dbConfirm", () => ({ ensureConnected: vi.fn(async () => true) }));
vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));

import { dbApi } from "./dbApi";
import { sqlTabOf } from "./dbStore";
import { clearCompletedOperations, getOperations } from "./operations";
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
    clearCompletedOperations();
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

  it("同标签导出中重复点击不创建第二份；结束后可以发起下一次", async () => {
    const a = pending(); const b = pending();
    exportMock.mockReturnValueOnce(a.p).mockReturnValueOnce(b.p);
    const runA = exportResultFile("t1", "select 1", "csv", "T");
    const duplicate = await exportResultFile("t1", "select 2", "csv", "T");
    expect(duplicate).toBeNull();expect(exportMock).toHaveBeenCalledTimes(1);
    a.resolve(out);await runA;
    const runB = exportResultFile("t1", "select 2", "csv", "T");
    cancelResultExport("t1");
    expect(cancelMock).toHaveBeenCalledWith(idOf(1));
    expect(getOperations().slice(-1)[0].state).toBe("cancelling");
    b.resolve({...out,canceled:true});await runB;
    expect(getOperations().slice(-1)[0].state).toBe("cancelled");
    cancelResultExport("t1");expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("导出失败摘要不泄漏 SQL 与数据库原始错误", async () => {
    exportMock.mockRejectedValue(new Error("select password from secret_table : secret-value"));
    await exportResultFile("t1", "select password from secret_table", "csv", "T");
    const task=getOperations().slice(-1)[0];
    expect(task.state).toBe("failed");expect(JSON.stringify(task)).not.toContain("secret");
  });

  it("后端正常完成不因已发送停止请求而误报取消，截断有明确说明", async () => {
    const a=pending();exportMock.mockReturnValue(a.p);
    const run=exportResultFile("t1","select 1","csv","T");cancelResultExport("t1");
    a.resolve({...out,truncated:true});await run;
    const task=getOperations().slice(-1)[0];expect(task.state).toBe("success");expect(task.detail).toContain("不是全量");
  });

  it("导出进度按连接与实例过滤，完成后迟到的事件不再改结果",async()=>{
    const a=pending();exportMock.mockReturnValue(a.p);const run=exportResultFile("t1","select 1","csv","T");
    feedback.handler?.({id:"other",exportId:idOf(0),rows:5});expect(getOperations().slice(-1)[0].progress).toBeUndefined();
    feedback.handler?.({id:"c1",exportId:idOf(0),rows:5});expect(getOperations().slice(-1)[0].progress).toEqual({done:5});
    a.resolve(out);await run;const snapshot=getOperations().slice(-1)[0];
    feedback.handler?.({id:"c1",exportId:idOf(0),rows:9});expect(getOperations().slice(-1)[0]).toBe(snapshot);expect(feedback.un).toHaveBeenCalled();
  });

});
