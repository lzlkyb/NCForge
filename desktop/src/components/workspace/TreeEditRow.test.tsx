// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TreeEditRow } from "./TreeEditRow";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = async (busy: boolean, onCancel: () => void) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <TreeEditRow
        initial="A.java"
        selectStem
        isDir={false}
        padLeft={0}
        error={null}
        busy={busy}
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    ),
  );
  // 外部点击监听是延一轮事件循环才挂的，先让这一轮过去
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

const clickOutside = () =>
  act(async () => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });

it("外部点击收起输入行", async () => {
  const onCancel = vi.fn();
  await render(false, onCancel);
  await clickOutside();
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it("新建 / 改名已经发出时不因外部点击收起输入行", async () => {
  const onCancel = vi.fn();
  await render(true, onCancel);
  // 后端没有取消通道：这时收走输入行，写操作的结果就落在用户看不见的地方
  await clickOutside();
  expect(onCancel).not.toHaveBeenCalled();
});
