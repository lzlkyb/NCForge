// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCompactPackages,
  getRevealOnOpen,
  setCompactPackages,
  setRevealOnOpen,
  toggleCompactPackages,
  toggleRevealOnOpen,
} from "./treeViewPrefs";

const KEY = "ncforge.tree.compactPackages";
const REVEAL_KEY = "ncforge.tree.revealOnOpen";

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  setCompactPackages(true);
  setRevealOnOpen(true);
});

describe("压缩中间包偏好", () => {
  it("默认开，关掉后落盘成 0，再切回来写 1", () => {
    expect(getCompactPackages()).toBe(true);
    setCompactPackages(false);
    expect(getCompactPackages()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    toggleCompactPackages();
    expect(getCompactPackages()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("存储写不进去（隐私模式 / 配额满）时本次会话仍然生效", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    setCompactPackages(false);
    expect(getCompactPackages()).toBe(false);
  });
});

describe("自动定位偏好", () => {
  it("默认开，关掉后落盘成 0，再切回来写 1", () => {
    expect(getRevealOnOpen()).toBe(true);
    setRevealOnOpen(false);
    expect(getRevealOnOpen()).toBe(false);
    expect(localStorage.getItem(REVEAL_KEY)).toBe("0");
    toggleRevealOnOpen();
    expect(getRevealOnOpen()).toBe(true);
    expect(localStorage.getItem(REVEAL_KEY)).toBe("1");
  });

  // 两个开关各存各的键：改一个不该把另一个也写脏
  it("与压缩中间包互不影响", () => {
    setRevealOnOpen(false);
    expect(getCompactPackages()).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();

    setCompactPackages(false);
    expect(getRevealOnOpen()).toBe(false);
    expect(localStorage.getItem(REVEAL_KEY)).toBe("0");
  });
});
