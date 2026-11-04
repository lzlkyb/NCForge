// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResultFile } from "./ResultFile";
import type { ResultFileGroup } from "../../lib/searchResults";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const onOpen = vi.fn(), onToggle = vi.fn();
const path = `modules/${"VeryLongFileName".repeat(10)}.java`;
const group = (): ResultFileGroup => ({
  key: path, path, projectRoot: "D:\\project",
  hits: [{ path, line: 42, text: `${"x".repeat(160)}billSave();${"y".repeat(100)}`, ranges: [{ start: 160, end: 168 }] }],
});
const render = async (data: ResultFileGroup, collapsed = false) =>
  act(async () => root.render(<ResultFile group={data} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />));

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("结果文件组", () => {
  it("展示第一命中短上下文，打开时仍传原始行和 UTF-16 定位范围", async () => {
    const data = group(); await render(data);
    const buttons = container.querySelectorAll("button");
    expect(container.querySelector("mark")?.textContent).toBe("billSave");
    expect(buttons[1].textContent).not.toContain("x".repeat(100));
    expect(buttons[1].title).toContain(data.hits[0].text);
    await act(async () => buttons[1].click());
    expect(onOpen).toHaveBeenCalledWith(data.hits[0]);
    expect(onOpen.mock.calls[0][0].ranges[0].start).toBe(160);
  });

  it("长标题允许缩窄并可查看完整路径，折叠状态对辅助技术可见", async () => {
    const data = group(); await render(data, true);
    const header = container.querySelector("button")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.title).toBe(`D:\\project\\${path.replace(/\//g, "\\")}`);
    expect(header.querySelector(".font-semibold")?.classList.contains("truncate")).toBe(true);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await act(async () => header.click()); expect(onToggle).toHaveBeenCalledOnce();
    await render(data); expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it.each([{ ranges: [] }, { ranges: [{ start: 320, end: 328 }] }])("后端预览丢失范围时明确提示打开完整行，保留原始 hit", async ({ ranges }) => {
    const data = group(); data.hits[0] = { path, line: 42, text: `${"x".repeat(300)}…`, ranges };
    await render(data);
    expect(container.textContent).toContain("预览未包含匹配位置，打开完整行查看");
    expect(container.querySelector("mark")).toBeNull();
    await act(async () => container.querySelectorAll("button")[1].click());
    expect(onOpen).toHaveBeenCalledWith(data.hits[0]);
  });
});
