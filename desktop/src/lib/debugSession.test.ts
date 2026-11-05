// @vitest-environment jsdom
/**
 * 监视表达式（debug_evaluate）的接线。重点回归三件事：
 * 1. 暂停在某一帧时添加即求值，求值必须带当前 frameId（不带就落到全局上下文，结果会错）；
 * 2. 切换栈帧后按新帧重算，而不是沿用旧帧的值；
 * 3. 重复/超上限的表达式不重复下发。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("./tauri", () => ({
  invoke: mocks.invoke,
  listen: vi.fn(async () => () => {}),
}));

import {
  MAX_DEBUG_WATCHES,
  __setDebugFrameForTest,
  addWatch,
  clearConsole,
  evaluateConsole,
  expandVariables,
  getDebugSnapshot,
  removeWatch,
  selectFrame,
} from "./debugSession";

const clearWatches = () => {
  for (const w of getDebugSnapshot().watches) removeWatch(w.expression);
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue({});
  __setDebugFrameForTest(null);
  clearConsole();
  clearWatches();
});

describe("调试监视表达式", () => {
  it("暂停在某一帧时添加即求值，并带上当前 frameId", async () => {
    __setDebugFrameForTest(7);
    mocks.invoke.mockResolvedValue({ result: "42", type: "int" });

    await addWatch("  1 + 41 ");

    expect(mocks.invoke).toHaveBeenCalledWith("debug_evaluate", {
      target: "server",
      expression: "1 + 41",
      frameId: 7,
      context: "watch",
    });
    expect(getDebugSnapshot().watches).toEqual([
      { expression: "1 + 41", result: "42", type: "int", error: null, evaluating: false },
    ]);
  });

  it("未暂停时先记下表达式，不下发求值", async () => {
    await addWatch("vo.getCode()");

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(getDebugSnapshot().watches[0]).toMatchObject({ expression: "vo.getCode()", result: null });
  });

  it("重复表达式只保留一条，超过上限不再添加", async () => {
    for (let i = 0; i < MAX_DEBUG_WATCHES; i++) await addWatch(`v${i}`);
    await addWatch("v0");
    await addWatch("beyond-limit");

    const expressions = getDebugSnapshot().watches.map((w) => w.expression);
    expect(expressions).toHaveLength(MAX_DEBUG_WATCHES);
    expect(new Set(expressions).size).toBe(MAX_DEBUG_WATCHES);
    expect(expressions).not.toContain("beyond-limit");
  });

  it("求值失败写进该行的 error，不打断其它监视", async () => {
    __setDebugFrameForTest(3);
    mocks.invoke.mockRejectedValueOnce(new Error("Evaluate failed"));

    await addWatch("bad.expr()");

    expect(getDebugSnapshot().watches[0]).toMatchObject({
      expression: "bad.expr()",
      result: null,
      error: "Evaluate failed",
      evaluating: false,
    });
  });

  it("切换栈帧后按新帧重算已有监视", async () => {
    __setDebugFrameForTest(3);
    mocks.invoke.mockResolvedValue({ result: "old" });
    await addWatch("x");
    expect(getDebugSnapshot().watches[0].result).toBe("old");

    mocks.invoke.mockClear();
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "debug_scopes") return { scopes: [] };
      if (cmd === "debug_evaluate") return { result: "new" };
      return {};
    });

    await selectFrame(3);

    await vi.waitFor(() => {
      const evaluated = mocks.invoke.mock.calls.some((c) => c[0] === "debug_evaluate");
      expect(evaluated).toBe(true);
      expect(getDebugSnapshot().watches[0].result).toBe("new");
    });
    const call = mocks.invoke.mock.calls.find((c) => c[0] === "debug_evaluate");
    expect(call?.[1]).toEqual({ target: "server", expression: "x", frameId: 3, context: "watch" });
  });
});

describe("调试控制台与变量分页", () => {
  it("暂停时以 repl 上下文求值，结果写进对应条目", async () => {
    __setDebugFrameForTest(7);
    mocks.invoke.mockResolvedValue({ result: "42", type: "int" });

    await evaluateConsole("  1 + 41 ");

    expect(mocks.invoke).toHaveBeenCalledWith("debug_evaluate", {
      target: "server",
      expression: "1 + 41",
      frameId: 7,
      context: "repl",
    });
    const entries = getDebugSnapshot().console;
    expect(entries[entries.length - 1]).toMatchObject({
      expression: "1 + 41",
      result: "42",
      type: "int",
      error: null,
      pending: false,
    });
  });

  it("未暂停时控制台不求值", async () => {
    await evaluateConsole("vo.getCode()");
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(getDebugSnapshot().console).toEqual([]);
  });

  it("集合分页按已加载条数续取，重叠页不产生重复行", async () => {
    __setDebugFrameForTest(7);
    mocks.invoke.mockResolvedValueOnce({
      variables: [
        { name: "0", value: "a", variablesReference: 0 },
        { name: "1", value: "b", variablesReference: 0 },
      ],
    });
    await expandVariables(9);

    // 适配器按 start 重新给了一页（与上一页有重叠），前端只认新名字
    mocks.invoke.mockResolvedValueOnce({
      variables: [
        { name: "1", value: "b", variablesReference: 0 },
        { name: "2", value: "c", variablesReference: 0 },
      ],
    });
    await expandVariables(9, 2);

    expect(mocks.invoke).toHaveBeenLastCalledWith("debug_variables", {
      target: "server",
      variablesReference: 9,
      start: 2,
      count: 100,
    });
    expect(getDebugSnapshot().variables[9].map((v) => v.name)).toEqual(["0", "1", "2"]);
  });
});
