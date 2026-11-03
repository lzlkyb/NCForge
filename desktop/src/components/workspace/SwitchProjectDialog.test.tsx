// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwitchProjectDialog } from "./SwitchProjectDialog";
import { getDirectSwitch, setDirectSwitch } from "../../lib/projectSwitchPref";
import type { LinkedProject } from "../../lib/linkedProjects";

// 退场动画会把回调推迟到 MOTION.exit 之后；单测不验动画，直接走「减少动效」分支
vi.mock("../../hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => true,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TO: LinkedProject = {
  name: "lib",
  root: "C:\\w\\lib",
  origin: "classpath",
  depth: 1,
  exported: false,
  classDirs: [],
  disabled: false,
  hasClasspath: true,
};

let root: Root;
let container: HTMLDivElement;
const onCancel = vi.fn();
const onConfirm = vi.fn();

const render = async (open: boolean) => {
  await act(async () =>
    root.render(
      <SwitchProjectDialog
        open={open}
        from="C:\\w\\newar"
        to={TO}
        unsavedCount={2}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    ),
  );
};

const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  setDirectSwitch(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("跨工程切换确认框", () => {
  it("说清代价：关标签、未保存数、索引重建时间、之后的作用范围", async () => {
    await render(true);
    const text = document.body.textContent ?? "";
    expect(text).toContain("切换到 lib？");
    expect(text).toContain("会关闭当前全部标签");
    expect(text).toContain("2 个有未保存的修改");
    expect(text).toContain("3–8 秒");
    expect(text).toContain(".classpath");
    expect(text).toContain("只作用于 lib");
  });

  it("默认不勾「直接切换」，勾选后确认才写入偏好", async () => {
    await render(true);
    const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(false);
    expect(getDirectSwitch()).toBe(false);

    await act(async () => box.click());
    expect(box.checked).toBe(true);
    // 只是勾上还没确认：偏好不该提前落盘
    expect(getDirectSwitch()).toBe(false);

    await act(async () => button("切换并打开")!.click());
    expect(getDirectSwitch()).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("取消不留下副作用（勾了也不记）", async () => {
    await render(true);
    const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => box.click());
    await act(async () => button("取消")!.click());

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(getDirectSwitch()).toBe(false);
  });
});
