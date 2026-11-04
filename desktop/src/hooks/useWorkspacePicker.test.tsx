// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestWorkspacePicker } from "../lib/workspacePicker";
import { useWorkspacePicker } from "./useWorkspacePicker";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const applyRoot = vi.fn(async () => null);
const setDraft = vi.fn();
const setEditing = vi.fn();
function Bridge({ current = "D:\\NC65" }: { current?: string }) {
  useWorkspacePicker({ root: current, applyRoot, setDraft, setEditing });
  return null;
}
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("标题栏工作区请求", () => {
  it("文件页尚未加载时保留请求，严格模式也只执行一次原有切换流程", () => {
    requestWorkspacePicker("D:\\NC65-test");
    act(() => root.render(<StrictMode><Bridge /></StrictMode>));
    expect(applyRoot).toHaveBeenCalledExactlyOnceWith("D:\\NC65-test");
    act(() => root.render(<StrictMode><Bridge current="D:\\NC65-test" /></StrictMode>));
    expect(applyRoot).toHaveBeenCalledTimes(1);
  });
  it("打开目录选择时填入当前路径，不直接切换工程", () => {
    act(() => root.render(<Bridge />));
    act(() => requestWorkspacePicker());
    expect(setDraft).toHaveBeenCalledWith("D:\\NC65");
    expect(setEditing).toHaveBeenCalledWith(true);
    expect(applyRoot).not.toHaveBeenCalled();
  });
});
