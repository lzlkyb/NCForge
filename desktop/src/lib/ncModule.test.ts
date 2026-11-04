import { describe, expect, it } from "vitest";
import { moduleOf } from "./ncModule";

const ROOT = "C:\\work\\aier\\newar";

describe("moduleOf", () => {
  it("模块目录本身与它下面任意深度都算同一个模块", () => {
    expect(moduleOf(ROOT, `${ROOT}\\bill`)).toBe("bill");
    expect(moduleOf(ROOT, `${ROOT}\\bill\\src\\public`)).toBe("bill");
    expect(moduleOf(ROOT, `${ROOT}\\aim`)).toBe("aim");
  });

  it("正斜杠写法与反斜杠等价（NC 工程里两种都有）", () => {
    expect(moduleOf(ROOT, "C:/work/aier/newar/gl/src")).toBe("gl");
    expect(moduleOf("C:/work/aier/newar/", `${ROOT}\\gl`)).toBe("gl");
  });

  it("工作区根自己不是模块", () => {
    expect(moduleOf(ROOT, ROOT)).toBeNull();
    expect(moduleOf(ROOT, `${ROOT}\\`)).toBeNull();
  });

  it("关联工程的路径不认（编译只对当前工作区开放）", () => {
    expect(moduleOf(ROOT, "C:\\w\\lib\\bill\\src")).toBeNull();
  });

  /**
   * 前缀相同不算在里面：`C:\work\aier\newar-备份` 以 `…newar` 开头，
   * 只比前缀会把它当成工作区内的路径，编出一个不存在的模块。
   */
  it("前缀相同的兄弟目录不算", () => {
    expect(moduleOf(ROOT, "C:\\work\\aier\\newar-备份\\bill")).toBeNull();
  });

  it("大小写不敏感（Windows 路径）", () => {
    expect(moduleOf(ROOT, "c:\\WORK\\aier\\NEWAR\\bill")).toBe("bill");
  });

  it("空参数返回 null", () => {
    expect(moduleOf("", `${ROOT}\\bill`)).toBeNull();
    expect(moduleOf(ROOT, "")).toBeNull();
  });
});
