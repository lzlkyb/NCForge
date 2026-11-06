// @vitest-environment jsdom
/**
 * A3：排序口径的界面接线。
 *
 * ① 一旦真的排序 / 筛选，结果条上必须出现「仅作用于已取的 N 行」——不能只靠 hover
 *    提示，用户看到「点了升序」就走了；没排序时不占这条横带。
 * ② 表头右键能「重排并重查」，回调带的是**列下标 + 方向**，由父组件去包 SQL。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ColumnMeta } from "../../lib/dbApi";
import { ResultTable } from "./ResultTable";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
(HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const columns: ColumnMeta[] = [
  { name: "NAME", type: "VARCHAR2(20)", precision: 20, scale: 0 },
  { name: "ID", type: "NUMBER", precision: 10, scale: 0 },
];

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

it("结果工具菜单保留快照、比较和关联，完整 SQL 可展开读取",async()=>{
  const onRelated=vi.fn();
  const rows=[["a",1]],snapshot={source:"测试库 / 表 T",sql:"select * from T",at:1,complete:false,columns,rows};
  act(()=>{root=createRoot(host);root.render(<ResultTable columns={columns} rows={rows} meta="1 行" table="T" snapshot={snapshot} onRelated={onRelated} />);});
  const tools=host.querySelector<HTMLButtonElement>('[aria-label="结果工具"]')!;
  const openTools=()=>act(()=>tools.click());
  const item=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b=>b.textContent===name)!;
  openTools();expect(item("关联记录").disabled).toBe(true);
  await act(async()=>item("固定为对照").click());
  openTools();expect(item("更新对照")).toBeTruthy();
  await act(async()=>item("结果对比").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("仅比较已读取的数据");
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b=>b.textContent==="关闭")!.click());
  act(()=>host.querySelector('#dbx-cell-0-1')!.dispatchEvent(new MouseEvent("mousedown",{bubbles:true})));
  openTools();expect(item("关联记录").disabled).toBe(false);
  await act(async()=>item("关联记录").click());
  expect(onRelated).toHaveBeenCalledWith(rows[0]);
  const source=host.querySelector<HTMLDetailsElement>('.dbx-result-source')!;
  expect(source.open).toBe(false);
  act(()=>source.querySelector('summary')!.click());
  expect(source.open).toBe(true);expect(source.textContent).toContain(snapshot.sql);
});

it("没有结果时给出恢复路径，清除本地筛选恢复数据",()=>{
  act(()=>{root=createRoot(host);root.render(<ResultTable columns={columns} rows={[["可见",1]]} meta="1 行" table="T" />);});
  act(()=>host.querySelector<HTMLButtonElement>('[aria-label="筛选结果"]')!.click());
  const input=host.querySelector<HTMLInputElement>('[aria-label="在结果中筛选"]')!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"不存在");input.dispatchEvent(new Event("input",{bubbles:true}));});
  expect(host.querySelector('[role="status"]')?.textContent).toContain("筛选后没有匹配的行");
  const clear=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==="清除结果筛选")!;
  act(()=>clear.click());
  expect(host.querySelector('.dbx-grid-empty')).toBeNull();
  expect(host.querySelector('#dbx-cell-0-0')?.textContent).toBe("可见");
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.querySelectorAll(".wb-ctx").forEach((n) => n.remove());
});

describe("结果表的排序口径（A3）", () => {
  it("没排序时不占横带；点了表头就说明只作用于已取的行", async () => {
    act(() => {
      root = createRoot(host);
      root.render(<ResultTable columns={columns} rows={[["b", "2"], ["a", "1"]]} meta="2 行" table="T" />);
    });
    expect(host.textContent).not.toContain("仅作用于已取");
    // 没有重排回调（表页 / 非 SELECT）时不该提示「右键表头」
    expect(host.textContent).not.toContain("右键表头");

    const head = host.querySelectorAll(".dbx-gh")[1] as HTMLElement;
    await act(async () => head.click());
    expect(host.textContent).toContain("仅作用于已取的 2 行");
    expect(host.textContent).not.toContain("右键表头");
  });

  it("有重排回调时，排序后的说明里给出整表重排入口", async () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <ResultTable columns={columns} rows={[["b", "2"]]} meta="1 行" table="T" onServerSort={() => {}} />,
      );
    });
    const head = host.querySelectorAll(".dbx-gh")[1] as HTMLElement;
    await act(async () => head.click());
    expect(host.textContent).toContain("仅作用于已取的 1 行");
    expect(host.textContent).toContain("右键表头");
  });

  it("表头右键 → 重排并重查，回调给的是列下标与方向", async () => {
    const onServerSort = vi.fn();
    act(() => {
      root = createRoot(host);
      root.render(
        <ResultTable columns={columns} rows={[["b", "2"]]} meta="1 行" table="T" onServerSort={onServerSort} />,
      );
    });
    const head = host.querySelectorAll(".dbx-gh")[1] as HTMLElement | undefined;
    expect(head).toBeTruthy();
    await act(async () => {
      head!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    });
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const resort = items.find((b) => b.textContent?.includes("重排并重查") && b.textContent.includes("升序"));
    expect(resort).toBeTruthy();
    await act(async () => {
      resort!.click();
    });
    expect(onServerSort).toHaveBeenCalledWith(0, "asc");
  });
});
