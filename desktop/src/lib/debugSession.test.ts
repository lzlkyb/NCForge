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
  __emitDebugEventForTest,
  __setDebugFrameForTest,
  addWatch,
  clearConsole,
  dropFrame,
  evaluateConsole,
  expandVariables,
  getDebugSnapshot,
  removeWatch,
  selectFrame,
  setSuspendAll,
  __setDebugStatusForTest,
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

describe("适配器通知（usernotification）", () => {
  // condition / logMessage 是命中时才编译的，运行时报错只从 usernotification 来：
  // 不接就是「莫名停住」或「日志断点没反应」。见 breakpointCondition.ts 注释。
  it("求值失败的通知落到控制台，带级别前缀", () => {
    __emitDebugEventForTest("usernotification", {
      notificationType: "ERROR",
      message: "Breakpoint condition 'a = b' error: Syntax error",
    });

    const entries = getDebugSnapshot().console;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ expression: "适配器通知", pending: false });
    expect(entries[0].error).toContain("【错误】");
    expect(entries[0].error).toContain("Breakpoint condition");
  });

  it("WARNING 用警告前缀；空消息不入列", () => {
    __emitDebugEventForTest("usernotification", {
      notificationType: "WARNING",
      message: "Result of breakpoint condition 'x' is not a boolean, please correct your expression.",
    });
    __emitDebugEventForTest("usernotification", { notificationType: "ERROR", message: "   " });
    __emitDebugEventForTest("usernotification", null);

    const entries = getDebugSnapshot().console;
    expect(entries).toHaveLength(1);
    expect(entries[0].error).toContain("【警告】");
    expect(entries[0].error).toContain("is not a boolean");
  });
});

describe("Drop Frame（重置栈帧）", () => {
  it("暂停时下发 restartFrame；适配器拒绝时原话进 error", async () => {
    __setDebugFrameForTest(7);
    mocks.invoke.mockResolvedValue({});

    await dropFrame(7);
    expect(mocks.invoke).toHaveBeenCalledWith("debug_restart_frame", { target: "server", frameId: 7 });

    mocks.invoke.mockRejectedValueOnce(new Error("Current stack frame doesn't support restart."));
    await dropFrame(7);
    expect(getDebugSnapshot().error).toContain("doesn't support restart");
  });

  it("未暂停时不下发", async () => {
    await dropFrame(7);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("挂起策略（停住时挂起全部线程）", () => {
  // 适配器默认 EVENT_THREAD 只停命中线程；这里用现成 pause/continue 请求补齐
  // 「停全部 / 统一恢复」，不依赖适配器新能力（0.32.0 无 per-breakpoint suspend policy）。
  const threadsMock = () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "debug_threads") {
        return { threads: [{ id: 7, name: "main" }, { id: 12, name: "worker" }, { id: 13, name: "worker-2" }] };
      }
      if (cmd === "debug_stack_trace") return { stackFrames: [] };
      return {};
    });
  };
  const calls = (cmd: string) => mocks.invoke.mock.calls.filter((c) => c[0] === cmd);

  beforeEach(() => {
    __setDebugStatusForTest("server", "attached");
    // 清掉上一个用例留下的「代为挂起」记账（continued 会统一放行并清空集合）
    __emitDebugEventForTest("continued", { threadId: 0 });
  });

  it("默认开启：停住后把其余线程逐一 pause（顺序即线程表顺序）", async () => {
    threadsMock();
    __emitDebugEventForTest("stopped", { threadId: 7, reason: "breakpoint" });

    await vi.waitFor(() => {
      const pauses = calls("debug_pause");
      expect(pauses.map((c) => (c[1] as { threadId: number }).threadId)).toEqual([12, 13]);
      expect(pauses.every((c) => (c[1] as { target: string }).target === "server")).toBe(true);
    });
  });

  it("代为 pause 的线程自己的 stopped 事件不切上下文", async () => {
    threadsMock();
    __emitDebugEventForTest("stopped", { threadId: 7, reason: "breakpoint" });
    await vi.waitFor(() => expect(calls("debug_pause").length).toBe(2));

    __emitDebugEventForTest("stopped", { threadId: 12, reason: "pause" });

    expect(getDebugSnapshot().threadId).toBe(7);
    expect(getDebugSnapshot().stopReason).toBe("breakpoint");
  });

  it("continued 时把代为挂起的线程统一放行", async () => {
    threadsMock();
    __emitDebugEventForTest("stopped", { threadId: 7, reason: "breakpoint" });
    await vi.waitFor(() => expect(calls("debug_pause").length).toBe(2));

    mocks.invoke.mockClear();
    __emitDebugEventForTest("continued", { threadId: 7 });

    await vi.waitFor(() => {
      const continues = calls("debug_continue");
      expect(continues.map((c) => (c[1] as { threadId: number }).threadId)).toEqual([12, 13]);
    });
    expect(getDebugSnapshot().paused).toBe(false);
  });

  it("关掉偏好后只停当前线程，恢复时也不多发 continue", async () => {
    setSuspendAll(false);
    try {
      threadsMock();
      __emitDebugEventForTest("stopped", { threadId: 7, reason: "breakpoint" });
      await vi.waitFor(() => expect(calls("debug_threads").length).toBe(1));
      await new Promise((r) => setTimeout(r, 30)); // 等异步链走完
      expect(calls("debug_pause")).toHaveLength(0);

      mocks.invoke.mockClear();
      __emitDebugEventForTest("continued", { threadId: 7 });
      await new Promise((r) => setTimeout(r, 30));
      expect(calls("debug_continue")).toHaveLength(0);
    } finally {
      setSuspendAll(true);
    }
  });
});
