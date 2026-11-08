import type { Cell, ColumnMeta } from "./dbApi";
import { isNumericType } from "./resultExport";

/** 结果表的本地排序与筛选（不重新查库）。返回显示顺序：原始行号数组。 */

export interface SortState {
  col: number;
  dir: "asc" | "desc";
}

const collator = new Intl.Collator("zh-CN");
function cmp(a: Cell, b: Cell, numeric: boolean): number {
  // NULL 永远排最后，不论升降序（与 PL/SQL Developer 一致）
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (numeric) {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  }
  return collator.compare(String(a), String(b));
}

export function viewOrder(rows: Cell[][], columns: ColumnMeta[], filter: string, sort: SortState | null): number[] {
  const q = filter.trim().toLowerCase();
  let order = rows.map((_, i) => i);
  if (q) {
    order = order.filter((i) => rows[i].some((v) => v !== null && String(v).toLowerCase().includes(q)));
  }
  if (sort && sort.col < columns.length) {
    const numeric = isNumericType(columns[sort.col].type);
    const sign = sort.dir === "asc" ? 1 : -1;
    order.sort((i, j) => {
      const a = rows[i][sort.col];
      const b = rows[j][sort.col];
      if (a === null || b === null) return cmp(a, b, numeric);
      return sign * cmp(a, b, numeric) || i - j;
    });
  }
  return order;
}

/** 点表头：未排序 → 升序 → 降序 → 未排序。 */
export function nextSort(cur: SortState | null, col: number): SortState | null {
  if (!cur || cur.col !== col) return { col, dir: "asc" };
  return cur.dir === "asc" ? { col, dir: "desc" } : null;
}

/**
 * 行号列宽度（border-box）。
 *
 * `.dbx-gc` 左右各有 10px padding、13px `tabular-nums` 下每位数字约 7.8px。
 * 旧公式 `位数 × 8 + 18` 比 padding 少 2px：三位数时内容区只剩 22px，
 * `text-overflow: ellipsis` 会把它显示成 `1…`（100 行之后全部踩到）。
 * 按 9px/位 + 26px 余量，100 / 1000 / 10000 行都放得下。
 */
export function rowNumberWidth(total: number): number {
  const digits = Math.max(1, String(Math.max(0, Math.floor(total))).length);
  return Math.max(44, digits * 9 + 26);
}

// ---------------------------------------------------------------------------
// 文本测量
//
// 🔴 表头与单元格的「可用文本宽度」不是列宽本身：
//   · `.dbx-gc` / `.dbx-gh` 左右各 10px padding（db-console.css）        → 20
//   · `.dbx-gh[data-has-menu] .dbx-header-action { width: calc(100% - 18px) }` → 18（列菜单按钮）
//   · `.dbx-gh .nm { max-width: calc(100% - 14px) }`                      → 14（排序箭头，没排序也占位）
// 表头合计 52px 固定开销，旧的 `字符数 × 7.4 + 28` 只留 28px ⇒ 每个列名都少 24px，
// 连 `PK_HEAD` 这种短名都会被截成 `pk_…`。
// ---------------------------------------------------------------------------

/** 表头文本之外必须留出的宽度（padding + 列菜单按钮 + 排序箭头）。 */
export const HEADER_CHROME = 52;
/** 单元格文本之外必须留出的宽度（`.dbx-gc` 的 `padding: 0 10px`）。 */
export const CELL_CHROME = 20;

const MIN_COL_W = 72;
const MAX_COL_W = 420;
/** 超过这个长度的值不参与测宽：网格里本来就只渲染前 300 字符，测全文纯浪费。 */
const PROBE_CHARS = 120;
/** 参与测宽的行数。只扫前 50 行会漏掉「前 50 行都短、后面才长」的列。 */
const SAMPLE_ROWS = 200;

const FONT_SIZE = 13; // 与 `--dbx-fs-body` 一致（紧凑 / 舒适两档都是 13px）
/**
 * 🔴 字体族顺序必须与 CSS 完全一致（`.dbx-grid` / `.dbx-gh` 都是
 * `system-ui, "Segoe UI", sans-serif`）。写成 `"Segoe UI"` 在前，Windows 的
 * `system-ui` 会解析到另一个更宽的字体，实测同一串文本窄 11%——列名照样被截断，
 * 而且「本地看起来没问题、用户机器上全截断」这种差异最难查。
 */
const FONT_FAMILY = `system-ui, "Segoe UI", sans-serif`;

let measureCtx: CanvasRenderingContext2D | null | undefined;
let measureFont = "";
const widthCache = new Map<string, number>();

/**
 * jsdom 没有 canvas 实现，`getContext` 会返回 null 并在控制台打一条 “Not implemented”。
 * 直接按 UA 跳过，别让测试输出被噪音塞满。
 */
function context(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  try {
    const usable = typeof document !== "undefined" && typeof HTMLCanvasElement !== "undefined"
      && !/jsdom/i.test(globalThis.navigator?.userAgent ?? "");
    measureCtx = usable ? document.createElement("canvas").getContext("2d") : null;
  } catch {
    measureCtx = null;
  }
  return measureCtx;
}

/**
 * 无 canvas 时的回退估算：按字符类别给宽（13px `system-ui` 的近似值，宁宽勿窄）。
 *
 * 只服务测试与降级路径；线上走 `measureText`，误差在 1px 以内。
 */
function estimate(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c > 0x2e80) w += 13.5; // CJK / 全角标点
    else if (c >= 48 && c <= 57) w += 7.6; // 数字
    else if (c >= 65 && c <= 90) w += 9.4; // 大写
    else if (c === 32) w += 3.8; // 空格
    else w += 7.2; // 小写与常见符号
  }
  return w;
}

/** 一段文本渲染出来有多宽（px）。按字符串 + 字重缓存，滚动时不会重复测量。 */
export function textWidth(text: string, bold = false): number {
  if (!text) return 0;
  const key = bold ? `b${text}` : text;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  let w: number;
  const ctx = context();
  if (ctx) {
    const style = `${bold ? "600 " : ""}${FONT_SIZE}px ${FONT_FAMILY}`;
    if (measureFont !== style) {
      ctx.font = style;
      measureFont = style;
    }
    w = ctx.measureText(text).width;
  } else {
    w = estimate(text);
  }
  // 上限兜底：一屏上千格，缓存不封顶会把大结果集的内存吃穿
  if (widthCache.size < 8000) widthCache.set(key, w);
  return w;
}

/** 最窄的字符（`l` / `i` / 空格）约占 3.1px：用它当下界能免掉对长文本的测量。 */
const MIN_CHAR_W = 3.1;

/** 这段文本放进宽度 `width` 的格子里能不能完整显示（已扣除 padding）。 */
export function fitsCell(text: string, width: number): boolean {
  const avail = width - CELL_CHROME;
  if (avail <= 0) return false;
  // 下界都已经超了就不必真测——300 字符的 JSON 走不到 canvas 也进不了缓存
  if (text.length * MIN_CHAR_W > avail) return false;
  return textWidth(text) <= avail;
}

/** 采样时要测的文本；NULL / 空串 / 超长值（含 8K 大文本预览）不进测量。 */
function sampleText(v: Cell): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : String(v);
  if (!s) return null;
  return s.length > PROBE_CHARS ? s.slice(0, PROBE_CHARS) : s;
}

/** 列名完整显示需要的宽度。表头渲染的是小写名（`ResultGridHeader` 的 `.nm`），按小写测才准。 */
function headerNeed(column: ColumnMeta): number {
  return textWidth(column.name.toLowerCase(), true) + HEADER_CHROME;
}

/** 样本值里最宽的那一个 + 单元格 padding。 */
function bodyNeed(rows: Cell[][], col: number): number {
  let best = 0;
  const n = Math.min(rows.length, SAMPLE_ROWS);
  for (let i = 0; i < n; i += 1) {
    const s = sampleText(rows[i]?.[col] ?? null);
    if (!s) continue;
    // 每个字符最多 14px（中文上限）：连上界都超不过当前最大值就不必真测（大表最省的一条）
    if (s.length * 14 <= best) continue;
    const w = textWidth(s);
    if (w > best) best = w;
    if (best >= MAX_COL_W - CELL_CHROME) return MAX_COL_W;
  }
  return best + CELL_CHROME;
}

/**
 * 单列的合适宽度：`max(列名完整显示, 样本值完整显示)`，夹在 72–420。
 *
 * 列名优先——挤的时候宁可让值省略（值还有 tooltip / 详情两条后路），
 * 也不能让用户看不出这列是什么（行业软件的共同选择）。
 */
export function fitWidth(column: ColumnMeta, rows: Cell[][], index: number): number {
  const need = Math.max(headerNeed(column), bodyNeed(rows, index));
  // 向上取整：四舍五入会把 154.4 压成 154，差这 0.4px 就够让省略号冒出来。
  return Math.ceil(Math.max(MIN_COL_W, Math.min(MAX_COL_W, need)));
}

/**
 * 按结果集缓存算好的列宽。
 *
 * 拖列宽结束会触发父组件换 `widthOverrides`，`ResultGrid` 的 effect 会重算一遍全部列宽；
 * 一次测量是「列数 × 最多 200 行」次 `measureText`，不缓存的话每拖一次都要再付一遍。
 * 用 WeakMap 挂在大数组上，结果被丢掉时一起回收；`length` 变了（加载更多）就重算。
 */
const widthByRows = new WeakMap<Cell[][], { columns: ColumnMeta[]; length: number; widths: number[] }>();

/** 首次渲染的列宽：逐列 `fitWidth`。手调过的宽度由 `widthOverrides` 覆盖，不在这里处理。 */
export function initialWidths(columns: ColumnMeta[], rows: Cell[][]): number[] {
  const hit = widthByRows.get(rows);
  if (hit && hit.columns === columns && hit.length === rows.length) return hit.widths;
  const widths = columns.map((c, k) => fitWidth(c, rows, k));
  widthByRows.set(rows, { columns, length: rows.length, widths });
  return widths;
}
