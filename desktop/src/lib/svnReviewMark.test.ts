import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke, listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("./operations", () => ({
  trackOperation: (_o: unknown, work: () => unknown) => work(),
}));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: "C:\\w" }) }));

import { svnReviewMark } from "./svn";
import { withSvnWriteLock } from "./svnWrite";

const A = "C:\\w\\modules\\ic\\A.java";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 推进轮询间隔，并给 microtask 一个落地机会。 */
const tick = async (ms = 500) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("svnReviewMark 与 SVN 写操作排队", () => {
  it("没有写操作在飞时立即发，revision 原样带上", async () => {
    await svnReviewMark(A, -1, true);
    expect(mocks.invoke).toHaveBeenCalledWith("svn_review_mark", { path: A, revision: -1, reviewed: true });
  });

  it("取消标记（reviewed=false）不等写操作：后端不发桥请求", async () => {
    let release = () => {};
    const flying = withSvnWriteLock("C:\\w", "commit", () => new Promise<void>((r) => { release = r; }));
    await svnReviewMark(A, -1, false);
    expect(mocks.invoke).toHaveBeenCalledWith("svn_review_mark", { path: A, revision: -1, reviewed: false });
    release();
    await flying;
  });

  it("已知版本（>0）不等写操作：后端不会去查 info", async () => {
    let release = () => {};
    const flying = withSvnWriteLock("C:\\w", "update", () => new Promise<void>((r) => { release = r; }));
    await svnReviewMark(A, 14231, true);
    expect(mocks.invoke).toHaveBeenCalledWith("svn_review_mark", { path: A, revision: 14231, reviewed: true });
    release();
    await flying;
  });

  it("版本未知时等写操作结束再发：桥是单线程，插一条 info 会排到超时把桥杀掉", async () => {
    let release = () => {};
    const flying = withSvnWriteLock("C:\\w", "commit", () => new Promise<void>((r) => { release = r; }));
    const pending = svnReviewMark(A, -1, true);
    await tick();
    await tick();
    expect(mocks.invoke).not.toHaveBeenCalled();
    release();
    await flying;
    await tick();
    await pending;
    expect(mocks.invoke).toHaveBeenCalledWith("svn_review_mark", { path: A, revision: -1, reviewed: true });
  });

  it("写操作迟迟不结束就明说，不硬发（硬发就是杀桥）", async () => {
    const flying = withSvnWriteLock("C:\\w", "commit", () => new Promise<void>(() => {}));
    const pending = svnReviewMark(A, -1, true);
    // 先挂上拒绝处理器再推进时间：否则 reject 先于 await 发生，会被记成未处理拒绝
    const rejected = expect(pending).rejects.toThrow("正在提交/更新");
    await tick(61_000);
    await rejected;
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(typeof flying.then).toBe("function");
  });
});
