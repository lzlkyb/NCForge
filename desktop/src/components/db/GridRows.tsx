import type { RefObject } from "react";
import { GridCellEditor } from "./GridCellEditor";
import { gridSelectionCell, gridSelectionHeading } from "../../lib/gridSelection";
import { CELL_TEXT_MAX, isWideText } from "../../lib/wideText";
import type { GridCodec } from "../../lib/cellCodec";
import type { Cell } from "../../lib/dbApi";
import type { CellPos, GridEdit } from "./gridEdit";
import type { selectionBounds } from "../../lib/gridViewport";
import type { CSSProperties } from "react";

/**
 * 结果网格的数据行（虚拟滚动的 `[first, last)` 区间）。
 *
 * 从 `ResultGrid` 抽出来只为守住 300 行体量红线：渲染口径一行未改，
 * 几何（行高 / 偏移 / 列位置）仍由父组件的 `useGridRowLayout` 与 `cellStyle` 算好传进来。
 *
 * 每个格子有两种形态：正在编辑的贴一个 `GridCellEditor`，其余按值类型渲染。
 * 大文本编辑框开着（`textOpen`）时**不渲染**那个 input——它的 autoFocus 会和弹层的
 * textarea 抢焦点，input 一 blur 就提交，弹层跟着自己关了。
 */
export function GridRows({ order, first, last, layout, rowH, headH, total, rnW, viewport, visible, bounds, sel, editing, textOpen, numeric, wrap, valueAt, cellStyle, edit, codec, onSel, onCellMenu, startEdit, onOpenDetail, onCellEditor, boxRef, idPrefix = "dbx-cell" }: {
  order: number[]; idPrefix?: string;
  /** 可视区间（闭开区间），由 `layout.range` 算出。 */
  first: number;
  last: number;
  layout: { heights: number[]; offsetAt: (index: number) => number };
  rowH: number;
  headH: number;
  /** 表格总宽（行号列 + 各列宽）。 */
  total: number;
  rnW: number;
  viewport: { column: number; index: number; width: number; frozen: boolean; sticky: number; left: number }[];
  /** 全部可见列（列布局算出来的）：点行号要选的是「第一个可见列 → 最后一个可见列」。 */
  visible: number[];
  bounds: ReturnType<typeof selectionBounds>;
  sel: CellPos | null;
  editing: { pos: CellPos; value: string } | null;
  textOpen: boolean;
  numeric: boolean[];
  wrap: boolean;
  valueAt: (r: number, c: number) => Cell;
  cellStyle: (c: number) => CSSProperties;
  edit?: GridEdit;
  codec: GridCodec;
  onSel: (p: CellPos, extend?: boolean) => void;
  onCellMenu?: (r: number, c: number, x: number, y: number) => void;
  startEdit: (pos: CellPos, fromMouse?: boolean) => void;
  /** 打开某一格的详情（格内「…」按钮）。不传就退回只角标、不提供点击入口。 */
  onOpenDetail?: (r: number, c: number) => void;
  onCellEditor: {
    onChange: (value: string) => void;
    onCommit: () => void;
    onCancel: () => void;
    onCommitMove: (dr: number, dc: number) => void;
    onExpand: () => void;
  };
  boxRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      {order.slice(first, last).map((r, j) => {
        const i = first + j;
        const state = edit?.rowState?.(r);
        const height = layout.heights[r] ?? rowH;
        return (
          <div
            key={r}
            className="dbx-grow"
            style={{ top: headH + layout.offsetAt(i), height, width: total }}
            data-odd={i % 2 === 1 || undefined}
            data-state={state}
            data-wrap={wrap || undefined}
            role="row"
            aria-rowindex={i + 2}
          >
            <div className="dbx-gc rn" data-range-heading={gridSelectionHeading(bounds, i, "row")} style={{ width: rnW, height: wrap ? height : undefined }} role="rowheader" aria-colindex={1} title={state === "added" ? "未写回的新增行" : state === "deleted" ? "待删除，写回时执行" : undefined} onMouseDown={() => { if (visible.length) { onSel({ r, c: visible[0] }); onSel({ r, c: visible[visible.length - 1] }, true); } }}>{state === "added" ? "+ " : state === "deleted" ? "− " : ""}{i + 1}</div>
            {viewport.map(({ column: k, index: vi, width }) => {
              const v = valueAt(r, k);
              const selected = gridSelectionCell(bounds, i, vi, sel?.r === r && sel?.c === k), isSel = !!selected["data-cell"];
              if (isSel && editing && editing.pos.r === r && editing.pos.c === k && !textOpen) {
                return (
                  <GridCellEditor
                    key={k}
                    id={`${idPrefix}-${r}-${k}`}
                    colIndex={vi + 2}
                    style={{ ...cellStyle(k), height }}
                    value={editing.value}
                    changed={edit?.changed.has(`${r}:${k}`) ?? false}
                    selected={selected}
                    onChange={onCellEditor.onChange}
                    onCommit={onCellEditor.onCommit}
                    onCancel={onCellEditor.onCancel}
                    onCommitMove={onCellEditor.onCommitMove}
                    onExpand={onCellEditor.onExpand}
                  />
                );
              }
              const cls = ["dbx-gc", numeric[k] && "n", v === null && "null", edit?.changed.has(`${r}:${k}`) && "chg"].filter(Boolean).join(" ");
              const valueKind = v === null ? "null" : v === "" ? "empty" : typeof v === "string" && !/\S/.test(v) ? "whitespace" : undefined;
              // 显示不全的格子（长文本 / 多行 / 后端 8K 预览）：右缘给一个「…」按钮。
              // 复刻 PL/SQL Developer 的 cell button —— 从那儿迁过来的用户，习惯就是点这个
              // 小钮看全值；而双击在四家主流工具里都是「编辑」，不能把查看借走。
              const wide = isWideText(v, wrap);
              return (
                <div
                  key={k}
                  id={`${idPrefix}-${r}-${k}`}
                  className={cls}
                  style={wrap ? { ...cellStyle(k), height } : cellStyle(k)}
                  role="gridcell"
                  aria-colindex={vi + 2}
                  data-value-kind={valueKind}
                  title={codec.title(v, k, width)}
                  aria-label={valueKind === "null" ? "NULL，数据库空值" : valueKind === "empty" ? "空字符串，0 字符" : valueKind === "whitespace" ? `仅空白字符，${String(v).length} 字符` : undefined}
                  {...selected}
                  onMouseDown={e => { e.preventDefault(); boxRef.current?.focus(); onSel({ r, c: k }, e.shiftKey); }}
                  onMouseEnter={e => { if (e.buttons === 1 && !editing) onSel({ r, c: k }, true); }}
                  onDoubleClick={() => startEdit({ r, c: k }, true)}
                  onContextMenu={e => { if (onCellMenu) { e.preventDefault(); onCellMenu(r, k, e.clientX, e.clientY); } }}
                >
                  {(valueKind === "empty" || valueKind === "whitespace") && <span className="dbx-value-placeholder" data-placeholder={valueKind === "empty" ? "空字符串" : "空白"} aria-hidden="true" />}
                  {codec.text(v, k, CELL_TEXT_MAX)}
                  {wide && !onOpenDetail && <span className="dbx-lob-mark" aria-hidden="true" />}
                  {wide && onOpenDetail && (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="dbx-cell-more"
                      aria-label="查看完整内容"
                      title="查看完整内容（这一格在网格里显示不全）"
                      // 选区交给这里自己设：stopPropagation 之后外层的 onMouseDown 收不到。
                      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onSel({ r, c: k }); }}
                      onClick={e => { e.stopPropagation(); onOpenDetail(r, k); }}
                      onDoubleClick={e => e.stopPropagation()}
                    >…</button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
