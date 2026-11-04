import { describe, expect, it } from "vitest";
import { getSvnWrite, withSvnWriteLock } from "./svnWrite";

describe("SVN 工作副本同步写锁", () => {
  it("在第一个 await 前锁住，重复/不同写操作都不能并行", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const first = withSvnWriteLock("C:/work", "commit", async () => pending);
    expect(getSvnWrite("c:\\WORK")?.kind).toBe("commit");
    await expect(withSvnWriteLock("c:\\work", "update", async () => undefined)).rejects.toThrow("正在执行写操作");
    release(); await first; expect(getSvnWrite("C:/work")).toBeNull();
  });
  it("同一动作可使用自身token嵌套，token不能跨工程或操作复用", async () => {
    await withSvnWriteLock("C:/work", "commit", async token => {
      expect(await withSvnWriteLock("C:/work", "commit", async () => 3, token)).toBe(3);
      await expect(withSvnWriteLock("D:/other", "commit", async () => 4, token)).rejects.toThrow("已变化");
      await expect(withSvnWriteLock("C:/work", "resolve", async () => 4, token)).rejects.toThrow("已变化");
    });
    expect(getSvnWrite("D:/other")).toBeNull();
  });
  it("失败也释放，其他工作副本独立", async () => {
    await expect(withSvnWriteLock("C:/work", "revert", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(getSvnWrite("C:/work")).toBeNull();
    await withSvnWriteLock("C:/work", "resolve", async () => {
      expect(await withSvnWriteLock("D:/other", "update", async () => 1)).toBe(1);
    });
  });
});
