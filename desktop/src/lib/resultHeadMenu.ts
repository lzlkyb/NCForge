import type { ContextMenuItem } from "../components/workspace/ContextMenu";
import type { ColumnMeta } from "./dbApi";
import { binaryColumn } from "./cellCodec";
import { serverSortLabel } from "./serverSort";
import type { SortState } from "./resultView";

/**
 * 表头右键菜单项。从 `ResultTable` 抽出来守 300 行红线，口径原样搬走。
 *
 * 三组动作分得很清，别混：
 * - **本地**（只排已取的行）：升序 / 降序 / 本列自适应 / 全部自适应；
 * - **显示**：二进制列给三档（自动 / 文本 / 原始 Hex），其它列只有解码开关；
 * - **重排并重查**（`onServerSort`）：让数据库整表有序，不传就是这条结果不支持。
 */
export interface HeadMenuDeps {
  col: number;
  columns: ColumnMeta[];
  /** 二进制列的当前档位，用来打勾。 */
  binaryMode: "auto" | "text" | "raw";
  /** 这一列是否已开解码 / 是否有可解码的值（没有就置灰，不让点了没反应）。 */
  decoded: boolean;
  decodable: boolean;
  onServerSort?: (col: number, dir: "asc" | "desc") => void;
  setSort: (sort: SortState) => void;
  fitOne: (col: number) => void;
  fitAll: () => void;
  setBinaryMode: (mode: "auto" | "text" | "raw") => void;
  toggleDecode: (col: number) => void;
}

export function headMenuItems(d: HeadMenuDeps): ContextMenuItem[] {
  const name = d.columns[d.col]?.name ?? "";
  const labels: Record<"auto" | "text" | "raw", string> = {
    auto: "自动识别", text: "文本", raw: "原始 Hex",
  };
  return [
    { label: "本地升序（只排已取的行）", onSelect: () => d.setSort({ col: d.col, dir: "asc" }) },
    { label: "本地降序（只排已取的行）", onSelect: () => d.setSort({ col: d.col, dir: "desc" }) },
    { label: "本列自适应宽度", onSelect: () => d.fitOne(d.col) },
    { label: "全部列自适应宽度", onSelect: d.fitAll },
    ...(binaryColumn(d.columns[d.col]?.type)
      ? (["auto", "text", "raw"] as const).map(mode => ({
          label: `二进制显示：${labels[mode]}`,
          checked: d.binaryMode === mode,
          onSelect: () => d.setBinaryMode(mode),
        }))
      : [{
          label: d.decoded ? "恢复原始值（关闭解码）" : "显示解码后的值（Hex / Base64）",
          disabled: !d.decoded && !d.decodable,
          onSelect: () => d.toggleDecode(d.col),
        }]),
    {
      label: d.onServerSort ? serverSortLabel(name, "asc") : "重排并重查（这条结果不支持）",
      disabled: !d.onServerSort,
      onSelect: () => d.onServerSort?.(d.col, "asc"),
    },
    {
      label: d.onServerSort ? serverSortLabel(name, "desc") : "重排并重查（这条结果不支持）",
      disabled: !d.onServerSort,
      onSelect: () => d.onServerSort?.(d.col, "desc"),
    },
  ];
}
