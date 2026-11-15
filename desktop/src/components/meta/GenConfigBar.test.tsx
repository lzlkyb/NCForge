// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generationFixture } from "../../test/generationWorkbenchFixture";
import { Button } from "../ui/button";
import { GenConfigBar } from "./GenConfigBar";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const props = {
  profile: generationFixture("D:/workspace").plan.profile, root: "D:/workspace", component: "demo",
  disabled: false, updating: false, dirty: false, checkError: null,
  onChange: vi.fn(), onRoot: vi.fn(), onPick: vi.fn(), onGenerate: vi.fn(),
};
const blurDirectory = () => act(() => host.querySelector("#gen-output-root")!
  .dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

it("目录已核对后离开输入框，第一次写入点击不被重复检查禁用", () => {
  const check = vi.fn(), write = vi.fn();
  function ReadyGeneration() {
    const [checking, setChecking] = useState(false);
    return <><GenConfigBar {...props} checked checking={checking} onCheck={() => { check(); setChecking(true); }} />
      <Button disabled={checking} onClick={write}>检查并确认写入</Button></>;
  }
  act(() => root.render(<ReadyGeneration />));
  blurDirectory();
  act(() => [...host.querySelectorAll("button")].find(button => button.textContent === "检查并确认写入")!.click());
  expect(write).toHaveBeenCalledTimes(1);
  expect(check).not.toHaveBeenCalled();
});

it("未核对的新目录仍在失焦时检查，进行中的检查不被失焦重启", () => {
  const check = vi.fn();
  act(() => root.render(<GenConfigBar {...props} checked={false} checking={false} onCheck={check} />));
  blurDirectory();
  expect(check).toHaveBeenCalledTimes(1);
  act(() => root.render(<GenConfigBar {...props} checked={false} checking onCheck={check} />));
  blurDirectory();
  expect(check).toHaveBeenCalledTimes(1);
});

it("已核对目录的 Enter 和重新检查仍能主动核对磁盘变化", () => {
  const check = vi.fn();
  act(() => root.render(<GenConfigBar {...props} checked checking={false} onCheck={check} />));
  act(() => host.querySelector("#gen-output-root")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  act(() => [...host.querySelectorAll("button")].find(button => button.textContent === "重新检查")!.click());
  expect(check).toHaveBeenCalledTimes(2);
});
