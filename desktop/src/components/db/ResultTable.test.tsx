// @vitest-environment jsdom
/**
 * A3：排序口径的界面接线。
 *
 * 两个动作必须都在：
 * ① 底栏常驻一行「排序/筛选只作用于已取的 N 行」——不能只靠 hover 提示；
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

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.querySelectorAll(".wb-ctx").forEach((n) => n.remove());
});

describe("结果表的排序口径（A3）", () => {
  it("底栏常驻说明只作用于已取的行", () => {
    act(() => {
      root = createRoot(host);
      root.render(<ResultTable columns={columns} rows={[["b", "2"], ["a", "1"]]} meta="2 行" table="T" />);
    });
    expect(host.textContent).toContain("排序 / 筛选只作用于已取的 2 行");
    // 没有重排回调（表页 / 非 SELECT）时不该提示「右键表头」
    expect(host.textContent).not.toContain("右键表头");
  });

  it("有重排回调时提示入口位置", () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <ResultTable columns={columns} rows={[["b", "2"]]} meta="1 行" table="T" onServerSort={() => {}} />,
      );
    });
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
