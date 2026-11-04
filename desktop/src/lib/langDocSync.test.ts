import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
  text: "class Demo {}",
  changed: undefined as (() => void) | undefined,
  onOpen: undefined as ((path: string, model: unknown) => void) | undefined,
  onClose: undefined as ((path: string) => void) | undefined,
  model: {
    getValue: () => h.text,
    onDidChangeContent: (callback: () => void) => {
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
  onModelLifecycle: (open: typeof h.onOpen, close: typeof h.onClose) => { h.onOpen = open; h.onClose = close; }, openVirtualModel: vi.fn(),
}));
vi.mock("./tauri", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
  listen: async (event: string, callback: (payload: unknown) => void) => { h.handlers.set(event, callback); },
}));
vi.mock("./appConfig", () => ({ getConfig: async () => ({ lang_enabled: true, lang_auto_start: true }) }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: "C:\\ws" }) }));
vi.mock("./diagStore", () => ({ setCodeDiags: vi.fn() }));

function defaultInvoke(command: string) {
  return Promise.resolve(command === "lang_status"
    ? { state: "ready", module: "gl", message: "", sourceFiles: 1, jarCount: 1 }
    : undefined);
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function tick() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function change(text: string) { h.text = text; h.changed?.(); }
function notifications(method: string) {
  return h.invoke.mock.calls.filter(([cmd, args]) => cmd === "lang_notify" && args.method === method);
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.handlers.clear();
  h.text = "class Demo {}";
  h.changed = undefined;
  h.onOpen = h.onClose = undefined;
  h.invoke.mockReset();
  h.invoke.mockImplementation(defaultInvoke);
});
afterEach(() => {
  h.handlers.get("lang-status")?.({ state: "stopped", module: null, message: "", sourceFiles: 0, jarCount: 0 });
  vi.useRealTimers();
});

describe("补全前等待文档同步", () => {
  it("刚就绪时必须等 didOpen 写完，不能按磁盘旧文本请求补全", async () => {
    const open = deferred();
    h.invoke.mockImplementation((cmd) => cmd === "lang_notify" ? open.promise : defaultInvoke(cmd));
    const lang = await import("./lang");
    await lang.initLang();
    let finished = false;
    const flushing = lang.flushDoc(PATH).then(() => { finished = true; });
    await tick();
    expect(finished).toBe(false);
    open.resolve();
    await flushing;
    expect(notifications("textDocument/didOpen")).toHaveLength(1);
  });

  it("防抖已经发出的 didChange 还在途，后续补全仍须等待", async () => {
    const lang = await import("./lang");
    await lang.initLang();
    await tick();
    const changing = deferred();
    h.invoke.mockImplementation((cmd, args) => args?.method === "textDocument/didChange" ? changing.promise : defaultInvoke(cmd));
    change("class Demo { Arr }");
    await vi.advanceTimersByTimeAsync(150);
    let finished = false;
    const flushing = lang.flushDoc(PATH).then(() => { finished = true; });
    await tick();
    expect(finished).toBe(false);
    changing.resolve();
    await flushing;
    expect(notifications("textDocument/didChange")).toHaveLength(1);
  });

  it("连续输入按版本串行发送，前一个 IPC 未完成时不抢发下一个", async () => {
    const lang = await import("./lang");
    await lang.initLang();
    await tick();
    const first = deferred();
    h.invoke.mockImplementationOnce(() => first.promise);
    change("class Demo { A }");
    const p1 = lang.flushDoc(PATH);
    await tick();
    change("class Demo { ArrayL }");
    const p2 = lang.flushDoc(PATH);
    await tick();
    expect(notifications("textDocument/didChange")).toHaveLength(1);
    first.resolve();
    await Promise.all([p1, p2]);
    const changes = notifications("textDocument/didChange").map(([, args]) => args.params);
    expect(changes.map(p => p.textDocument.version)).toEqual([2, 3]);
    expect(changes[1].contentChanges[0].text).toBe(h.text);
  });

  it("同步失败不能伪装成功，下一次请求重发完整最新文本", async () => {
    const lang = await import("./lang");
    await lang.initLang();
    await tick();
    h.invoke.mockRejectedValueOnce(new Error("sync failed"));
    change("class Demo { ArrayL }");
    await expect(lang.flushDoc(PATH)).rejects.toThrow("sync failed");
    await lang.flushDoc(PATH);
    expect(notifications("textDocument/didChange")).toHaveLength(2);
  });
  it("关闭后立即重开同一路径，先等旧通知和 didClose，再发送新的 didOpen", async () => {
    const open = deferred();
    h.invoke.mockImplementationOnce(defaultInvoke);
    h.invoke.mockImplementation((cmd) => cmd === "lang_notify" ? open.promise : defaultInvoke(cmd));
    const lang = await import("./lang");
    await lang.initLang();
    await tick();
    h.onClose?.(PATH);
    h.onOpen?.(PATH, h.model);
    await tick();
    expect(notifications("textDocument/didOpen")).toHaveLength(1);
    open.resolve();
    await lang.flushDoc(PATH);
    expect(h.invoke.mock.calls.filter(([cmd]) => cmd === "lang_notify").map(([, args]) => args.method)).toEqual([
      "textDocument/didOpen", "textDocument/didClose", "textDocument/didOpen",
    ]);
  });
  it("停止并重启后，旧文档队列不会把旧版本发进新会话", async () => {
    const lang = await import("./lang"); await lang.initLang(); await tick();
    const first = deferred(); h.invoke.mockImplementationOnce(() => first.promise);
    change("class Demo { A }"); const p1 = lang.flushDoc(PATH); await tick();
    change("class Demo { Old }"); const p2 = lang.flushDoc(PATH); await tick();
    h.handlers.get("lang-status")?.({ state: "stopped", module: null, message: "", sourceFiles: 0, jarCount: 0 });
    h.text = "class Demo { Fresh }";
    h.handlers.get("lang-status")?.({ state: "ready", module: "gl", message: "", sourceFiles: 1, jarCount: 1 });
    first.resolve(); await Promise.all([p1, p2]); await lang.flushDoc(PATH);
    expect(notifications("textDocument/didChange")).toHaveLength(1);
    const opened = notifications("textDocument/didOpen");
    expect(opened[opened.length - 1]?.[1].params.textDocument.text).toBe(h.text);
  });
});
