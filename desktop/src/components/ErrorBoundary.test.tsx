// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("../lib/frontendLog", () => ({ recordFrontendError: h.record }));

import { ErrorBoundary } from "./ErrorBoundary";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let consoleSpy: ReturnType<typeof vi.spyOn>;
// React 19 dev 会把捕获到的错误再抛给 window，jsdom 默认把整条堆栈打到 stderr。
// 这里吞掉默认打印（不改断言），否则 4 条用例刷出几百行噪音、真失败反而看不见。
const swallow = (e: Event) => e.preventDefault();

/**
 * 渲染即抛，模拟子组件在渲染生命周期里崩掉。
 * 返回类型必须显式写成 ReactElement：只 throw 的函数推断为 `never`，
 * tsc 会报 TS2786「cannot be used as a JSX component」。
 */
function Boom({ label }: { label: string }): ReactElement {
  throw new Error(label);
}

beforeEach(() => {
  h.record.mockReset();
  // React 会把捕获到的错误再 console.error 一次，测试里压掉噪音但保留调用记录
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  window.addEventListener("error", swallow);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  window.removeEventListener("error", swallow);
  host.remove();
  consoleSpy.mockRestore();
});

it("🔴 渲染崩溃必须落盘，不能只 console.error", () => {
  // 旧行为：componentDidCatch 只 console.error ⇒ 用户点一次「重新加载」现场就没了。
  // 这条钉住「崩溃有持久记录」，删掉 recordFrontendError 调用必须变红。
  act(() => {
    root.render(
      <ErrorBoundary resetKey="db">
        <Boom label="结果页炸了" />
      </ErrorBoundary>,
    );
  });
  expect(h.record).toHaveBeenCalledTimes(1);
  const [kind, payload, page] = h.record.mock.calls[0];
  expect(kind).toBe("render");
  expect(payload.message).toBe("结果页炸了");
  // resetKey 就是当前工作面 id，落盘要带上，否则不知道是哪个页崩的
  expect(page).toBe("db");
});

it("落盘的堆栈要含组件栈，不只是 error.stack", () => {
  act(() => {
    root.render(
      <ErrorBoundary resetKey="editor">
        <Boom label="编辑器炸了" />
      </ErrorBoundary>,
    );
  });
  const payload = h.record.mock.calls[0][1] as { stack?: string };
  expect(payload.stack).toContain("编辑器炸了");
  // 🔴 别断言 "Boom"：error.stack 自己就含 `at Boom`，去掉 componentStack 照样绿
  // （2026-11-16 红灯实测 exit=0）。componentStack 的独特标记是**边界组件名**
  // ——error.stack 里只有 react-dom 内部帧（renderWithHooks/beginWork…），没有它。
  expect(payload.stack).toContain("at ErrorBoundary");
});

it("崩溃后仍显示可恢复的占位页（落盘不能替代兜底 UI）", () => {
  act(() => {
    root.render(
      <ErrorBoundary resetKey="db">
        <Boom label="占位页检查" />
      </ErrorBoundary>,
    );
  });
  expect(host.textContent).toContain("应用遇到错误");
  expect(host.textContent).toContain("重新加载");
  expect(host.textContent).toContain("复制错误信息");
});

it("resetKey 变化后清掉崩溃态，不连累别的工作面", () => {
  act(() => {
    root.render(
      <ErrorBoundary resetKey="db">
        <Boom label="只在 db 面崩" />
      </ErrorBoundary>,
    );
  });
  expect(host.textContent).toContain("应用遇到错误");
  act(() => {
    root.render(
      <ErrorBoundary resetKey="editor">
        <div>编辑器正常</div>
      </ErrorBoundary>,
    );
  });
  expect(host.textContent).toContain("编辑器正常");
  expect(host.textContent).not.toContain("应用遇到错误");
});