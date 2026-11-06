import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  setModelMarkers: vi.fn(),
  models: new Map<string, unknown>(),
  session: {
    tabs: [] as { path: string; dirty?: boolean; eolChanged?: boolean }[],
    compileResult: null as unknown,
  },
  sessionListeners: [] as (() => void)[],
  diagListeners: [] as (() => void)[],
  diags: [] as unknown[],
  openListener: null as null | (() => void),
}));

vi.mock("./monacoSetup", () => ({
  monaco: {
    MarkerSeverity: { Error: 8, Warning: 4 },
    editor: { setModelMarkers: h.setModelMarkers },
  },
}));
vi.mock("./editorStore", () => ({
  forEachModel: (cb: (path: string, model: unknown) => void) =>
    h.models.forEach((model, path) => cb(path, model)),
  onModelLifecycle: (open: () => void) => {
    h.openListener = open;
    return () => {};
  },
}));
vi.mock("./workspaceSession", () => ({
  getSession: () => h.session,
  subscribe: (cb: () => void) => {
    h.sessionListeners.push(cb);
    return () => {};
  },
}));
vi.mock("./diagStore", () => ({
  getCodeDiags: () => h.diags,
  subscribeCodeDiags: (cb: () => void) => {
    h.diagListeners.push(cb);
    return () => {};
  },
}));

const load = async () => {
  vi.resetModules();
  return import("./compileMarkers");
};

const model = (lines = 10) => ({
  getLineCount: () => lines,
  getLineMaxColumn: () => 40,
});

beforeEach(() => {
  h.setModelMarkers.mockClear();
  h.models.clear();
  h.session = { tabs: [], compileResult: null };
  h.sessionListeners.length = 0;
  h.diagListeners.length = 0;
  h.diags = [];
  h.openListener = null;
});

describe("ecjProblemsFor", () => {
  it("只保留该文件，并按路径/行/原文与 jdt.ls 去重", async () => {
    const { ecjProblemsFor } = await load();
    const problems = [
      { severity: "error" as const, file: "C:\\w\\A.java", line: 2, message: "找不到符号" },
      { severity: "warning" as const, file: "C:\\w\\A.java", line: 3, message: "未使用" },
      { severity: "error" as const, file: "C:\\w\\B.java", line: 2, message: "x" },
    ];
    const inspect = [
      { path: "c:\\w\\a.java", line: 3, column: 1, severity: "warning" as const, message: "未使用" },
    ];
    expect(ecjProblemsFor("C:/w/A.java", problems, inspect)).toEqual([problems[0]]);
  });
});

describe("initCompileMarkers", () => {
  it("只给没有未保存改动的文件写 ecj 标记，编辑后立即清掉", async () => {
    const a = model();
    const b = model();
    h.models.set("C:\\w\\A.java", a);
    h.models.set("C:\\w\\B.java", b);
    h.session.compileResult = {
      problems: [
        { severity: "error", file: "C:\\w\\A.java", line: 2, message: "xa" },
        { severity: "warning", file: "C:\\w\\B.java", line: 5, message: "xb" },
      ],
    };
    h.session.tabs = [{ path: "C:\\w\\A.java", dirty: true }];
    const { initCompileMarkers } = await load();
    initCompileMarkers();

    expect(h.setModelMarkers).toHaveBeenCalledWith(a, "ecj", []);
    expect(h.setModelMarkers).toHaveBeenCalledWith(b, "ecj", [
      expect.objectContaining({ source: "ecj", startLineNumber: 5, severity: 4, message: "xb" }),
    ]);

    // 保存后（dirty 清掉）重新画；再进入编辑立刻清空
    h.setModelMarkers.mockClear();
    h.session.tabs = [{ path: "C:\\w\\A.java", dirty: false }];
    h.sessionListeners.forEach((l) => l());
    expect(h.setModelMarkers).toHaveBeenCalledWith(a, "ecj", [
      expect.objectContaining({ startLineNumber: 2, severity: 8, message: "xa" }),
    ]);

    h.setModelMarkers.mockClear();
    h.session.tabs = [{ path: "C:\\w\\A.java", dirty: true }];
    h.sessionListeners.forEach((l) => l());
    expect(h.setModelMarkers).toHaveBeenCalledWith(a, "ecj", []);
  });

  it("jdt.ls 已报同位置同原文时不重复画，诊断变化后重算", async () => {
    const b = model();
    h.models.set("C:\\w\\B.java", b);
    h.session.compileResult = {
      problems: [{ severity: "warning", file: "C:\\w\\B.java", line: 5, message: "xb" }],
    };
    const { initCompileMarkers } = await load();
    initCompileMarkers();
    expect(h.setModelMarkers).toHaveBeenCalledWith(b, "ecj", [expect.objectContaining({ startLineNumber: 5 })]);

    h.setModelMarkers.mockClear();
    h.diags = [{ path: "C:\\w\\B.java", line: 5, column: 1, severity: "warning", message: "xb" }];
    h.diagListeners.forEach((l) => l());
    expect(h.setModelMarkers).toHaveBeenCalledWith(b, "ecj", []);
  });

  it("编译结果清空后把已有标记一并清掉", async () => {
    const a = model();
    h.models.set("C:\\w\\A.java", a);
    h.session.compileResult = {
      problems: [{ severity: "error", file: "C:\\w\\A.java", line: 1, message: "x" }],
    };
    const { initCompileMarkers } = await load();
    initCompileMarkers();
    h.setModelMarkers.mockClear();
    h.session.compileResult = null;
    h.sessionListeners.forEach((l) => l());
    expect(h.setModelMarkers).toHaveBeenCalledWith(a, "ecj", []);
  });

  it("编译结果已在、之后才打开的文件也会补画", async () => {
    h.session.compileResult = {
      problems: [{ severity: "error", file: "C:\\w\\A.java", line: 2, message: "x" }],
    };
    const { initCompileMarkers } = await load();
    initCompileMarkers();
    const a = model();
    h.models.set("C:\\w\\A.java", a);
    h.openListener!();
    expect(h.setModelMarkers).toHaveBeenCalledWith(a, "ecj", [
      expect.objectContaining({ startLineNumber: 2 }),
    ]);
  });

  it("行号超出 model 行数时夹到最后一行", async () => {
    const a = model(3);
    h.models.set("C:\\w\\A.java", a);
    h.session.compileResult = {
      problems: [{ severity: "error", file: "C:\\w\\A.java", line: 99, message: "x" }],
    };
    const { initCompileMarkers } = await load();
    initCompileMarkers();
    expect(h.setModelMarkers).toHaveBeenCalledWith(a, "ecj", [
      expect.objectContaining({ startLineNumber: 3, endLineNumber: 3 }),
    ]);
  });
});
