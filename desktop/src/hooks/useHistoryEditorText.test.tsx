// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHistoryEditorText } from "./useHistoryEditorText";

// 🔴 model 后到位必须重订阅：打开历史面板时目标 model 常常还没建好，
// 只 `getModel(path)?.onDidChangeContent` 会成了空订阅，deps 只有 [path, enabled]
// ⇒ 之后 model 建好也不重挂，历史对比静默退化成「与磁盘对比」。
const h = vi.hoisted(() => ({
  models: new Map<string, { onDidChangeContent: (l: () => void) => { dispose: () => void } }>(),
  texts: new Map<string, string>(),
  open: new Set<(p: string) => void>(),
  close: new Set<(p: string) => void>(),
  disposed: 0,
}));
vi.mock("../lib/editorStore", () => ({
  getModel: (p: string) => h.models.get(p),
  getText: (p: string) => h.texts.get(p),
  onModelLifecycle: (onOpen: (p: string) => void, onClose: (p: string) => void) => {
    h.open.add(onOpen); h.close.add(onClose);
    return () => { h.open.delete(onOpen); h.close.delete(onClose); };
  },
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "C:\\w\\A.java";
let seen: string | undefined, root: Root, host: HTMLDivElement;
function Harness({ enabled = true }: { enabled?: boolean }) {
  seen = useHistoryEditorText(PATH, enabled);
  return null;
}
/** 造一个「后到位」的 model，并记录订阅是否真的挂上。 */
function putModel(text: string) {
  let listener: (() => void) | undefined;
  h.models.set(PATH, {
    onDidChangeContent: l => { listener = l; return { dispose: () => { h.disposed++; listener = undefined; } }; },
  });
  h.texts.set(PATH, text);
  return { edit: (next: string) => { h.texts.set(PATH, next); listener?.(); }, attached: () => listener !== undefined };
}
beforeEach(() => {
  vi.clearAllMocks(); h.models.clear(); h.texts.clear(); h.open.clear(); h.close.clear(); h.disposed = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("model 后到位时重订阅，编辑内容能反映到历史对比", () => {
  act(() => root.render(<Harness />));
  expect(seen).toBeUndefined();
  let model!: ReturnType<typeof putModel>;
  act(() => { model = putModel("class A {}"); h.open.forEach(f => f(PATH)); });
  expect(model.attached()).toBe(true);
  expect(seen).toBe("class A {}");
  act(() => model.edit("class A { int x; }"));
  expect(seen).toBe("class A { int x; }");
});

it("model 已存在时照常订阅，卸载时释放", () => {
  const model = putModel("first");
  act(() => root.render(<Harness />));
  expect(seen).toBe("first");
  act(() => model.edit("second"));
  expect(seen).toBe("second");
  act(() => root.unmount());
  expect(h.disposed).toBeGreaterThan(0);
  expect(h.open.size).toBe(0);
  root = createRoot(host);
});

it("model 关闭后清空文本，别的文件变化不触发重订阅", () => {
  const model = putModel("live");
  act(() => root.render(<Harness />));
  expect(seen).toBe("live");
  const before = h.disposed;
  act(() => { h.open.forEach(f => f("C:\\w\\Other.java")); });
  expect(h.disposed).toBe(before);
  h.texts.delete(PATH);
  act(() => { h.close.forEach(f => f(PATH)); });
  expect(seen).toBeUndefined();
  expect(model.attached()).toBe(false);
});

it("enabled=false 时不订阅也不读文本", () => {
  putModel("ignored");
  act(() => root.render(<Harness enabled={false} />));
  expect(seen).toBeUndefined();
  expect(h.open.size).toBe(0);
});