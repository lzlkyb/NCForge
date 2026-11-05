// @vitest-environment jsdom
/**
 * 换工作区走系统文件夹选择器：工具栏按钮不再展开手填输入框。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeHeader } from "./TreeHeader";

const h = vi.hoisted(() => ({ pickFolder: vi.fn() }));
vi.mock("../../lib/folderPicker", () => ({
  pickFolder: h.pickFolder,
  pickFolderError: (e: unknown) => `无法打开文件夹选择框：${String(e)}`,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  h.pickFolder.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async () => {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

function render(onOpen: (path: string) => void) {
  act(() => root.render(
    <TreeHeader
      root={"C:\\w\\newar"}
      recents={[]}
      onOpen={onOpen}
      onOpenRecent={noop}
      onCreateFile={noop}
      onCreateDir={noop}
      onSearch={noop}
    />,
  ));
}

const folderButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="更换工作区目录"]')!;

describe("TreeHeader 换目录", () => {
  it("点按钮拉起选择器，从当前目录开始，选中后切过去", async () => {
    h.pickFolder.mockResolvedValueOnce("D:\\w\\other");
    const onOpen = vi.fn();
    render(onOpen);

    // 不再有时间就地展开的手填输入框
    expect(document.querySelector("input")).toBeNull();
    await act(async () => { folderButton().click(); });
    await flush();

    expect(h.pickFolder).toHaveBeenCalledWith({
      title: "更换工作区目录",
      defaultPath: "C:\\w\\newar",
    });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("D:\\w\\other");
  });

  it("取消选择不切换，也不报错", async () => {
    h.pickFolder.mockResolvedValueOnce(null);
    const onOpen = vi.fn();
    render(onOpen);

    await act(async () => { folderButton().click(); });
    await flush();

    expect(onOpen).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("选择器失败时在标题下留原因", async () => {
    h.pickFolder.mockRejectedValueOnce(new Error("boom"));
    render(vi.fn());

    await act(async () => { folderButton().click(); });
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("无法打开文件夹选择框");
  });
});
