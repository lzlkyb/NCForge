import { expect, it, vi } from "vitest";
import { headMenuItems, type HeadMenuDeps } from "./resultHeadMenu";
import type { ColumnMeta } from "./dbApi";

/**
 * 表头右键菜单：本地排序 / 显示 / 重排并重查三组。
 *
 * 从 `ResultTable` 抽出来时最容易出错的不是搬代码，是分支：二进制列该给三档
 * 显示、普通列该只有解码开关，两者不能同时出现；`onServerSort` 缺席时那两项
 * 必须写成「不支持」而不是消失（用户找不到会以为功能没了）。
 */
const deps = (patch: Partial<HeadMenuDeps> = {}): HeadMenuDeps => ({
  col: 0,
  columns: [{ name: "CODE", type: "VARCHAR2(20)" } as ColumnMeta],
  binaryMode: "auto",
  decoded: false,
  decodable: true,
  setSort: vi.fn(),
  fitOne: vi.fn(),
  fitAll: vi.fn(),
  setBinaryMode: vi.fn(),
  toggleDecode: vi.fn(),
  ...patch,
});

it("本地排序与自适应宽度总是有，点哪列就作用于哪列", () => {
  const d = deps({ col: 3 });
  const items = headMenuItems(d);
  items[0].onSelect?.();
  items[2].onSelect?.();
  expect(d.setSort).toHaveBeenCalledWith({ col: 3, dir: "asc" });
  expect(d.fitOne).toHaveBeenCalledWith(3);
});

it("二进制列给三档显示并标出当前档位，不给解码开关", () => {
  const items = headMenuItems(deps({
    columns: [{ name: "BLOB_COL", type: "BLOB" } as ColumnMeta], binaryMode: "raw",
  }));
  const modes = items.filter(i => i.label.startsWith("二进制显示："));
  expect(modes.map(i => i.label)).toEqual(["二进制显示：自动识别", "二进制显示：文本", "二进制显示：原始 Hex"]);
  expect(modes.filter(i => i.checked).map(i => i.label)).toEqual(["二进制显示：原始 Hex"]);
  expect(items.some(i => i.label.includes("解码"))).toBe(false);
});

it("普通列只有解码开关，没有可解码的值时置灰", () => {
  const off = headMenuItems(deps({ decodable: false }));
  const toggle = off.find(i => i.label.includes("显示解码后的值"))!;
  expect(toggle.disabled).toBe(true);
  // 已经开着解码时，文案要说「恢复原始值」，否则用户不知道再点一次会怎样。
  const on = headMenuItems(deps({ decoded: true })).find(i => i.label.includes("恢复原始值"))!;
  expect(on.onSelect).toBeTypeOf("function");
});

it("不支持整表重排时两项仍在，只是禁用并说明原因", () => {
  const items = headMenuItems(deps());
  const server = items.filter(i => i.label.includes("重排并重查"));
  expect(server).toHaveLength(2);
  expect(server.every(i => i.disabled === true)).toBe(true);
  expect(server[0].label).toBe("重排并重查（这条结果不支持）");
});
