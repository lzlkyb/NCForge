// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { useSettingsMutation } from "./useSettingsMutation";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let mutation: ReturnType<typeof useSettingsMutation>;
let root: Root;
let host: HTMLDivElement;
function Harness() { mutation = useSettingsMutation(); return null; }
beforeEach(async () => { host = document.createElement("div"); root = createRoot(host); await act(async () => root.render(<Harness />)); });
afterEach(async () => { await act(async () => root.unmount()); });
it("不同字段串行写入，重复提交同一字段只执行一次", async () => {
  let finish!: () => void;
  const first = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const second = vi.fn(async () => {});
  let pending!: Promise<boolean>;
  await act(async () => { pending = mutation.run("first", first); });
  await act(async () => { void mutation.run("first", first); void mutation.run("second", second); });
  expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  await act(async () => { finish(); await pending; });
  expect(second).toHaveBeenCalledOnce(); expect(mutation.feedback("second").saved).toBe(true);
});
it("失败保留可重试的写入，不阻塞之后的字段", async () => {
  const job = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("磁盘只读")).mockResolvedValue(undefined);
  await act(async () => { await mutation.run("setting", job); });
  expect(mutation.feedback("setting").error).toContain("磁盘只读");
  expect(mutation.feedback("setting").saved).toBeUndefined();
  await act(async () => mutation.feedback("setting").onRetry());
  expect(job).toHaveBeenCalledTimes(2); expect(mutation.feedback("setting").saved).toBe(true);
});
