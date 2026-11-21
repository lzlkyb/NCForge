// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAutoStorage, wireStorageMaintenance } from "./storageMaintenance";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), operations: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));
vi.mock("./operations", () => ({ getOperations: mocks.operations, subscribeOperations: () => () => {} }));

let stop: (() => void) | undefined;
const minute = 60_000;
const day = 24 * 60 * minute;

describe("空闲清理调度", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    localStorage.clear();
    mocks.operations.mockReturnValue([]);
    mocks.invoke.mockResolvedValue({ cancelled: false });
  });
  afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });

  it("应用启动后等待空闲，并避开正在运行的任务", async () => {
    mocks.operations.mockReturnValue([{ endedAt: undefined }]);
    stop = wireStorageMaintenance();
    await vi.advanceTimersByTimeAsync(3 * minute);
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.operations.mockReturnValue([]);
    await vi.advanceTimersByTimeAsync(minute);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("storage_idle_cleanup");
    await vi.advanceTimersByTimeAsync(day - minute);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(minute);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("尊重关闭设置并在用户恢复操作时停止回收", async () => {
    setAutoStorage(false);
    stop = wireStorageMaintenance();
    await vi.advanceTimersByTimeAsync(3 * minute);
    expect(mocks.invoke).not.toHaveBeenCalled();
    let complete!: (value: { cancelled: boolean }) => void;
    mocks.invoke.mockImplementation((cmd: string) => cmd === "storage_idle_cleanup"
      ? new Promise(resolve => { complete = resolve; }) : Promise.resolve());
    setAutoStorage(true);
    await vi.advanceTimersByTimeAsync(minute);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(mocks.invoke).toHaveBeenLastCalledWith("storage_cancel", { planId: 0 });
    complete({ cancelled: true });
    await vi.advanceTimersByTimeAsync(2 * minute);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "storage_idle_cleanup")).toHaveLength(2);
    complete({ cancelled: false });
    await Promise.resolve();
  });
});
