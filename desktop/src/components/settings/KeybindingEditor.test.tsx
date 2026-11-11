// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { KeybindingEditor } from "./KeybindingEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("设置页隐藏后释放按键采集，返回后不再自动采集", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const render = (hidden: boolean) => act(async () => root.render(<section hidden={hidden}><KeybindingEditor keymap="eclipse" /></section>));
    await render(false);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="修改转到文件快捷键"]')!.click());
    expect(host.querySelector('[data-capturing="true"]')).not.toBeNull();
    await render(true);
    const key = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, cancelable: true });
    await act(async () => window.dispatchEvent(key));
    expect(key.defaultPrevented).toBe(false);
    await render(false);
    expect(host.querySelector('[data-capturing="true"]')).toBeNull();
  } finally { await act(async () => root.unmount());host.remove(); }
});
