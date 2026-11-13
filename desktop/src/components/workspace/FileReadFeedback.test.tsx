// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginOperation, type OperationHandle } from "../../lib/operations";
import { FileReadFeedback } from "./FileReadFeedback";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "C:\\w\\feedback";
const FILE = `${ROOT}\\A.java`;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = async (onOpen = vi.fn()) => {
  await act(async () => root.render(<FileReadFeedback root={ROOT} onOpen={onOpen} />));
  return onOpen;
};

const close = async () => {
  const btn = host.querySelector<HTMLButtonElement>('[aria-label="关闭读取提示"]');
  expect(btn).toBeTruthy();
  await act(async () => btn!.click());
};

const start = async () => {
  let handle!: OperationHandle;
  await act(async () => { handle = beginOperation({ key: `file.open:${FILE}`, label: "打开 A.java", path: FILE })!; });
  return handle;
};

it("读取失败时显示告警，关掉后不再打扰", async () => {
  await render();
  const handle = await start();
  await act(async () => handle.finish("failed", "文件不存在"));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("打开 A.java失败");
  await close();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("关掉「正在读」的提示后，这次读取失败仍然要冒出来", async () => {
  await render();
  vi.useFakeTimers();
  const handle = await start();
  // 300ms 后才算「值得占一行」，先让它可见
  await act(async () => vi.advanceTimersByTime(400));
  expect(host.querySelector('[role="status"]')).toBeTruthy();
  await close();
  expect(host.textContent).toBe("");
  // 用户关掉的是转圈，不是失败：失败要重新出现，否则他永远不知道这次读挂了
  await act(async () => handle.finish("failed", "文件不存在"));
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
});
