// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceLogPage, ServiceLogTarget } from "../lib/serviceConsoleApi";

const mocks = vi.hoisted(() => {
  interface Call {
    kind: "tail" | "read"; target: ServiceLogTarget; previous: boolean; offset?: number; fileId?: string;
    resolve: (page: ServiceLogPage) => void; reject: (error: Error) => void;
  }
  const calls: Call[] = [];
  const request = (kind: Call["kind"], target: ServiceLogTarget, previous: boolean, offset?: number, fileId?: string) =>
    new Promise<ServiceLogPage>((resolve, reject) => { calls.push({ kind, target, previous, offset, fileId, resolve, reject }); });
  return {
    calls,
    tail: vi.fn((target: ServiceLogTarget, previous: boolean, before?: number, fileId?: string) => request("tail", target, previous, before, fileId)),
    read: vi.fn((target: ServiceLogTarget, previous: boolean, offset: number, fileId?: string) => request("read", target, previous, offset, fileId)),
    clear: vi.fn(), cleared: vi.fn(), toast: vi.fn(),
  };
});
vi.mock("../lib/serviceConsoleApi", () => ({ serviceLogTail: mocks.tail, serviceLogRead: mocks.read, serviceLogClear: mocks.clear, serviceLogExport: vi.fn(), serviceLogExportText: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));

import { useServerLog, type ServiceLogOptions } from "./useServerLog";
import { useServiceLogActions } from "./useServiceLogActions";

interface Props { hidden?: boolean; options: ServiceLogOptions; }
let reader: ReturnType<typeof useServerLog>;
let actions: ReturnType<typeof useServiceLogActions>;
function Probe({ hidden = false, options }: Props) {
  reader = useServerLog(true, 0, hidden, undefined, options);
  actions = useServiceLogActions({ target: options.target, previous: options.previous, fileId: reader.fileId, reset: reader.reset, onCleared: mocks.cleared });
  return null;
}
let root: Root;
let client: QueryClient;
let options: ServiceLogOptions;
let sequence = 0;
const page = (patch: Partial<ServiceLogPage> = {}): ServiceLogPage => ({ text: "", startOffset: 0, offset: 0, fileId: "file-a", size: 0, eof: true, reset: false, truncated: false, lineOffsets: [0], ...patch });
const texts = () => reader.lines.map(line => line.text);
const render = async (props: Partial<Props> = {}) => {
  await act(async () => { root.render(<QueryClientProvider client={client}><Probe options={options} {...props} /></QueryClientProvider>); });
};
const settle = async (index: number, result: ServiceLogPage) => { await act(async () => { mocks.calls[index].resolve(result); }); };
const retry = async () => { await act(async () => { reader.retry(); }); };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.calls.length = 0;
  options = { target: "middleware", previous: false, runId: "run-a", projectRoot: `D:/log-pages-${++sequence}` };
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => { act(() => root.unmount()); client.clear(); document.body.innerHTML = ""; vi.useRealTimers(); });

describe("生产控制台日志分段读取", () => {
  it("先 tail 再按文件身份续读，跨块中文半行保留原始字节位置", async () => {
    await render();
    expect(mocks.tail).toHaveBeenCalledWith("middleware", false);
    await settle(0, page({ text: "首行\n中", startOffset: 100, offset: 110, size: 110, lineOffsets: [100, 107] }));
    await retry();
    expect(mocks.read).toHaveBeenLastCalledWith("middleware", false, 110, "file-a");
    await settle(1, page({ text: "文\n下一行\n半", startOffset: 110, offset: 127, size: 127, lineOffsets: [110, 114, 124] }));
    expect(texts()).toEqual(["首行", "中文", "下一行"]);
    expect(reader.lines.map(line => line.offset)).toEqual([100, 107, 114]);
    await retry();
    await settle(2, page({ text: "行\n", startOffset: 127, offset: 131, size: 131, lineOffsets: [127, 131] }));
    expect(texts()).toEqual(["首行", "中文", "下一行", "半行"]);
    expect(reader.lines.map(line => line.offset)).toEqual([100, 107, 114, 124]);
    expect(reader.endOffset).toBe(131);
  });

  it("fileId 轮转时丢弃 reset 响应内容，重新 tail 后只续读新文件", async () => {
    await render();
    await settle(0, page({ text: "old\n", offset: 4, size: 4, lineOffsets: [0, 4] }));
    await retry();
    await settle(1, page({ text: "stale\n", offset: 6, size: 6, fileId: "file-b", reset: true, lineOffsets: [0, 6] }));
    expect(mocks.calls[2].kind).toBe("tail");
    expect(texts()).toEqual(["old"]);
    await settle(2, page({ text: "new\n", offset: 4, size: 4, fileId: "file-b", lineOffsets: [0, 4] }));
    expect(texts()).toEqual(["new"]);
    await retry();
    expect(mocks.read).toHaveBeenLastCalledWith("middleware", false, 4, "file-b");
    await settle(3, page({ startOffset: 4, offset: 4, size: 4, fileId: "file-b", lineOffsets: [4] }));
  });

  it("隐藏时不读取，显示后恢复；上次运行只读取一次并补齐末尾半行", async () => {
    await render({ hidden: true });
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(mocks.calls).toHaveLength(0);
    await render();
    await settle(0, page({ text: "live\n", offset: 5, size: 5, lineOffsets: [0, 5] }));
    await render({ hidden: true });
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(mocks.calls).toHaveLength(1);
    await render({ options: { ...options, previous: true } });
    expect(mocks.tail).toHaveBeenLastCalledWith("middleware", true);
    await settle(1, page({ text: "archived", startOffset: 100, offset: 108, size: 108, lineOffsets: [100] }));
    expect(texts()).toEqual(["archived"]);
    expect(reader.lines[0].terminated).toBe(false);
    expect(reader.lines[0].offset).toBe(100);
    expect(reader.startOffset).toBe(100);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(mocks.calls).toHaveLength(2);
  });

  it("readOlder 按当前字节位置读取，失败保留已加载历史，回到最新恢复实时日志", async () => {
    await render();
    await settle(0, page({ text: "live\n", startOffset: 100, offset: 105, size: 105, lineOffsets: [100, 105] }));
    act(() => { void reader.readOlder(); });
    expect(mocks.tail).toHaveBeenLastCalledWith("middleware", false, 100, "file-a");
    await settle(1, page({ text: "older", startOffset: 95, offset: 100, size: 105, lineOffsets: [95] }));
    expect(texts()).toEqual(["older"]);
    expect(reader.startOffset).toBe(95);
    expect(reader.endOffset).toBe(100);
    expect(reader.lines[0].offset).toBe(95);
    expect(reader.lines[0].terminated).toBe(false);
    act(() => { void reader.readOlder(); });
    await act(async () => { mocks.calls[2].reject(new Error("history read failed")); });
    expect(texts()).toEqual(["older"]);
    expect(reader.historical).toBe(true);
    expect(reader.error).toContain("history read failed");
    expect(reader.readingOlder).toBe(false);
    act(() => { reader.showLatest(); });
    expect(texts()).toEqual(["live"]);
    expect(reader.startOffset).toBe(100);
    expect(reader.endOffset).toBe(105);
  });

  it("清屏失败保留日志和 offset，释放忙状态且不通知已清屏", async () => {
    await render();
    await settle(0, page({ text: "keep\n", offset: 5, size: 5, lineOffsets: [0, 5] }));
    mocks.clear.mockRejectedValueOnce(new Error("clear denied"));
    await act(async () => { actions.clear(); });
    expect(texts()).toEqual(["keep"]);
    expect(reader.endOffset).toBe(5);
    expect(actions.busy).toBeNull();
    expect(mocks.cleared).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("清屏失败：Error: clear denied", "error");
  });

  it("切工程时丢弃在途旧响应并补拉新工程，offset 从新 tail 开始", async () => {
    await render();
    await render({ options: { ...options, projectRoot: "D:/another-project" } });
    expect(mocks.calls).toHaveLength(1);
    await settle(0, page({ text: "old project\n", offset: 12, size: 12, lineOffsets: [0, 12] }));
    expect(texts()).toEqual([]);
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[1].kind).toBe("tail");
    await settle(1, page({ text: "new project\n", startOffset: 20, offset: 32, size: 32, fileId: "new-project-file", lineOffsets: [20, 32] }));
    expect(texts()).toEqual(["new project"]);
    await retry();
    expect(mocks.read).toHaveBeenLastCalledWith("middleware", false, 32, "new-project-file");
    await settle(2, page({ startOffset: 32, offset: 32, size: 32, fileId: "new-project-file", lineOffsets: [32] }));
  });
});
