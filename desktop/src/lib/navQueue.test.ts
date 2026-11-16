import { describe, expect, it, vi } from "vitest";
import { createNavQueue, type NavRequest } from "./navQueue";

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const back: NavRequest = { delta: -1 };

describe("历史跳转队列（L16）", () => {
  it("忙时不丢后一次点击：两下退两格，且目标在出队时才求值", async () => {
    const wait = deferred<boolean>();
    const seen: NavRequest[] = [];
    const go = createNavQueue(async req => {
      seen.push(req);
      // 第一次挂在异步打开上；第二次必须等它落定后才被求值
      return seen.length === 1 ? wait.promise : true;
    });
    const first = go(back), second = go(back);
    expect(seen).toHaveLength(1);
    wait.resolve(true);
    await Promise.all([first, second]);
    expect(seen).toHaveLength(2);
  });

  it("返回的 promise 等到整条队列收尾，不是只等第一下", async () => {
    const wait = deferred<boolean>();
    let done = 0;
    const go = createNavQueue(async () => {
      if (done === 0) { await wait.promise; done = 1; return true; }
      done = 2; return true;
    });
    let settled = false;
    const job = go(back).then(() => { settled = true; });
    void go(back);
    await Promise.resolve();
    expect(settled).toBe(false);
    wait.resolve(true);
    await job;
    expect(done).toBe(2);
  });

  it("没有目标时清空剩余队列：连点十下不在边界空转十次", async () => {
    const step = vi.fn(async () => false);
    const go = createNavQueue(step);
    const jobs = [go(back), go(back), go(back), go(back)];
    await Promise.all(jobs);
    expect(step).toHaveBeenCalledOnce();
  });

  it("绝对下标与相对量互不混淆：goToHistory(1) 不是「前进一格」", async () => {
    const seen: NavRequest[] = [];
    const go = createNavQueue(async req => { seen.push(req); return true; });
    await go({ index: 1 });
    await go({ delta: 1 });
    expect(seen).toEqual([{ index: 1 }, { delta: 1 }]);
  });

  it("收尾期间进来的请求不丢：重新起一条链", async () => {
    const seen: NavRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>(yes => { release = yes; });
    const go = createNavQueue(async req => {
      seen.push(req);
      if (seen.length === 1) { await gate; queueMicrotask(() => void go({ index: 9 })); }
      return true;
    });
    const job = go(back);
    release();
    await job;
    await Promise.resolve();
    expect(seen).toEqual([back, { index: 9 }]);
  });
});
