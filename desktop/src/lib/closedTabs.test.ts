import { beforeEach, describe, expect, it } from "vitest";
import { clearClosed, closedCount, popClosed, rememberClosed } from "./closedTabs";

beforeEach(() => {
  clearClosed();
});

describe("已关闭标签栈", () => {
  it("后关的先重开（LIFO）", () => {
    rememberClosed("C:\\w\\a.java");
    rememberClosed("C:\\w\\b.java");
    expect(popClosed()).toBe("C:\\w\\b.java");
    expect(popClosed()).toBe("C:\\w\\a.java");
    expect(popClosed()).toBeNull();
  });

  it("重复关闭同一个文件只留一份，并挪到最前", () => {
    rememberClosed("C:\\w\\a.java");
    rememberClosed("C:\\w\\b.java");
    rememberClosed("C:\\w\\a.java");
    expect(closedCount()).toBe(2);
    expect(popClosed()).toBe("C:\\w\\a.java");
    expect(popClosed()).toBe("C:\\w\\b.java");
  });

  it("jar 内的类不记：没有可重读的磁盘路径", () => {
    rememberClosed("jdt://contents/a/A.class");
    expect(closedCount()).toBe(0);
  });

  it("最多保留 20 个，超出的丢最旧的", () => {
    for (let i = 0; i < 25; i++) rememberClosed(`C:\\w\\f${i}.java`);
    expect(closedCount()).toBe(20);
    expect(popClosed()).toBe("C:\\w\\f24.java");
    for (let i = 0; i < 18; i++) popClosed();
    expect(popClosed()).toBe("C:\\w\\f5.java");
  });
});
