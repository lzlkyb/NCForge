// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { TransferFrame, TransferSource, TransferRetry } from "../../lib/resultTransferContext";
import type { TransferFileReq } from "../../lib/dbTransferApi";
import type { TransferJob } from "../../lib/resultTransferJobs";
import type { ContextMenuItem } from "../workspace/ContextMenu";

const mocks = vi.hoisted(() => ({
  jobs: new Map<string, TransferJob>(), listeners: new Set<() => void>(),
  start: vi.fn<(source: TransferSource, request: Omit<TransferFileReq, "exportId">, summary: string, retry?:TransferRetry) => Promise<void>>(),
  copy: vi.fn(), pick: vi.fn(), stop: vi.fn(),
}));
vi.mock("../../lib/resultTransferJobs", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    transferJobKey: (source: TransferSource) => `${source.connId}:${source.resultId}`,
    useTransferJob: (key: string) => React.useSyncExternalStore(listener => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; }, () => mocks.jobs.get(key) ?? null),
    startTransferJob: mocks.start, stopTransferJob: mocks.stop,
    clearTransferJob: (key: string) => { mocks.jobs.delete(key); mocks.listeners.forEach(listener => listener()); },
  };
});
vi.mock("../../lib/dbTransferApi", () => ({ dbTransferApi: { pick: mocks.pick, open: vi.fn() } }));
vi.mock("../../lib/resultTransferClipboard", () => ({ copyTransfer: mocks.copy }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
vi.mock("../ui/Modal", () => ({ Modal: ({ open, children, ariaLabel }: { open: boolean; children: ReactNode; ariaLabel: string }) => open ? <div role="dialog" aria-label={ariaLabel}>{children}</div> : null }));
vi.mock("./InsertExportDialog", () => ({ InsertExportDialog: () => null }));
vi.mock("../workspace/ContextMenu", () => ({ ContextMenu: ({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) => <div role="menu">{items.map((item, i) => <button key={i} role="menuitem" disabled={item.disabled} onClick={() => { onClose(); item.onSelect(); }}>{item.label}</button>)}</div> }));
import { ResultTransfer } from "./ResultTransfer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, frame: TransferFrame;
const key = "conn-a:result-a";
function originalFrame(): TransferFrame {
  return { data: { columns: ["ID", "NOTE", "VALUE"].map(name => ({ name, type: "VARCHAR2", precision: 0, scale: 0 })), rows: [["0001", "old-a", "A"], ["0002", "old-b", "B"]] },
    order: [1, 0], visible: [2, 0, 1], selection: { anchor: { r: 1, c: 2 }, end: { r: 0, c: 0 } }, labels: ["编号", "说明", "值"],
    source: { connId: "conn-a", resultId: "result-a", tabId: "tab-a", sql: "select * from T where ID = ?", params: [{ number: "12345678901234567890" }], source: "来源A", complete: false, table: "T" } };
}
function render() { root.render(<ResultTransfer frame={frame} valueAt={(r, c) => c === 1 ? `edited-${r}` : frame.data.rows[r][c]} />); }
function dialog(label = "导出查询结果"): HTMLElement {
  const node = host.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`); expect(node).not.toBeNull(); return node!;
}
function button(label: string, parent: ParentNode = host): HTMLButtonElement {
  const node = [...parent.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  expect(node, `Missing button: ${label}`).toBeDefined(); return node!;
}
async function click(label: string, parent: ParentNode = host) { await act(async () => { button(label, parent).click(); }); }
function choose(label: string, value: string, parent: ParentNode) {
  const input = parent.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`); expect(input).not.toBeNull();
  act(() => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(input, value); input!.dispatchEvent(new Event("change", { bubbles: true })); });
}
function nullText(value: string, parent: ParentNode) {
  const input = [...parent.querySelectorAll<HTMLSelectElement>("select")].find(select => select.closest("label")?.textContent?.startsWith("NULL 表示")); expect(input).toBeDefined();
  act(() => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(input, value); input!.dispatchEvent(new Event("change", { bubbles: true })); });
}
function delimiter(value: string, parent: ParentNode) {
  const input = parent.querySelector<HTMLSelectElement>('select[aria-label="分隔符"]'); expect(input).not.toBeNull();
  act(() => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(input, value); input!.dispatchEvent(new Event("change", { bubbles: true })); });
}
function toggleColumn(name: string, parent: ParentNode) {
  const row = [...parent.querySelectorAll<HTMLElement>(".dbx-transfer-col")].find(item => item.querySelector("code")?.textContent === name); expect(row).toBeDefined();
  act(() => { row!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
}
async function advancedCopy() { await click("复制为"); await click("高级复制…"); }

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.jobs.clear(); mocks.listeners.clear();
  mocks.copy.mockResolvedValue(false); mocks.pick.mockResolvedValue({ token: "grant-original", path: "D:/exports/original.csv" });
  mocks.start.mockImplementation(async (_source, _request, summary, retry) => {
    mocks.jobs.set(key, { state: "running", operationId: 1, exportId: 11, startedAt: 0, summary,
      retry, progress: { id: "conn-a", exportId: 11, rows: 0, bytes: 0, elapsedMs: 0, rowsPerSec: 0, bytesPerSec: 0, phase: "writing" } });
    mocks.listeners.forEach(listener => listener());
  });
  frame = originalFrame(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(render);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("复制与导出独立快照", () => {
  it.each([true, false])("快捷复制显示真实行列数，换格式保留范围（选区：%s）", async selected => {
    if (!selected) { frame.selection = null; frame.order = [1]; frame.visible = [2, 0]; act(render); }
    const rows = selected ? 2 : 1, label = selected ? "复制选区" : "复制当前结果";
    const primary = host.querySelector<HTMLButtonElement>(".dbx-transfer-split > button")!;
    expect(primary.textContent).toBe(`${label} ${rows} × 2`);
    expect(primary.getAttribute("aria-label")).toBe(`${label} ${rows} 行 × 2 列`);
    for (const format of ["CSV", "JSON"]) {
      await click("复制为");
      expect(host.querySelector('[role="menuitem"]')?.textContent).toBe(`${selected ? "选区" : "当前筛选结果"} ${rows} 行 × 2 列`);
      await click(format);
      const [data, options] = mocks.copy.mock.calls[mocks.copy.mock.calls.length - 1];
      expect(data.rows).toEqual(selected ? [["0002", "edited-1", "B"], ["0001", "edited-0", "A"]] : [["0002", "edited-1", "B"]]);
      expect(options.columnIndices).toEqual([2, 0]);
      expect(options.format).toBe(format.toLowerCase());
      expect(primary.textContent).toBe(`${label} ${rows} × 2`);
    }
  });
  it.each(["cancelling", "finalizing"] as const)("后台文件任务处于 %s 时仍能独立复制", async phase => {
    await click("导出"); await click("保存文件", dialog());
    const job = mocks.jobs.get(key)!;
    act(() => {
      mocks.jobs.set(key, { ...job, state: phase === "cancelling" ? "cancelling" : "running", progress: { ...job.progress, phase: phase === "finalizing" ? "finalizing" : "writing" } });
      mocks.listeners.forEach(listener => listener());
    });
    await advancedCopy();
    const copyDialog = dialog("高级复制");
    expect(button("复制", copyDialog).disabled).toBe(false);
    mocks.copy.mockResolvedValue(true);
    await click("复制", copyDialog);
    expect(mocks.copy).toHaveBeenCalledTimes(1);
  });
  it("结果组件卸载再返回时从全局任务恢复原SQL、选区和保存位置，不拿新页面冒充重试",async()=>{
    await click("导出");choose("输出格式","csv",dialog());delimiter(";",dialog());nullText("\\N",dialog());
    await click("选择位置",dialog());await click("保存文件",dialog());const [source,request]=mocks.start.mock.calls[0];
    act(()=>root.unmount());
    frame.data.rows[1][2]="新页面值";frame.source.sql="select * from NEW_PAGE";frame.source.params=["later"];
    frame.selection=null;const job=mocks.jobs.get(key)!;mocks.jobs.set(key,{...job,state:"failed",error:"disk full"});
    root=createRoot(host);act(render);await click("查看导出任务");expect(dialog().textContent).toContain("来源A");
    await click("修改设置并重试",dialog());expect(dialog().querySelector<HTMLInputElement>('[aria-label="保存位置"]')!.value).toBe("D:/exports/original.csv");
    await click("保存文件",dialog());const [retrySource,retryRequest]=mocks.start.mock.calls[1];
    expect(retrySource).toEqual(source);expect(retryRequest).toEqual(request);expect(retrySource.sql).toBe("select * from T where ID = ?");
  });
  it("文件后台运行后打开复制，再查看失败任务并重试，仍使用原快照、选列、参数和保存授权", async () => {
    await click("导出");
    choose("输出格式", "csv", dialog()); delimiter(";", dialog()); nullText("\\N", dialog());
    choose("输出值来源", "edited", dialog());
    toggleColumn("ID", dialog());
    await click("选择位置", dialog()); await click("保存文件", dialog());
    expect(mocks.start).toHaveBeenCalledTimes(1);
    const [firstSource, firstRequest] = mocks.start.mock.calls[0];
    expect(firstRequest).toMatchObject({ format: "csv", fileName: "original.csv", destinationToken: "grant-original", options: { columnIndices: [2], delimiter: ";", nullText: "\\N" }, data: { rows: [["0002", "edited-1", "B"], ["0001", "edited-0", "A"]] } });
    await click("后台运行", dialog());
    frame.data.rows[0][2] = "later-value"; frame.source.sql = "select * from OTHER_TABLE"; frame.source.source = "稍后来源";
    (frame.source.params![0] as { number: string }).number = "later-binding";
    frame.selection = { anchor: { r: 0, c: 1 }, end: { r: 0, c: 1 } };
    act(render); await advancedCopy();
    expect(dialog("高级复制").textContent).toContain("稍后来源");
    choose("输出格式", "json", dialog("高级复制")); await click("关闭", dialog("高级复制"));
    act(() => { const running = mocks.jobs.get(key)!; mocks.jobs.set(key, { ...running, state: "failed", error: "disk is full" }); mocks.listeners.forEach(listener => listener()); });
    await click("查看导出任务"); expect(dialog().textContent).toContain("来源A"); expect(dialog().textContent).toContain("disk is full");
    await click("修改设置并重试", dialog());
    expect(dialog().querySelector<HTMLSelectElement>('[aria-label="输出格式"]')!.value).toBe("csv");
    expect(dialog().querySelector<HTMLInputElement>('[aria-label="保存位置"]')!.value).toBe("D:/exports/original.csv");
    await click("保存文件", dialog()); expect(mocks.start).toHaveBeenCalledTimes(2);
    const [retrySource, retryRequest] = mocks.start.mock.calls[1];
    expect(retrySource).toEqual(firstSource); expect(retryRequest).toEqual(firstRequest);
    expect(retrySource.sql).toBe("select * from T where ID = ?"); expect(retrySource.params).toEqual([{ number: "12345678901234567890" }]);
  });

  it("复制失败转文件保留CSV、字段、NULL、分隔符、转置、值来源及旧来源快照", async () => {
    await advancedCopy();
    choose("输出格式", "csv", dialog("高级复制")); delimiter(";", dialog("高级复制")); nullText("\\N", dialog("高级复制"));
    choose("输出值来源", "edited", dialog("高级复制")); toggleColumn("ID", dialog("高级复制"));
    const transpose = [...dialog("高级复制").querySelectorAll<HTMLLabelElement>("label")].find(label => label.textContent?.includes("转置行列"))!.querySelector<HTMLInputElement>("input")!;
    act(() => transpose.click()); await click("复制", dialog("高级复制"));
    expect(dialog("高级复制").textContent).toContain("设置已保留");
    const [copyData, copyOptions, copySource] = mocks.copy.mock.calls[0];
    frame.data.rows[1][2] = "later-value"; frame.source.sql = "select * from OTHER_TABLE"; frame.selection = null; act(render);
    await click("改为文件导出", dialog("高级复制"));
    expect(host.querySelector('[role="dialog"][aria-label="高级复制"]')).toBeNull();
    expect(dialog().querySelector<HTMLSelectElement>('[aria-label="输出格式"]')!.value).toBe("csv");
    expect(dialog().querySelector<HTMLSelectElement>('[aria-label="输出值来源"]')!.value).toBe("edited");
    await click("保存文件", dialog()); expect(mocks.start).toHaveBeenCalledTimes(1);
    const [fileSource, fileRequest] = mocks.start.mock.calls[0];
    expect(fileRequest.options).toEqual(copyOptions); expect(fileRequest.data).toEqual(copyData); expect(fileSource).toEqual(copySource);
    expect(fileRequest.options).toMatchObject({ format: "csv", columnIndices: [2], delimiter: ";", nullText: "\\N", transpose: true });
    expect(fileRequest.sql).toBe("select * from T where ID = ?"); expect(fileRequest.data!.rows[0][2]).toBe("B");
  });
});
