// @vitest-environment jsdom
/**
 * HeapField 的两条回归网（2026-10-28）：
 *
 * 1. **Enter 连按 / Enter 后马上点 ✓ 不能双保存**。禁用态只挡鼠标，挡不住键盘；
 *    两个 server_heap_set 都是合法写，后一次覆盖前一次，用户看到的生效值可能
 *    和自己刚填的数不一致——而这种错位没有任何报错，纯靠猜。
 * 2. **改过的值要有「恢复默认」入口**。传 null 回后端的能力一直在
 *    （serverHeapSet 接受 null），但界面上没有按钮点得到它，用户只能手改
 *    config.json——那是给排障留的路，不是给日常用的。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeapField } from "./HeapField";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

/** 每测一个场景重建组件：onSave 是手动兑现的 promise，用来卡住 saving 状态。 */
let resolveSave: (v: number) => void = () => {};
const onSave = vi.fn(
  () =>
    new Promise<number>((resolve) => {
      resolveSave = resolve;
    }),
);

const mount = async (heapMb = 4096, defaultHeapMb = 4096) => {
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root.render(
      <HeapField heapMb={heapMb} defaultHeapMb={defaultHeapMb} running={false} onSave={onSave} />,
    );
  });
};

const link = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
const input = () => container.querySelector("input") as HTMLInputElement;
const enter = async () => {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("HeapField", () => {
  it("编辑态 Enter 连按只保存一次", async () => {
    await mount();
    await act(async () => {
      link("修改")!.click();
    });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input(), "8192");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });

    await enter(); // 第一次：发出保存，promise 还没兑现
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(8192);

    await enter(); // 第二次：saving 中，必须被拦住
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave(8192);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("Enter 之后马上点 ✓ 也不会双保存", async () => {
    await mount();
    await act(async () => {
      link("修改")!.click();
    });
    await enter(); // draft 初始就是当前值 4096，直接回车
    expect(onSave).toHaveBeenCalledTimes(1);

    // 第一道防线：saving 期间 ✓ 是 disabled，点了不触发
    await act(async () => {
      const btns = [...container.querySelectorAll("button")];
      btns[btns.length - 2]?.click(); // ✓ 在 ✕ 前面
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    // 第二道防线：键盘不吃 disabled——submit() 开头的 saving 判断拦住它
    await enter();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("越界值不发请求（前端提前拦，后端也会拒）", async () => {
    await mount();
    await act(async () => {
      link("修改")!.click();
    });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input(), "300");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await enter();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("改过的值出现「恢复默认」，点它传 null 给后端", async () => {
    await mount(8192, 4096);
    expect(link("恢复默认")).toBeTruthy();
    await act(async () => {
      link("恢复默认")!.click();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("值就是默认时不显示「恢复默认」", async () => {
    await mount(4096, 4096);
    expect(link("恢复默认")).toBeUndefined();
    expect(link("修改")).toBeTruthy();
  });
});
