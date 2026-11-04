// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), kill: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/server", () => ({ serverStart: mock.start, serverStop: mock.stop, serverKillPortOwner: mock.kill }));
vi.mock("../components/ui/toast", () => ({ toast: mock.toast }));
import { useServiceCommands } from "./useServiceCommands";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, commands: ReturnType<typeof useServiceCommands>;
const refetch = vi.fn(async () => undefined), patchState = vi.fn();
function Probe() { commands = useServiceCommands({ debugMode: false, refetch, patchState, onGeneration: () => {}, onClearConfirm: () => {} }); return null; }
beforeEach(async () => {
  vi.clearAllMocks(); mock.start.mockResolvedValue(undefined); mock.stop.mockResolvedValue("stopped");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe("服务动作重复点击", () => {
  it("开始那一帧连点只启动一次，并等待原操作返回才解锁", async () => {
    let finish!: () => void; mock.start.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => { void commands.start(); void commands.start(); void commands.killOwner(); });
    expect(mock.start).toHaveBeenCalledOnce(); expect(mock.kill).not.toHaveBeenCalled(); expect(commands.busy).toBe("start");
    await act(async () => { finish(); }); expect(commands.busy).toBe(null);
    expect(mock.toast).toHaveBeenCalledWith(expect.stringContaining("等待监听端口就绪"), "success");
  });
  it("上一次启动取消中不发送第二次启动；失败后释放锁", async () => {
    mock.stop.mockResolvedValueOnce("cancelling");
    await act(async () => commands.restart()); expect(mock.start).not.toHaveBeenCalled(); expect(commands.busy).toBe(null);
    mock.start.mockRejectedValueOnce(new Error("missing java"));
    await act(async () => commands.start()); expect(commands.busy).toBe(null);
    await act(async () => commands.start()); expect(mock.start).toHaveBeenCalledTimes(2);
  });
});
