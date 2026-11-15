import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  closeModel: vi.fn(),
  stopLang: vi.fn(),
  cancelJava: vi.fn(),
}));

vi.mock("./tauri", () => ({ invoke: mocks.invoke }));
vi.mock("./editorStore", () => ({
  closeModel: mocks.closeModel,
  // workspaceSession 在模块加载时就会订阅 dirty 变化，缺了它整个模块起不来
  onDirtyChange: () => () => {},
}));
vi.mock("./lang", () => ({ stopLang: mocks.stopLang }));
vi.mock("./javaRunLifecycle", () => ({ withJavaRunsStopped: async (work: () => Promise<string>) => { await mocks.cancelJava(); return work(); } }));

import { applyWorkspace } from "./switchWorkspace";
import { getSession, setSession } from "./workspaceSession";

const tab = (path: string) => ({
  path,
  name: path.split("\\").pop() ?? path,
  encoding: "UTF-8" as const,
  hasBom: false,
  eol: "LF" as const,
  mtimeMs: 1,
  dirty: false,
  eolChanged: false,
  readOnly: false,
  readOnlyReason: null,
  lines: 10,
  bytes: 320,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancelJava.mockResolvedValue(undefined);
  setSession({
    root: "C:\\old",
    tabs: [tab("C:\\old\\A.java")],
    activePath: "C:\\old\\A.java",
    compileResult: null,
    compileLog: ["旧工程的日志"],
  });
  mocks.invoke.mockImplementation(async (cmd: string) =>
    cmd === "set_workspace" ? "C:\\new" : Promise.reject(new Error(cmd)),
  );
});

describe("applyWorkspace", () => {
  it("waits for the current Java run to release its slot before changing the workspace", async () => {
    let finish!: () => void;
    mocks.cancelJava.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const switching = applyWorkspace("C:\\new");
    await Promise.resolve();
    expect(mocks.cancelJava).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(getSession().root).toBe("C:\\old");
    finish(); await switching;
    expect(mocks.invoke).toHaveBeenCalledWith("set_workspace", { path: "C:\\new" });
  });
  it("keeps the workspace when Java cancellation cannot be confirmed", async () => {
    mocks.cancelJava.mockRejectedValue(new Error("cancel failed"));
    await expect(applyWorkspace("C:\\new")).rejects.toThrow("cancel failed");
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(getSession().root).toBe("C:\\old");
  });
  it("返回后端规范化后的路径，并把会话里属于旧工作区的东西全部清掉", async () => {
    const shown = await applyWorkspace("c:\\new");

    expect(mocks.invoke).toHaveBeenCalledWith("set_workspace", { path: "c:\\new" });
    expect(shown).toBe("C:\\new");
    // 旧标签的编辑器模型必须关掉，否则 model 会一直挂到下一次打开同名文件
    expect(mocks.closeModel).toHaveBeenCalledWith("C:\\old\\A.java");
    // jdt.ls 按工作区建索引，换工作区必须重启
    expect(mocks.stopLang).toHaveBeenCalled();

    const s = getSession();
    expect(s.tabs).toEqual([]);
    expect(s.activePath).toBeNull();
    expect(s.compileLog).toEqual([]);
    // 树根跟着走：文件页是隐藏的，不会自己重读工作区
    expect(s.root).toBe("C:\\new");
  });

  it("后端拒绝时什么都不改（失败不该留下「已切一半」的状态）", async () => {
    mocks.invoke.mockImplementation(async () => {
      throw new Error("工作区目录不存在");
    });

    await expect(applyWorkspace("C:\\nope")).rejects.toThrow("工作区目录不存在");

    const s = getSession();
    expect(s.root).toBe("C:\\old");
    expect(s.tabs).toHaveLength(1);
    expect(mocks.closeModel).not.toHaveBeenCalled();
    expect(mocks.stopLang).not.toHaveBeenCalled();
  });
});
