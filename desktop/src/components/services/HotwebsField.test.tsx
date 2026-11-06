// @vitest-environment jsdom
/**
 * HotwebsField 的回归网：默认名单必须与 Eclipse 一致（全挂会把 ncchr 这类插件
 * webapp 也拉起来，它的 Spring 版本冲突会让整个上下文启动失败），同时用户必须
 * 能看见并改这份名单——「悄悄只挂 5 个」和「悄悄全挂」一样不可接受。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), onSave: vi.fn() }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
// 弹窗用 usePresence 做进场动画；测试里直接关掉动效，挂载是同步的
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));

import { HotwebsField } from "./HotwebsField";
import type { HotwebsInfo } from "../../lib/server";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALL = ["eyeapp", "fs", "iwebap", "lfw", "ncchr", "nccloud", "portal", "uapws"];
const DEFAULT = ["nccloud", "uapws", "lfw", "portal", "fs"];

function info(configured: string[] | null = null): HotwebsInfo {
  return {
    all: ALL,
    active: configured ?? [...DEFAULT].sort(),
    default: DEFAULT,
    configured,
  };
}

let host: HTMLDivElement;
let root: Root;

const button = (text: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;

const click = async (el: HTMLElement | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.click();
  });
};

const openDialog = () => click(button("选择"));
const check = (name: string) => {
  const item = [...document.body.querySelectorAll(".sv-hw-item")].find((el) =>
    el.querySelector(".sv-hw-name")?.textContent?.includes(name),
  );
  expect(item, `找不到 ${name} 的勾选项`).toBeTruthy();
  return item!.querySelector("input[type=checkbox]") as HTMLInputElement;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onSave.mockImplementation(async (v: string[] | null) => info(v));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const mount = async (data: HotwebsInfo | null = info(), error: string | null = null) => {
  await act(async () => {
    root.render(<HotwebsField info={data} error={error} running={false} onSave={mocks.onSave} />);
  });
};

describe("HotwebsField", () => {
  it("默认态只显示 5 个，候选里标出默认项", async () => {
    await mount();
    expect(host.textContent).toContain("5 个");
    expect(host.textContent).toContain("与 Eclipse 一致");

    await openDialog();
    expect(document.body.querySelectorAll(".sv-hw-item")).toHaveLength(ALL.length);
    expect(document.body.querySelectorAll(".sv-hw-badge")).toHaveLength(DEFAULT.length);
  });

  it("取消一个默认项后保存显式名单", async () => {
    await mount();
    await openDialog();
    await click(check("lfw"));
    await click(button("保存"));

    expect(mocks.onSave).toHaveBeenCalledTimes(1);
    expect(mocks.onSave).toHaveBeenCalledWith(["fs", "nccloud", "portal", "uapws"]);
  });

  it("勾上额外 webapp 后保存包含它的名单", async () => {
    await mount();
    await openDialog();
    await click(check("ncchr"));
    await click(button("保存"));

    expect(mocks.onSave).toHaveBeenCalledWith(
      expect.arrayContaining(["ncchr", "nccloud", "uapws", "lfw", "portal", "fs"]),
    );
    expect((mocks.onSave.mock.calls[0][0] as string[]).length).toBe(6);
  });

  it("恢复默认后保存 null（不落一份等于默认的显式表）", async () => {
    await mount(info(["ncchr", "nccloud"]));
    await openDialog();
    await click(button("恢复默认"));
    await click(button("保存"));

    expect(mocks.onSave).toHaveBeenCalledWith(null);
  });

  it("一个都不勾时不能保存", async () => {
    await mount();
    await openDialog();
    for (const name of ALL) {
      const box = check(name);
      if (box.checked) await click(box);
    }
    expect(button("保存")!.disabled).toBe(true);
    expect(mocks.onSave).not.toHaveBeenCalled();
  });
});
