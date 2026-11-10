// @vitest-environment jsdom
/**
 * 拖列宽期间冻结行高（S4-2）。
 *
 * 换行模式下列宽每变一次都要按新宽度重测每一行（CLOB 列可达 8K 字符），
 * 500 行 × 20 列跟着 pointermove 重测会直接卡死。这里锁住契约：
 * `frozen` 为真时高度保持上一次测量结果，松手（frozen=false）后才按最终宽度重算。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ColumnMeta } from "../lib/dbApi";
import { useGridRowLayout } from "./useGridRowLayout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const columns: ColumnMeta[] = [{ name: "TXT", type: "VARCHAR2(4000)", precision: 0, scale: 0 }];
const rows = [["一个很长的中文文本".repeat(2)], ["短"]];

function Probe({ width, frozen }: { width: number; frozen: boolean }) {
  const layout = useGridRowLayout({ rows, columns, widths: [width], order: [0, 1], wrap: true, rowH: 26, frozen });
  return <output data-total={layout.total}>{layout.heights.join(",")}</output>;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const heights = () => host.querySelector("output")!.textContent ?? "";
const total = () => Number(host.querySelector("output")!.getAttribute("data-total"));

describe("useGridRowLayout 拖列宽冻结", () => {
  it("frozen 时沿用旧高度，松手后按新宽度重算", () => {
    act(() => root.render(<Probe width={220} frozen={false} />));
    const wide = heights();
    const wideTotal = total();

    // 拖到一半：宽度变了，但高度不跟着重测
    act(() => root.render(<Probe width={90} frozen />));
    expect(heights()).toBe(wide);
    expect(total()).toBe(wideTotal);

    // 松手：按最终宽度重算，长文本折行更多 → 更高
    act(() => root.render(<Probe width={90} frozen={false} />));
    const narrow = heights().split(",").map(Number);
    expect(heights()).not.toBe(wide);
    expect(narrow[0]).toBeGreaterThan(Number(wide.split(",")[0]));
    // 行高始终是行高单位的整数倍（不会量出半行）
    expect(narrow.every((h) => h > 0 && h % 26 === 0)).toBe(true);
    expect(total()).toBe(narrow[0] + narrow[1]);
  });
});
