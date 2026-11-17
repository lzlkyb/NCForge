import { describe, expect, it } from "vitest";
import { appErrorOf, IpcError, isRawAppError, toIpcError } from "./ipcError";

const raw = (over: Record<string, unknown> = {}) => ({
  code: "io.notFound",
  class: "environment",
  detail: "os error 2: 找不到文件",
  ...over,
});

describe("后端结构化错误转 Error", () => {
  it("对象 → IpcError，code/class/detail 都留住", () => {
    const e = toIpcError(raw({ hint: "刷新一下" })) as IpcError;
    expect(e).toBeInstanceOf(IpcError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("io.notFound");
    expect(e.class).toBe("environment");
    expect(e.message).toBe("os error 2: 找不到文件");
    expect(e.hint).toBe("刷新一下");
  });

  /**
   * 这一条是整件事的**底线**：项目里几千处 `catch` 都按字符串/Error 写的。
   * 裸对象进来会让 `String(e)` 变成 `[object Object]`，错误信息当场消失。
   */
  it("String() 拿到的是人可读的详情，不是 [object Object]", () => {
    const e = toIpcError(raw());
    expect(String(e)).toContain("找不到文件");
    expect(String(e)).not.toContain("[object Object]");
  });

  it("字符串错误原样透传：存量命令不受影响", () => {
    expect(toIpcError("failed to start server: os error 2")).toBe("failed to start server: os error 2");
  });

  it("既有 Error 原样透传，不会被再包一层", () => {
    const e = new Error("boom");
    expect(toIpcError(e)).toBe(e);
  });

  it("幂等：IpcError 再进来还是同一个", () => {
    const once = toIpcError(raw());
    expect(toIpcError(once)).toBe(once);
  });

  it("缺 code 或 detail 的对象不当成结构化错误", () => {
    expect(toIpcError({ code: "x" })).toEqual({ code: "x" });
    expect(toIpcError({ detail: "x" })).toEqual({ detail: "x" });
    expect(toIpcError({ message: "x" })).toEqual({ message: "x" });
    expect(isRawAppError(null)).toBe(false);
    expect(isRawAppError("x")).toBe(false);
  });

  /**
   * 未知 class 落 `internal` 而不是 `environment`：契约坏了是我们的问题，
   * 归到「用户能处理」那类会被静默忽略。
   */
  it("class 不在已知集合时落到 internal", () => {
    const e = toIpcError(raw({ class: "boom" })) as IpcError;
    expect(e.class).toBe("internal");
    expect(e.code).toBe("io.notFound");
  });

  it("空白 hint 当没有", () => {
    const e = toIpcError(raw({ hint: "   " })) as IpcError;
    expect(e.hint).toBeUndefined();
  });

  it("没有 hint 时属性就是 undefined，不是空串", () => {
    const e = toIpcError(raw()) as IpcError;
    expect(e.hint).toBeUndefined();
    expect("hint" in e && e.hint === undefined).toBe(true);
  });

  it("appErrorOf 只认 IpcError", () => {
    expect(appErrorOf(toIpcError(raw()))).toBeInstanceOf(IpcError);
    expect(appErrorOf("text")).toBeNull();
    expect(appErrorOf(raw())).toBeNull();
  });
});
