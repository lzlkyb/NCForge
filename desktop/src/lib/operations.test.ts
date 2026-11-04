import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginOperation, cancelOperation, clearCompletedOperations, getOperations, operationActive, retryOperation, trackOperation, updateOperation } from "./operations";
const deferred=<T>()=>{let resolve!:(v:T)=>void;let reject!:(e:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(0);clearCompletedOperations();});
afterEach(()=>{getOperations().filter(o=>o.endedAt===undefined).forEach(o=>updateOperation(o.key,{phase:"test cleanup"}));vi.useRealTimers();});
describe("用户操作状态",()=>{
  it("同一帧同key复用同一个Promise，不同key独立",async()=>{
    const a=deferred<number>(),b=deferred<number>();const run=vi.fn(()=>a.promise);
    const first=trackOperation({key:"a",label:"A"},run);const second=trackOperation({key:"a",label:"A"},run);
    const other=trackOperation({key:"b",label:"B"},()=>b.promise);
    expect(first).toBe(second);await Promise.resolve();expect(run).toHaveBeenCalledOnce();expect(getOperations()).toHaveLength(2);
    a.resolve(1);b.resolve(2);await Promise.all([first,other]);expect(operationActive("a")).toBe(false);
  });
  it("300ms以内不闪等待，不延迟结果",async()=>{
    await trackOperation({key:"fast",label:"快"},async()=>1);await vi.advanceTimersByTimeAsync(1000);
    expect(getOperations()[0]).toMatchObject({visible:false,state:"success",endedAt:0});
    const wait=deferred<void>();const job=trackOperation({key:"slow",label:"慢"},()=>wait.promise);
    await vi.advanceTimersByTimeAsync(299);expect(getOperations()[1].visible).toBe(false);
    await vi.advanceTimersByTimeAsync(1);expect(getOperations()[1].visible).toBe(true);wait.resolve();await job;
  });
  it("进度直接使用实际数量，结束后晚到事件无效",()=>{
    const h=beginOperation({key:"progress",label:"导出"})!;h.update({progress:{done:4,total:9}});expect(getOperations()[0].progress).toEqual({done:4,total:9});
    h.finish();h.update({progress:{done:8}});updateOperation("progress",{phase:"late"});expect(getOperations()[0].progress?.done).toBe(4);
  });
  it("取消请求返回后仍等待原调用，真实取消错误才结束",async()=>{
    const wait=deferred<void>();const cancel=vi.fn(async()=>{});
    const job=trackOperation({key:"cancel",label:"查询",cancel,cancelled:e=>String(e)==="CANCELLED"},()=>wait.promise);
    const assertion=expect(job).rejects.toBe("CANCELLED");await cancelOperation(getOperations()[0].id);
    expect(getOperations()[0].state).toBe("cancelling");expect(operationActive("cancel")).toBe(true);
    wait.reject("CANCELLED");await assertion;expect(getOperations()[0].state).toBe("cancelled");
  });
  it("取消请求失败恢复running，隐藏数据库原始异常",async()=>{
    const wait=deferred<void>();const job=trackOperation({key:"cancel-fail",label:"数据库",cancel:async()=>{throw "secret sql";},errorDetail:()=>"请查看原页面"},()=>wait.promise);
    await cancelOperation(getOperations()[0].id);expect(getOperations()[0]).toMatchObject({state:"running",detail:"停止请求失败：请查看原页面"});
    wait.resolve();await job;
  });
  it("work/outcome异常都结束，重试正确执行完整动作",async()=>{
    const retry=vi.fn(async()=>{});
    await expect(trackOperation({key:"fail",label:"读",retry,errorDetail:()=>"读取失败"},async()=>1,()=>{throw Error("secret");})).rejects.toThrow("secret");
    expect(getOperations()[0]).toMatchObject({state:"failed",detail:"读取失败"});expect(operationActive("fail")).toBe(false);
    await retryOperation(getOperations()[0].id);expect(retry).toHaveBeenCalledOnce();
  });
  it("清理与30条保留不会删除活跃任务，零时刻结束记录可清理",()=>{
    const running=beginOperation({key:"keep",label:"活跃"})!;
    for(let i=0;i<36;i++) beginOperation({key:`done${i}`,label:"结束"})!.finish();
    expect(getOperations()).toHaveLength(31);clearCompletedOperations();expect(getOperations()).toHaveLength(1);expect(getOperations()[0].id).toBe(running.id);running.finish();clearCompletedOperations();
  });
  it("取消返回晚于成功不会覆盖已经结束的状态",async()=>{
    const wait=deferred<void>();const h=beginOperation({key:"latecancel",label:"写入",cancel:()=>wait.promise})!;
    const cancelling=cancelOperation(h.id);h.finish("success","已写入");wait.resolve();await cancelling;expect(getOperations()[0].state).toBe("success");
  });
});
