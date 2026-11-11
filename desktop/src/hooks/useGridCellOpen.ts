import { useRef } from "react";
import { toast } from "../components/ui/toast";
import { isWideText } from "../lib/wideText";
import type { Cell } from "../lib/dbApi";
import type { CellPos, GridEdit } from "../components/db/gridEdit";

/**
 * 单元格「双击」的分流，从 `ResultGrid` 抽出来是为了守住 300 行体量红线。
 *
 * 行业口径（2026-11-11 查过四家）：双击在 PL/SQL Developer / DBeaver / DataGrip /
 * Navicat 里**都是编辑**，没有一家把它让给「查看」。所以这里不抢手势，只做一件事——
 * 当这一格在网格里显示不完整时，让双击**落到能看全的形态上**：
 *
 *   · 可编辑 → 多行大文本框（`onExpand`）。单行 input 里改 2000 字符等于盲打，
 *     主流工具也都是弹独立编辑器。
 *   · 不可编辑 → 详情查看器（`onDetail` + 选中这一格）。普通格仍只提示原因，
 *     否则「点一下就拉开 340px 侧栏」会重新变成 0.2.1 修掉的那个毛病。
 *
 * 键盘路径（Enter / F2 / 直接打字）传 `fromMouse = false`，语义一个字没变。
 */
export function useGridCellOpen({ valueAt, beginEdit, edit, onSel, onDetail, blockedHint, onExpand }: {
  valueAt: (r: number, c: number) => Cell;
  beginEdit: (pos: CellPos) => boolean;
  edit?: GridEdit;
  onSel: (pos: CellPos) => void;
  onDetail?: () => void;
  blockedHint?: string;
  /** 打开大文本编辑框。 */
  onExpand: () => void;
}) {
  /** 提示节流：同一句话 4 秒内不重复刷（双击不可编辑格时会连点）。 */
  const tipAt = useRef(0);
  return (pos: CellPos, fromMouse = false) => {
    const wide = fromMouse && isWideText(valueAt(pos.r, pos.c));
    if (beginEdit(pos)) {
      if (wide) onExpand();
      return;
    }
    if (wide && onDetail) {
      onSel(pos);
      onDetail();
      return;
    }
    const hint = edit?.blockedReason?.(pos.c, pos.r) || blockedHint;
    if (hint && Date.now() - tipAt.current > 4000) {
      tipAt.current = Date.now();
      toast(onDetail ? `${hint}；完整值按 F4 或格内「…」查看` : hint);
    }
  };
}
