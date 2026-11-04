// @vitest-environment jsdom
/**
 * 批量条的出现条件与作用范围：
 * - 只勾一个文件时不该出现（没有可批量的动作，白占一行）；
 * - 「全选当前 / 取消当前」只作用在当前筛选结果上，别把筛选外的勾也带走。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PatchList } from "./PatchList";
import type { PatchItem } from "../../lib/patch";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function item(rel: string, patch: Partial<PatchItem> = {}): PatchItem {
  return {
    path: `C:/ws/${rel}`,
    rel,
    label: rel,
    module: rel.split("/")[0],
    section: "private",
    pkgRel: rel,
    target: "modules/ic",
    layer: { hyext: false, why: "标准层" },
    classes: [],
    problems: [],
    blocked: false,
    outRootUsed: "out",
    ...patch,
  };
}

const ITEMS = [item("ic/A.java"), item("ic/B.java"), item("pu/C.java")];

let root: Root;
let container: HTMLDivElement;

const mount = async ({ picked, keyword = "", items = ITEMS }: { picked: Set<string>; keyword?: string; items?: PatchItem[] }) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PatchList
        items={items}
        deleted={[]}
        letters={new Map()}
        scanning={false}
        picked={picked}
        keyword={keyword}
        filter="all"
        selected={null}
        onKeyword={() => {}}
        onFilter={() => {}}
        onToggle={onToggle}
        onToggleGroup={onGroup}
        onSelect={onSelect}
      />,
    );
  });
};

const onGroup = vi.fn();
const onToggle = vi.fn();
const onSelect = vi.fn();

beforeEach(() => { onGroup.mockReset(); onToggle.mockReset(); onSelect.mockReset(); });

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const bar = () => container.querySelector(".pk-batch") as HTMLDivElement | null;
const link = (text: string) =>
  [...(bar()?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;

describe("PatchList 批量条", () => {
  it("长文件名保留完整提示，查看详情与勾选互不触发，编译状态仍可读", async () => {
    const long = item("很长的业务模块/VeryLongBusinessOperationModel.java");
    const upm = item("ic/META-INF/aiercrossborrow.upm", { section: "upm", layer: null });
    await mount({ picked: new Set(), items: [long, upm] });
    const row = container.querySelector(".pk-row")!;
    const file = row.querySelector<HTMLButtonElement>(".pk-fn")!;
    expect(file.title).toBe(long.label);
    expect(container.querySelector<HTMLElement>(".pk-grp-name")?.title).toBe(long.module);
    expect(row.querySelector(".pk-lay")?.textContent).toBe("标准");
    expect(row.querySelector(".pk-pair")?.textContent).toBe("未编译");
    expect(container.querySelectorAll(".pk-pair")[1].textContent).toBe("整文件");
    await act(async () => file.click());
    expect(onSelect).toHaveBeenCalledWith(long.path);
    expect(onToggle).not.toHaveBeenCalled();
    onSelect.mockClear();
    await act(async () => row.querySelector<HTMLButtonElement>(".pk-cbx")!.click());
    expect(onToggle).toHaveBeenCalledWith(long.path);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("只勾一项时不渲染批量条", async () => {
    await mount({ picked: new Set([ITEMS[0].path]) });
    expect(bar()).toBeNull();
  });

  it("多选时出现在清单上方，并给出总数", async () => {
    await mount({ picked: new Set([ITEMS[0].path, ITEMS[1].path]) });
    expect(bar()?.textContent).toContain("已选 2 / 3");
  });

  it("「取消当前」只取消筛选命中的那些", async () => {
    await mount({ picked: new Set(ITEMS.map((i) => i.path)), keyword: "C.java" });
    expect(bar()?.textContent).toContain("当前 1");
    await act(async () => link("取消当前")!.click());
    expect(onGroup).toHaveBeenCalledWith([ITEMS[2].path], false);
  });

  it("「清空」把筛选外的勾也一并取消，且跳过阻断项", async () => {
    const blocked = item("ic/D.java", { blocked: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <PatchList
          items={[...ITEMS, blocked]}
          deleted={[]}
          letters={new Map()}
          scanning={false}
          picked={new Set(ITEMS.map((i) => i.path))}
          keyword=""
          filter="all"
          selected={null}
          onKeyword={() => {}}
          onFilter={() => {}}
          onToggle={() => {}}
          onToggleGroup={onGroup}
          onSelect={() => {}}
        />,
      );
    });
    await act(async () => link("清空")!.click());
    expect(onGroup).toHaveBeenCalledWith(
      [ITEMS[0].path, ITEMS[1].path, ITEMS[2].path],
      false,
    );
  });
});
