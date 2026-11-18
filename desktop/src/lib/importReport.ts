import { downloadText, spreadsheetCell } from "./resultExport";

/**
 * 导入失败行的导出。
 *
 * 为什么要有：后端只回「文件第 N 行 + 错误原文」这种最小信息（`MAX_FAILS=200`），
 * 界面又只显示前 20 条。用户看到「失败 37 行」之后能做的只有一件事——自己对着
 * Excel 数行号。有了 CSV 就能排序、筛选、改完再导。
 *
 * 两条约束：
 * ① **行号换算只在这里**：文件第 1 行是表头，所以 `line - 2` 才是数据下标
 *    （与 `lib/csvImport::planImport` 的 `start + 2` 同一个口径，改一处必须改两处）。
 * ② 单元格必须过 `spreadsheetCell`：错误原文常以 `=` 之类开头，直接落进 CSV 就是
 *    CWE-1236（Excel 当公式执行）。
 */

/** 后端回的失败行：`line` 是**文件里**的行号（表头算第 1 行）。 */
export interface FailedRow {
  line: number;
  error: string;
}

/** 一个格子的 CSV 写法：能含逗号、引号、换行，且先做公式注入防护。 */
function cell(v: string): string {
  const s = spreadsheetCell(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 生成失败行 CSV：`文件行号` + 原始各列 + `导入错误`。
 *
 * 列顺序照抄源文件，用户在 Excel 里改完**删掉第一列和最后一列**就是一份能直接再导的文件。
 * 行号对不上（文件被改过、后端回了批内偏移）时照样出一行空数据，只在错误列里标注——
 * 丢掉这条错误等于让用户少修一行还查不出原因。
 */
export function failedRowsCsv(headers: string[], rows: string[][], failed: FailedRow[]): string {
  const head = ["文件行号", ...headers, "导入错误"].map(cell).join(",");
  const body = failed.map((f) => {
    const src = rows[f.line - 2];
    const cells = headers.map((_, i) => cell(src?.[i] ?? ""));
    const missing = src ? "" : "（未找到该行原始数据）";
    return [cell(String(f.line)), ...cells, cell(`${missing}${f.error}`)].join(",");
  });
  return [head, ...body].join("\r\n");
}

/** 文件名：带表名与时间戳，同一次导入反复导出不会互相覆盖。 */
export function failedRowsName(table: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `导入失败行-${table}-${stamp}.csv`;
}

/** 导出并下载（`downloadText` 默认带 BOM，Excel 才不会把中文读成乱码）。 */
export function saveFailedRows(table: string, headers: string[], rows: string[][], failed: FailedRow[], now = new Date()): void {
  downloadText(failedRowsName(table, now), failedRowsCsv(headers, rows, failed));
}
