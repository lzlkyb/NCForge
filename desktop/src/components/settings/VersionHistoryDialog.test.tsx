// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChangelogEntry } from "../../lib/about";
vi.mock("../../hooks/useAppInfo", () => ({ useAppInfo: () => ({ data: { version: "1.0.0" } }) }));
vi.mock("../ui/Modal", () => ({ Modal: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null }));
import { VersionHistoryDialog } from "./VersionHistoryDialog";
const entries: ChangelogEntry[] = [
  { version: "2.0.0", date: "2026-11-05", summary: ["用户摘要"], items: Array.from({ length: 20 }, (_, index) => ({ category: index % 2 ? "fix" : "feat", text: `记录 ${index}：<script>不执行</script> 和 \`代码\`` })),
    technical: [{ heading: "技术细节", text: "private-code 使用参数 --all-targets" }] },
  { version: "1.0.0", date: "2026-10-25", items: [{ category: "feat", text: "旧版本新增" }] },
];
let host: HTMLDivElement, root: Root; const close = vi.fn();
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); close.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (data = entries) => act(() => root.render(<VersionHistoryDialog open onClose={close} entries={data} />));
const choose = (version: string) => act(() => { const select = host.querySelector("select")!; select.value = version; select.dispatchEvent(new Event("change", { bubbles: true })); });
const query = (value: string) => act(() => { const input = host.querySelector("input")!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
it("打开默认选择实际运行版本；切换后摘要优先，长记录可展开且文本不执行", () => {
  render(); expect(host.querySelector("select")?.value).toBe("1.0.0");
  choose("2.0.0"); expect(host.textContent).toContain("用户摘要"); expect(host.querySelectorAll("li")).toHaveLength(12);
  act(() => button("展开全部 20 条记录").click()); expect(host.querySelectorAll("li")).toHaveLength(20);
  expect(host.querySelector("script")).toBeNull(); expect(host.querySelector("code")?.textContent).toBe("代码");
});
it("筛选与搜索可恢复，技术匹配自动展开，关闭操作明确", () => {
  render(); choose("2.0.0"); act(() => button("修复").click()); expect(host.querySelectorAll("li")).toHaveLength(10);
  query("不存在"); expect(host.textContent).toContain("没有找到相关记录");
  act(() => button("清除筛选").click()); expect(host.querySelectorAll("li")).toHaveLength(12);
  query("private-code"); expect(host.querySelector("details")?.open).toBe(true);
  expect(host.textContent).toContain("--all-targets"); act(() => button("关闭").click()); expect(close).toHaveBeenCalledOnce();
});
it("没有随包版本时显示明确空状态", () => { render([]); expect(host.textContent).toContain("还没有随包版本记录"); expect(host.querySelector("select")).toBeNull(); });
it("Esc 清空搜索，输入法组合期间不清空", () => {
  render(); query("记录");
  act(() => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
  expect(host.querySelector("input")!.value).toBe("记录");
  act(() => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector("input")!.value).toBe(""); expect(close).not.toHaveBeenCalled();
});
