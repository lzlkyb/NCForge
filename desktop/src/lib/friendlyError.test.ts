import { describe, expect, it } from "vitest";
import { friendlyError, failureText } from "./friendlyError";
import { toIpcError } from "./ipcError";

/** 造一个"新命令抛上来的结构化错误"。 */
function appErr(code: string, detail: string, extra: Record<string, unknown> = {}) {
  return toIpcError({ code, class: "environment", detail, ...extra });
}

describe("结构化错误优先于正则", () => {
  it("认识 code 就直接给人话，不看 detail 长什么样", () => {
    // detail 特地写成正则看不懂的样子：走正则只能原文返回
    expect(friendlyError(appErr("io.permissionDenied", "os error 5"))).toContain("没有权限");
    expect(friendlyError(appErr("diagnostics.empty", "no entries"))).toContain("没有勾选");
  });

  it("有 hint 时附在括号里", () => {
    const text = friendlyError(appErr("io.notFound", "gone", { hint: "刷新一下再试" }));
    expect(text).toContain("找不到文件");
    expect(text).toContain("刷新一下再试");
  });

  /**
   * 后端新增 code、前端还没加文案时**不能变得更差**：
   * 有 hint 用 hint（后端比前端懂这次失败），没 hint 退回原来的正则链路。
   */
  it("未知 code：有 hint 用 hint，没 hint 退回正则", () => {
    expect(friendlyError(appErr("brand.new", "whatever", { hint: "先连上服务" }))).toBe("先连上服务");
    expect(friendlyError(appErr("brand.new", "os error 112, not enough space"))).toContain("磁盘空间不足");
  });

  it("存量字符串错误的老路径完全不变", () => {
    expect(friendlyError("failed to start server: os error 2")).toContain("找不到文件");
    expect(friendlyError("随便一句看不出来的中文")).toBe("随便一句看不出来的中文");
  });

  it("failureText 走同一条链路", () => {
    expect(failureText("导出诊断包", appErr("diagnostics.empty", "x"))).toBe(
      "导出诊断包失败：没有勾选任何内容，未生成诊断包",
    );
  });
});
