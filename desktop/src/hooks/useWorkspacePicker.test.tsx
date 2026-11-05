// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestWorkspacePicker } from "../lib/workspacePicker";
import { useWorkspacePicker } from "./useWorkspacePicker";

const h = vi.hoisted(() => ({ pickFolder: vi.fn() }));
vi.mock("../lib/folderPicker", () => ({
  pickFolder: h.pickFolder,
  pickFolderError: (e: unknown) => String(e),
}));
vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const applyRoot = vi.fn(async () => null);
function Bridge({ current = "D:\\NC65" }: { current?: string }) {
  useWorkspacePicker({ root: current, applyRoot });
  return null;
}
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const flush = async () => {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

describe("标题栏工作区请求", () => {
  it("文件页尚未加载时保留请求，严格模式也只执行一次原有切换流程", () => {
    requestWorkspacePicker("D:\\NC65-test");
    act(() => root.render(<StrictMode><Bridge /></StrictMode>));
    expect(applyRoot).toHaveBeenCalledExactlyOnceWith("D:\\NC65-test");
    act(() => root.render(<StrictMode><Bridge current="D:\\NC65-test" /></StrictMode>));
    expect(applyRoot).toHaveBeenCalledTimes(1);
  });

  it("没有现成路径时拉起系统文件夹选择器，从当前目录开始", async () => {
    h.pickFolder.mockResolvedValue("D:\\NC65-test");
    act(() => root.render(<Bridge />));
    act(() => requestWorkspacePicker());
    await flush();
    expect(h.pickFolder).toHaveBeenCalledWith({
      title: "选择工程目录",
      defaultPath: "D:\\NC65",
    });
    expect(applyRoot).toHaveBeenCalledExactlyOnceWith("D:\\NC65-test");
  });

  it("用户取消选择时不切工程、不报错", async () => {
    h.pickFolder.mockResolvedValue(null);
    act(() => root.render(<Bridge />));
    act(() => requestWorkspacePicker());
    await flush();
    expect(h.pickFolder).toHaveBeenCalledOnce();
    expect(applyRoot).not.toHaveBeenCalled();
  });
});
