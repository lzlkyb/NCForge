import { useCallback, useState } from "react";
import type { ContextMenuItem } from "../components/workspace/ContextMenu";

export interface ResultTableUi {
  filterOpen: boolean;
  columnOpen: boolean;
  /** 单元格详情面板（F4 / 右键第一项 / 工具栏按钮）。 */
  detail: boolean;
  menu: { x: number; y: number; items: ContextMenuItem[] } | null;
  head: { x: number; y: number; col: number } | null;
}

/**
 * 结果表的一组互不相关的开关：筛选框 / 列布局弹窗 / 详情面板 / 两个右键菜单。
 *
 * 合成一个状态袋而不是六个 useState：它们同属「这一份结果的界面状态」，
 * 选区变化时要一起联动（`detail`/`menu` 收掉），分开写容易漏。
 * 从 `ResultTable` 抽出来同时守 300 行体量红线。
 */
export function useResultTableUi() {
  const [ui, setUi] = useState<ResultTableUi>({ filterOpen: false, columnOpen: false, detail: false, menu: null, head: null });
  const setFilterOpen = (value: boolean | ((v: boolean) => boolean)) => setUi(v => ({ ...v, filterOpen: typeof value === "function" ? value(v.filterOpen) : value }));
  const setColumnOpen = (columnOpen: boolean) => setUi(v => ({ ...v, columnOpen }));
  const setDetail = useCallback((detail: boolean) => setUi(v => ({ ...v, detail })), []);
  const setMenu = useCallback((menu: ResultTableUi["menu"]) => setUi(v => ({ ...v, menu })), []);
  const setHead = (head: ResultTableUi["head"]) => setUi(v => ({ ...v, head }));
  return { ...ui, setFilterOpen, setColumnOpen, setDetail, setMenu, setHead };
}
