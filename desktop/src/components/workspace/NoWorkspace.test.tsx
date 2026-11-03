// @vitest-environment jsdom
/**
 * 打开工程失败时的原地提示。
 *
 * 以前失败只有一条 toast：几秒后消失，输入框里的路径还留着，用户回头看
 * 完全不知道刚才为什么没打开。这里盯住「原因留在输入框上」和「可被读屏读到」。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NoWorkspace } from "./NoWorkspace";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const onOpen = vi.fn<(path: string) => Promise<string | null>>();

beforeEach(() => onOpen.mockReset());

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const flush = async (times = 3) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <NoWorkspace
        value={"C:\\work\\newar"}
        recents={[]}
        onChange={vi.fn()}
        onOpen={onOpen}
      />,
    );
  });
  return host;
}

const openButton = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === "打开")!;

describe("NoWorkspace 打开失败提示", () => {
  it("把失败原因挂在输入框下方，并标成 aria-invalid", async () => {
    onOpen.mockResolvedValueOnce("无法打开目录：路径不存在");
    const el = render();
    await act(async () => { openButton(el).click(); });
    await flush();

    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("路径不存在");
    const input = el.querySelector("input")!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("wb-root-error");
    expect(el.querySelector("#wb-root-error")).toBe(alert);
  });

  it("打开成功时不留错误残留", async () => {
    onOpen.mockResolvedValueOnce(null);
    const el = render();
    await act(async () => { openButton(el).click(); });
    await flush();

    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelector("input")!.hasAttribute("aria-invalid")).toBe(false);
  });

  it("重试成功后错误随之消失", async () => {
    onOpen.mockResolvedValueOnce("无法打开目录：路径不存在");
    onOpen.mockResolvedValueOnce(null);
    const el = render();
    await act(async () => { openButton(el).click(); });
    await flush();
    expect(el.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => { openButton(el).click(); });
    await flush();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });
});
