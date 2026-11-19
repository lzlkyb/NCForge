import { afterEach, expect, it, vi } from "vitest";
import { frameTask } from "./frameTask";

afterEach(() => vi.unstubAllGlobals());
it("coalesces a burst into one frame and flushes the final release position exactly once", () => {
  let callback: (() => void) | undefined;
  const request = vi.fn((fn: () => void) => { callback = fn; return 1; });
  vi.stubGlobal("requestAnimationFrame", request); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const apply = vi.fn(), task = frameTask(apply);
  for (let i = 0; i < 100; i++) task.schedule(i);
  expect(request).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled();
  callback!(); expect(apply).toHaveBeenCalledExactlyOnceWith(99);
  task.schedule(123); task.flush(); expect(apply).toHaveBeenLastCalledWith(123);
  task.flush(); expect(apply).toHaveBeenCalledTimes(2);
  task.schedule(456); task.cancel(); task.flush(); expect(apply).toHaveBeenCalledTimes(2);
});
