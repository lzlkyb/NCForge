// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { BuildRawLog } from "./BuildRawLog";
import { BuildOutputView } from "./BuildOutputView";
import type { CompileResult } from "../../lib/compile";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("5000 raw log rows render a bounded visible window and reachable source links", async () => {
  const open = vi.fn();
  const log = Array.from({ length: 5000 }, (_, index) => `line ${index}`); log[4999] = "gl/src/A.java:42: error: missing symbol";
  await act(async () => root.render(<BuildRawLog log={log} root="D:/p" onOpenAt={open} />));
  expect(host.querySelectorAll(".dw-build-log-line").length).toBeLessThan(40);
  const link = host.querySelector<HTMLButtonElement>(".wb-log-link")!; expect(link).not.toBeNull();
  await act(async () => link.click());
  expect(open).toHaveBeenCalledWith(expect.stringMatching(/gl[\\/]src[\\/]A.java$/), 42);
});
it("new log lines keep the user's reading position while capped rows preserve a remaining anchor", async () => {
  let log = Array.from({ length: 200 }, (_, index) => `line ${index}`);
  const render = () => act(async () => root.render(<BuildRawLog log={log} root="D:/p" onOpenAt={() => {}} />));
  await render(); const viewport = host.querySelector<HTMLElement>(".dw-build-raw")!;
  Object.defineProperties(viewport, { clientHeight: { configurable: true, value: 220 }, scrollHeight: { configurable: true, get: () => log.length * 22 } });
  await act(async () => { viewport.scrollTop = 50 * 22; viewport.dispatchEvent(new Event("scroll")); });
  log = [...log, "new line"]; await render(); expect(viewport.scrollTop).toBe(50 * 22);
  log = log.slice(10); await render(); expect(viewport.scrollTop).toBe(40 * 22);
  expect(host.querySelectorAll(".dw-build-log-line").length).toBeLessThan(40);
});
it("structured failures remain distinct from raw logs and problem actions keep their source routing", async () => {
  const problem = { file: "D:/p/gl/A.java", line: 7, severity: "error" as const, message: "broken" };
  const result: CompileResult = { ok: false, errorCount: 1, warningCount: 0, sourceCount: 1, durationMs: 2, jarCount: 0, rounds: 1, outDir: "classes", problems: [problem], diagnostics: [] };
  const open = vi.fn();
  await act(async () => root.render(<BuildOutputView root="D:/p" activePath={null} log={["raw output"]} result={result} onOpenProblem={open} onOpenAt={() => {}} />));
  expect(host.querySelector('[aria-label="模块构建摘要"]')?.textContent).toContain("编译未通过");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".dw-build-nav button")].find(button => button.textContent?.startsWith("问题定位"))!.click());
  await act(async () => host.querySelector<HTMLButtonElement>(".dw-build-problem")!.click());
  expect(open).toHaveBeenCalledWith(problem);
  const raw = host.querySelector('[aria-label="原始编译日志"]')!;
  expect(raw.hasAttribute("hidden")).toBe(true);
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".dw-build-nav button")].find(button => button.textContent?.startsWith("原始输出"))!.click());
  expect(raw.hasAttribute("hidden")).toBe(false);
});
