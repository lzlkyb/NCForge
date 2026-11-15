// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDocumentSymbols } from "./useDocumentSymbols";
import type { FlatSymbol } from "../lib/symbols";

const h = vi.hoisted(() => ({ remote: vi.fn(), local: [] as FlatSymbol[], state: "ready", localPath: null as string | null }));
vi.mock("../lib/lang", () => ({ useLangView: () => ({ state: h.state }), inLangModule: () => true }));
vi.mock("../lib/symbols", () => ({ symbolsFor: h.remote }));
vi.mock("./useLocalOutline", () => ({ useLocalOutline: (path: string | null) => { h.localPath = path; return h.local; } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const symbol = (name: string) => ({ name, kind: 6, line: 2, column: 3, startLine: 2, endLine: 3, depth: 1, container: "A" });
function Harness({ path, dirty }: { path: string; dirty: boolean }) {
  const result = useDocumentSymbols(path, 1, dirty);
  return <div>{result.symbols.map(s => s.name).join(",")}</div>;
}
beforeEach(() => { h.remote.mockReset(); h.state = "ready"; h.local = [symbol("edited")]; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
it("未保存 Java 和 NC 声明只走本地解析", async () => {
  await act(async () => root.render(<Harness path="C:/w/A.java" dirty />));
  expect(host.textContent).toBe("edited"); expect(h.remote).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness path="C:/w/A.upm" dirty={false} />));
  expect(h.localPath).toBe("C:/w/A.upm"); expect(h.remote).not.toHaveBeenCalled();
});
it("代码智能失败保留本地结果", async () => {
  h.remote.mockRejectedValue(new Error("offline"));
  await act(async () => root.render(<Harness path="C:/w/A.java" dirty={false} />));
  expect(host.textContent).toBe("edited");
});
it("切文件后的迟到远程结果不能覆盖当前文件", async () => {
  let resolve!: (symbols: FlatSymbol[]) => void;
  h.remote.mockImplementationOnce(() => new Promise<FlatSymbol[]>(r => { resolve = r; })).mockResolvedValueOnce([symbol("B")]);
  await act(async () => root.render(<Harness path="C:/w/A.java" dirty={false} />));
  await act(async () => root.render(<Harness path="C:/w/B.java" dirty={false} />));
  await act(async () => resolve([symbol("STALE_A")]));
  expect(host.textContent).toBe("B");
  await act(async () => root.render(<Harness path="C:/w/B.java" dirty />));
  expect(host.textContent).toBe("edited");
});
