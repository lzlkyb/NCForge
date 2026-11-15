// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteJavaTemplate, effectiveJavaTemplates, getJavaFileHeader, getJavaTemplates, saveJavaFileHeader, saveJavaTemplate } from "./javaTemplateStore";
beforeEach(() => { for (const item of [...getJavaTemplates()]) deleteJavaTemplate(item.prefix); });

describe("Java模板管理", () => {
  it("可覆盖/禁用内置模板，删除覆盖恢复默认", () => {
    const builtins = [{ prefix: "sout", detail: "打印", body: "print($1)" }];
    saveJavaTemplate({ prefix: "sout", detail: "自定义", body: "logger.info($1)", enabled: false });
    expect(effectiveJavaTemplates(builtins)).toEqual([]);
    deleteJavaTemplate("sout"); expect(effectiveJavaTemplates(builtins)).toEqual(builtins);
  });
  it("新增与编辑持久化，写入失败保持原状态", () => {
    saveJavaTemplate({ prefix: "custom", detail: "自定义", body: "one($1);" });
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => saveJavaTemplate({ prefix: "custom", detail: "修改", body: "two($1);" })).toThrow("disk full");
    expect(getJavaTemplates()[0].body).toBe("one($1);"); spy.mockRestore();
  });
  it("拒绝无效前缀与空内容", () => {
    expect(() => saveJavaTemplate({ prefix: "../bad", detail: "", body: "x" })).toThrow();
    expect(() => saveJavaTemplate({ prefix: "empty", detail: "", body: "" })).toThrow();
  });
  it("文件头存储失败明确返回false并保留旧值", () => {
    expect(saveJavaFileHeader("original")).toBe(true);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disk full"); });
    expect(saveJavaFileHeader("changed")).toBe(false);
    expect(getJavaFileHeader()).toBe("original"); spy.mockRestore();
    saveJavaFileHeader("");
  });
});
