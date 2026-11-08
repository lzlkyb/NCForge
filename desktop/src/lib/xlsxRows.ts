import type { ParsedRows } from "./csvParse";

/**
 * 后端读出来的工作表（`db_xlsx_read` 的返回）。列按文本给，不做类型判断。
 */
export interface XlsxSheet {
  /** 工作表显示名（多 sheet 的文件要知道读的是哪一张）。 */
  sheet: string;
  rows: string[][];
}

/**
 * 工作表 → 「表头 + 行」，与 CSV / JSON 走同一套导入流程。
 *
 * 三条与直觉不同、但都是从真实 Excel 文件里来的规则：
 * - **开头的空行跳过**：很多人第 1 行留空、标题在第 2 行。不跳的话表头会变成空字符串数组，
 *   自动列匹配全落空，用户会以为「Excel 导入不认列名」。
 * - **表头宽度取全表最宽的一行**：Excel 里数据比表头多一列很常见（表头少填一格），
 *   按表头宽度截断会**静默丢数据**。多出来的列补成「列N」，让用户自己决定要不要导。
 * - **空列名补成「列N」**：空字符串当表头在映射界面上是一行看不见的空白，没法点。
 */
export function sheetToRows(sheet: XlsxSheet): ParsedRows {
  // 单元格**不 trim**：与 CSV 同口径（`parseCsv` 也只去表头的空白）。文本列里
  // 有意保留的首尾空格一旦被吃掉，写进去的值就和用户看到的文件不是一回事了。
  const raw = sheet.rows.map((r) => r.map((c) => c ?? ""));
  let from = 0;
  while (from < raw.length && isBlank(raw[from])) from += 1;
  if (from >= raw.length) return { headers: [], rows: [], lineCount: 0, blankLines: raw.length };

  const width = Math.max(...raw.slice(from).map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => (raw[from][i] ?? "").trim()).map((h, i) =>
    h === "" ? `列${i + 1}` : h,
  );

  const rows: string[][] = [];
  let blank = from; // 开头的空行同样算「被跳过」，否则行数对不上用户看到的表
  for (const r of raw.slice(from + 1)) {
    if (isBlank(r)) {
      blank += 1;
      continue;
    }
    // 补到表头宽度：短行不补会在 planImport 里变成 undefined，写回时是 NULL 还是漏列说不清
    rows.push(Array.from({ length: width }, (_, i) => r[i] ?? ""));
  }
  // lineCount 与 CSV 同口径：去掉空行后含表头的总行数，用来把失败行号对回 Excel 行号
  return { headers, rows, lineCount: rows.length + 1, blankLines: blank };
}

function isBlank(row: string[] | undefined): boolean {
  return !row || row.every((c) => c === "");
}

/** 文件名判断：`.xlsx` 走二进制解压，`.xls`（旧 BIFF）不支持——它根本不是 zip。 */
export function isXlsxFile(name: string): boolean {
  return /\.xlsx$/i.test(name) || /\.xlsm$/i.test(name);
}
