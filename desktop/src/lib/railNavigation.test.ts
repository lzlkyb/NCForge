// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSideOpen, setSideOpen } from "./layoutStore";
import { navigateRail } from "./railNavigation";

let original: boolean;
beforeEach(() => { original = getSideOpen(); });
afterEach(() => setSideOpen(original));

describe("主导航与侧栏偏好", () => {
  it.each([true, false])("重复点击日志不改代码侧栏偏好 %s", (open) => {
    setSideOpen(open); const go = vi.fn();
    navigateRail("logs", "logs", go);
    expect(getSideOpen()).toBe(open); expect(go).not.toHaveBeenCalled();
  });
  it("进入日志并返回代码保留收起偏好", () => {
    setSideOpen(false); const go = vi.fn();
    navigateRail("files", "logs", go); navigateRail("logs", "files", go);
    expect(getSideOpen()).toBe(false);
    expect(go.mock.calls).toEqual([["logs"], ["files"]]);
  });
  it("打开其他工具仍展开其实际侧栏", () => {
    setSideOpen(false); const go = vi.fn();
    navigateRail("logs", "db", go);
    expect(getSideOpen()).toBe(true); expect(go).toHaveBeenCalledWith("db");
  });
  it("重复点击代码继续切换可见资源侧栏", () => {
    setSideOpen(true); const go = vi.fn(); navigateRail("files", "files", go);
    expect(getSideOpen()).toBe(false); expect(go).not.toHaveBeenCalled();
  });
});
