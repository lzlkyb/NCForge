// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MetaViewPanel } from "./MetaViewPanel";
import { GenWriteDialogs } from "./GenWriteDialogs";
import { MetaDdlRun } from "./MetaDdlRun";
import { metaDetail } from "../../test/metaFixtures";
import { generationFixture, generationResult } from "../../test/generationWorkbenchFixture";
import type { GenerationResult } from "../../lib/bmfGeneration";

const mocks = vi.hoisted(() => ({ list: vi.fn(), exec: vi.fn() }));
vi.mock("../../lib/dbApi", () => ({ dbApi: { list: mocks.list, exec: mocks.exec }, ENV_LABEL: { test: "测试" } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  mocks.list.mockResolvedValue([{ id: "test", name: "测试库", env: "test" }]);
  mocks.exec.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const renderPanel = (busy: boolean, detail: ReturnType<typeof metaDetail> | null) => act(async () => root.render(
  <MetaViewPanel view="detail" detail={detail} busy={busy} error={null} entries={[]} onEdited={() => {}}
    editor={<textarea aria-label="编辑草稿" defaultValue="未保存内容" />} />,
));

it("首次解析只播报整个区域，骨架块均为装饰", async () => {
  await renderPanel(true, null);
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("正在解析元数据…");
  expect(host.querySelector('[role="status"]')!.closest('[aria-busy="true"]')).toBeNull();
  expect(host.querySelectorAll('.skeleton[aria-hidden="true"]').length).toBeGreaterThan(1);
});

it("刷新时保留原编辑节点及草稿，长等待出现后结束立即清理", async () => {
  const detail = metaDetail();
  await renderPanel(false, detail);
  const editor = host.querySelector<HTMLTextAreaElement>("textarea")!;
  editor.value = "正在编辑的内容";
  await renderPanel(true, detail);
  expect(host.querySelector("textarea")).toBe(editor);
  expect(host.querySelector(".meta-tool-skeleton")).toBeNull();
  expect(host.querySelector(".ui-task-feedback")?.hasAttribute("data-visible")).toBe(false);
  await act(async () => vi.advanceTimersByTime(1200));
  expect(host.querySelector(".ui-task-feedback")?.getAttribute("data-visible")).toBe("true");
  expect(host.textContent).toContain("已用 1 秒");
  // Busy content must not defer the live message until the task is already over.
  expect(host.querySelector('.ui-task-feedback [role="status"]')!.closest('[aria-busy="true"]')).toBeNull();
  await renderPanel(false, detail);
  expect(host.querySelector(".ui-task-feedback")).toBeNull();
  expect(editor.value).toBe("正在编辑的内容");
  expect(vi.getTimerCount()).toBe(0);
});

it("写入等待没有虚构百分比或取消入口，部分成功结果按真实计数呈现", async () => {
  const fixture = generationFixture("D:/workspace");
  const props = { plan: fixture.plan, statuses: Object.fromEntries(fixture.check.items.map(item => [item.id, item])),
    root: "D:/workspace", onCloseReview: vi.fn(), onConfirm: vi.fn(), onCloseResult: vi.fn(), onOpen: vi.fn(), onReveal: vi.fn() };
  await act(async () => root.render(<GenWriteDialogs {...props} review={{ snapshot: fixture.check.snapshot!, selected: ["vo"], overrides: [] }}
    result={null} resultOpen={false} applying />));
  const dialog = document.querySelector('[aria-label="确认写入生成产物"]')!;
  expect(dialog.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
  expect([...dialog.querySelectorAll("button")].some(button => button.textContent?.trim() === "取消")).toBe(false);
  expect([...dialog.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  const result: GenerationResult = { ...generationResult(props.root), written: 1, failed: 1,
    items: [...generationResult(props.root).items, { relPath: "db/demo.sql", kind: "ddl", status: "failed", detail: "目标文件不可写" }] };
  await act(async () => root.render(<GenWriteDialogs {...props} review={null} result={result} resultOpen applying={false} />));
  const outcome = document.querySelector('[aria-label="生成写入结果"]')!;
  expect(outcome.textContent).toContain("已写入 1 · 跳过 0 · 失败 1");
  expect(outcome.textContent).toContain("目标文件不可写");
  expect(outcome.textContent).toContain("成功项已保留");
  expect(outcome.querySelector(".ui-task-feedback")).toBeNull();
});

it("DDL 的进度只在数据库返回后前进，第二条失败保留第一条成功结果", async () => {
  let completeFirst!: (value: unknown) => void, failSecond!: (reason: Error) => void;
  mocks.exec.mockImplementationOnce(() => new Promise(resolve => { completeFirst = resolve; }))
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { failSecond = reject; }));
  const running = vi.fn();
  await act(async () => root.render(<MetaDdlRun ddl="create table first (id number); create table second (id number);" component="demo" onRunning={running} />));
  await act(async () => {
    const select = host.querySelector("select")!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "test");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    const typed = host.querySelector<HTMLInputElement>('[aria-label="输入组件名确认 DDL 执行"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(typed, "demo");
    typed.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "执行 DDL")!.click());
  const progress = () => host.querySelector('[role="progressbar"]');
  expect(progress()?.getAttribute("aria-valuenow")).toBe("0");
  expect(progress()?.getAttribute("aria-valuemax")).toBe("2");
  await act(async () => vi.advanceTimersByTime(3000));
  expect(progress()?.getAttribute("aria-valuenow")).toBe("0");
  await act(async () => completeFirst({ kind: "update", ms: 3, updateCount: 0 }));
  expect(progress()?.getAttribute("aria-valuenow")).toBe("1");
  await act(async () => failSecond(new Error("第二张表已存在")));
  expect(progress()).toBeNull();
  expect(host.querySelectorAll(".meta-export-result .is-written")).toHaveLength(1);
  expect(host.querySelectorAll(".meta-export-result .is-failed")).toHaveLength(1);
  expect(host.textContent).toContain("第二张表已存在");
  expect(host.textContent).not.toContain("全部语句执行成功");
  expect(mocks.exec).toHaveBeenCalledTimes(2);
  expect(running).toHaveBeenLastCalledWith(false);
});
