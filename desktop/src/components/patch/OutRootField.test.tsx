// @vitest-environment jsdom
/**
 * 产物根手动指定：
 * - 未指定时显示扫描实际用到的目录；
 * - 从候选里点一条并保存，必须下发 patch_set_out_root；
 * - 指定状态下有「恢复自动探测」，下发 null。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setOutRoot: vi.fn(), toast: vi.fn() }));

vi.mock("../../lib/patch", () => ({ patchSetOutRoot: mocks.setOutRoot }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));

import { OutRootField } from "./OutRootField";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const mount = async (value: string | null) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <OutRootField
          value={value}
          detected={["C:/ws/out"]}
          candidates={["C:/ws/out", "C:/ws/ic/classes"]}
        />
      </QueryClientProvider>,
    );
  });
};

const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  mocks.setOutRoot.mockReset();
  mocks.setOutRoot.mockResolvedValue(undefined);
  mocks.toast.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("OutRootField", () => {
  it("未指定时显示扫描实际用到的产物根", async () => {
    await mount(null);
    expect(container.textContent).toContain("C:/ws/out");
    expect(button("指定")).toBeTruthy();
  });

  it("点候选后保存，按选中的目录下发", async () => {
    await mount(null);
    await act(async () => button("指定")!.click());
    await act(async () => button("C:/ws/ic/classes")!.click());
    await act(async () => button("保存")!.click());

    expect(mocks.setOutRoot).toHaveBeenCalledWith("C:/ws/ic/classes");
    expect(mocks.toast).toHaveBeenCalledWith("产物根已指定，已按新目录重扫", "success");
  });

  it("指定状态下可恢复自动探测（传 null）", async () => {
    await mount("C:/eclipse/proj/out");
    expect(container.textContent).toContain("C:/eclipse/proj/out");

    await act(async () => button("更改")!.click());
    await act(async () => button("恢复自动探测")!.click());

    expect(mocks.setOutRoot).toHaveBeenCalledWith(null);
  });

  it("保存失败时保留弹窗并提示错误", async () => {
    mocks.setOutRoot.mockRejectedValue(new Error("产物根不存在：C:/nope"));
    await mount(null);
    await act(async () => button("指定")!.click());
    await act(async () => button("C:/ws/out")!.click());
    await act(async () => button("保存")!.click());

    expect(mocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("产物根不存在"),
      "error",
      // 第三参是给「复制全部错误」用的英文原文，默认视图不显示
      { raw: "产物根不存在：C:/nope" },
    );
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });
});
