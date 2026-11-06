// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DEVELOPMENT_OPTIONS } from "./developmentFlow";
import { readDevelopmentOptions, saveDevelopmentOptions } from "./developmentFlowPrefs";
beforeEach(() => localStorage.clear());
describe("开发流程配置", () => {
  it("未打开工作区及损坏内容使用明确默认值", () => {
    expect(readDevelopmentOptions(null)).toEqual(DEFAULT_DEVELOPMENT_OPTIONS);
    localStorage.setItem("ncforge-development-flow:c:/work/newar", "{");
    expect(readDevelopmentOptions("C:\\work\\newar")).toEqual(DEFAULT_DEVELOPMENT_OPTIONS);
  });
  it("按工作区保存，路径大小写与斜线不改变归属", () => {
    saveDevelopmentOptions("C:\\work\\newar", { ...DEFAULT_DEVELOPMENT_OPTIONS, compile: true, debug: true, autoAttach: true });
    expect(readDevelopmentOptions("c:/work/newar/")).toMatchObject({ compile: true, debug: true, autoAttach: true });
    expect(readDevelopmentOptions("C:/work/other")).toEqual(DEFAULT_DEVELOPMENT_OPTIONS);
  });
  it("仅接受布尔选项，关闭调试时不保留自动附加", () => {
    localStorage.setItem("ncforge-development-flow:c:/work/newar", JSON.stringify({ compile: "true", debug: false, autoAttach: true, client: false }));
    expect(readDevelopmentOptions("C:/work/newar")).toMatchObject({ compile: false, debug: false, autoAttach: false, client: false });
  });
  it("存储写入失败保留错误，由UI提示恢复", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("存储不可写"); };
    try { expect(() => saveDevelopmentOptions("C:/work/newar", DEFAULT_DEVELOPMENT_OPTIONS)).toThrow("存储不可写"); }
    finally { Storage.prototype.setItem = original; }
  });
});
