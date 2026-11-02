import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearClosed, closedCount, rememberClosed } from "./closedTabs";
import { reopenClosed } from "./reopenClosed";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toast }));

beforeEach(() => {
  clearClosed();
  toast.mockClear();
});

describe("重开最近关闭的标签", () => {
  it("栈为空时提示，不假装打开", async () => {
    const open = vi.fn(async () => true);
    expect(await reopenClosed(open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("没有可重新打开的标签", "info");
  });

  it("最近的那个打不开时继续往回试", async () => {
    rememberClosed("C:\\w\\ok.java");
    rememberClosed("C:\\w\\gone.java");
    const open = vi.fn(async (p: string) => p.endsWith("ok.java"));
    expect(await reopenClosed(open)).toBe(true);
    expect(open.mock.calls.map((c) => c[0])).toEqual(["C:\\w\\gone.java", "C:\\w\\ok.java"]);
  });

  it("最多尝试 10 个，剩下的留在栈里", async () => {
    for (let i = 0; i < 12; i++) rememberClosed(`f${i}.java`);
    const open = vi.fn(async () => false);
    expect(await reopenClosed(open)).toBe(false);
    expect(open).toHaveBeenCalledTimes(10);
    expect(closedCount()).toBe(2);
  });
});
