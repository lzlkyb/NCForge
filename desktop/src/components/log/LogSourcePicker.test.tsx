// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogSourcePicker } from "./LogSourcePicker";
import type { LoggerGroup } from "../../lib/ncLog";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const groups: LoggerGroup[] = ["nc", "warningsql", "metadata", "pfxx", "audit", "security", "plugin"].map((name, index) => ({
  name, files: [], newestMs: index, totalSize: 0, level: "INFO",
}));
let root: Root;
let host: HTMLDivElement;
function Picker({ initial = [] }: { initial?: string[] }) {
  const [selected, setSelected] = useState(initial);
  return <LogSourcePicker groups={groups} loggers={selected} onToggle={name => setSelected(current => current.includes(name)
    ? current.filter(value => value !== name) : [...current, name])} onClear={() => setSelected([])} />;
}
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const chip = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>(".lg-chip")).find(button => button.textContent?.startsWith(name))!;
const click = (button: HTMLButtonElement) => act(() => button.click());
const type = (text: string) => act(() => {
  const input = document.querySelector<HTMLInputElement>('[aria-label="搜索日志来源"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("日志来源分层选择", () => {
  it("只展示四个常用来源，搜索更多来源可多选，关闭后保留搜索草稿", () => {
    act(() => root.render(<Picker />));
    expect(Array.from(host.querySelectorAll(".lg-chip")).map(button => button.textContent)).toEqual([
      "全部7", "nc0", "warningsql0", "metadata0", "pfxx0", "更多来源",
    ]);
    click(chip("更多来源"));
    type("secur");
    const selected = document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
    expect(selected.textContent).toContain("security");
    click(selected);
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(chip("security").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    const done = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent === "完成")!;
    click(done);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    click(chip("更多来源"));
    expect(document.querySelector<HTMLInputElement>('[aria-label="搜索日志来源"]')?.value).toBe("secur");
    click(chip("全部"));
    expect(host.querySelector('.lg-chip[aria-pressed="true"]')?.textContent).toBe("全部7");
  });
  it("已选的非常用与配置中缺失来源均保留可见且能取消", () => {
    act(() => root.render(<Picker initial={["plugin", "missing"]} />));
    expect(chip("plugin").getAttribute("aria-pressed")).toBe("true");
    expect(chip("missing").getAttribute("aria-pressed")).toBe("true");
    click(chip("missing"));
    expect(host.textContent).not.toContain("missing");
    expect(chip("plugin").getAttribute("aria-pressed")).toBe("true");
  });
  it("从搜索框方向键进入筛选项，Esc 关闭后焦点返回更多来源", () => {
    act(() => root.render(<Picker />));
    const trigger = chip("更多来源");
    click(trigger);
    type("audit");
    const input = document.querySelector<HTMLInputElement>('[aria-label="搜索日志来源"]')!;
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toContain("audit");
    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
