import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 轻量化方案第一批 ③④：已同步文档不再拷整篇、jar 内类正文缓存有上限。
// mock 写法与 langDocSync.test.ts 一致。
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
  text: "class Demo {}",
  reads: 0,
  changed: undefined as ((e?: unknown) => void) | undefined,
  model: {
    getValue: () => { h.reads++; return h.text; },
    onDidChangeContent: (callback: (e?: unknown) => void) => {
      h.changed = callback;
      return { dispose: vi.fn() };
    },
  },
}));
const PATH = "C:\\ws\\gl\\Demo.java";

vi.mock("./monacoSetup", () => ({ monaco: {
  editor: { removeAllMarkers: vi.fn(), setModelMarkers: vi.fn() }, MarkerSeverity: {},
} }));
vi.mock("./editorStore", () => ({
  forEachModel: (callback: (path: string, model: unknown) => void) => callback(PATH, h.model),
  onModelLifecycle: vi.fn(), openVirtualModel: vi.fn(),
}));
vi.mock("./tauri", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
  listen: async (event: string, callback: (payload: unknown) => void) => { h.handlers.set(event, callback); },
}));
vi.mock("./appConfig", () => ({ getConfig: async () => ({ lang_enabled: true, lang_auto_start: true }) }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: "C:\\ws" }) }));
vi.mock("./diagStore", () => ({ setCodeDiags: vi.fn() }));

/** 每个类 1 MiB 正文（UTF-16 计 2 MiB），不是桩，不走反编译。 */
const BIG = "x".repeat(1024 * 1024);
function defaultInvoke(command: string, args?: { method?: string; params?: { uri?: string } }) {
  if (command === "lang_status") return Promise.resolve({ state: "ready", module: "gl", message: "", sourceFiles: 1, jarCount: 1 });
  if (command === "lang_request" && args?.method === "java/classFileContents") return Promise.resolve(`// ${args.params?.uri}\n${BIG}`);
  return Promise.resolve(undefined);
}
function calls(method: string) {
  return h.invoke.mock.calls.filter(([, args]) => args?.method === method);
}

beforeEach(() => {
  vi.resetModules();
  h.handlers.clear();
  h.text = "class Demo {}";
  h.reads = 0;
  h.changed = undefined;
  h.invoke.mockReset();
  h.invoke.mockImplementation(defaultInvoke);
});
afterEach(() => {
  h.handlers.get("lang-status")?.({ state: "stopped", module: null, message: "", sourceFiles: 0, jarCount: 0 });
});

describe("文档同步快速路径", () => {
  it("已同步的版本反复 flushDoc 不再读整篇、不再发通知；有新改动照常发", async () => {
    const lang = await import("./lang");
    await lang.initLang();
    await lang.flushDoc(PATH);
    const reads = h.reads;
    const opens = calls("textDocument/didOpen").length;
    expect(opens).toBe(1);
    for (let i = 0; i < 50; i++) await lang.flushDoc(PATH);
    expect(h.reads).toBe(reads);
    expect(calls("textDocument/didChange")).toHaveLength(0);

    h.text = "class Demo { int a; }";
    h.changed?.();
    await lang.flushDoc(PATH);
    expect(calls("textDocument/didChange")).toHaveLength(1);
    expect(h.reads).toBe(reads + 1);
  });
});

/** 模拟 Monaco 一次局部改动事件：在第 line 行（1 起）第 col 列插入 text。 */
function insert(line: number, col: number, text: string) {
  h.changed?.({ isFlush: false, changes: [{ range: { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col }, rangeLength: 0, text }] });
}
function lastChange() {
  const all = calls("textDocument/didChange");
  return all[all.length - 1]?.[1].params;
}

describe("文档增量同步", () => {
  it("有明细的改动只发增量、不读全文；没明细的退回全文", async () => {
    const lang = await import("./lang");
    await lang.initLang();
    await lang.flushDoc(PATH);
    const reads = h.reads;

    insert(1, 13, " int a;");
    insert(1, 20, " int b;");
    await lang.flushDoc(PATH);
    const p = lastChange();
    expect(p.textDocument.version).toBe(3);
    expect(p.contentChanges).toEqual([
      { range: { start: { line: 0, character: 12 }, end: { line: 0, character: 12 } }, rangeLength: 0, text: " int a;" },
      { range: { start: { line: 0, character: 19 }, end: { line: 0, character: 19 } }, rangeLength: 0, text: " int b;" },
    ]);
    expect(h.reads).toBe(reads);

    // 事件没带明细（或整篇替换）：发全文
    h.text = "class Demo { int c; }";
    h.changed?.({ isFlush: true, changes: [] });
    await lang.flushDoc(PATH);
    expect(lastChange().contentChanges).toEqual([{ text: "class Demo { int c; }" }]);

    // 全文之后又能接着发增量
    insert(1, 21, "x");
    await lang.flushDoc(PATH);
    expect(lastChange().contentChanges[0].text).toBe("x");
  });

  it("增量发送失败后，下一次按最新内容发全文，不接断掉的增量", async () => {
    const lang = await import("./lang");
    await lang.initLang();
    await lang.flushDoc(PATH);
    h.invoke.mockImplementationOnce(() => Promise.reject(new Error("管道断了")));
    insert(1, 13, " int a;");
    await expect(lang.flushDoc(PATH)).rejects.toThrow("管道断了");

    h.text = "class Demo { int a; int b; }";
    insert(1, 20, " int b;");
    await lang.flushDoc(PATH);
    const p = lastChange();
    expect(p.contentChanges).toEqual([{ text: "class Demo { int a; int b; }" }]);
    expect(p.textDocument.version).toBe(3);
  });
});

describe("jar 内类正文缓存", () => {
  it("单条正文超过预算仍能打开，但不保留在缓存中", async () => {
    const lang = await import("./lang");
    const text = "x".repeat(lang.JDT_CACHE_MAX_BYTES / 2 + 1);
    h.invoke.mockResolvedValue(text);
    expect((await lang.loadJdtSource("jdt://Oversized")).text).toBe(text);
    expect(lang.jdtCacheStats()).toEqual({ entries: 0, bytes: 0 });
    await lang.loadJdtSource("jdt://Oversized");
    expect(calls("java/classFileContents")).toHaveLength(2);
  });

  it("超过字节上限按最近使用淘汰，刚用过的留下", async () => {
    const lang = await import("./lang");
    // 每条约 2 MiB，32 MiB 最多留 15 条左右
    for (let i = 0; i < 20; i++) {
      await lang.loadJdtSource(`jdt://C${i}`);
      // 反复访问 C0，它始终是「最近使用」的一端
      await lang.loadJdtSource("jdt://C0");
    }
    const s = lang.jdtCacheStats();
    expect(s.bytes).toBeLessThanOrEqual(lang.JDT_CACHE_MAX_BYTES);
    expect(s.entries).toBeLessThan(20);

    const before = calls("java/classFileContents").length;
    await lang.loadJdtSource("jdt://C0");
    expect(calls("java/classFileContents").length).toBe(before); // 命中缓存
    await lang.loadJdtSource("jdt://C1");
    expect(calls("java/classFileContents").length).toBe(before + 1); // 已被淘汰，重新问
  });

  it("换工作区后旧正文整体作废", async () => {
    const lang = await import("./lang");
    const epoch = await import("./workspaceEpoch");
    await lang.loadJdtSource("jdt://A");
    const before = calls("java/classFileContents").length;
    epoch.invalidateWorkspaceRequests();
    await lang.loadJdtSource("jdt://A");
    expect(calls("java/classFileContents").length).toBe(before + 1);
    expect(lang.jdtCacheStats().entries).toBe(1);
  });
});
