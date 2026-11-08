import type { ParsedRows } from "./csvParse";

/** 行数按数据行算；JSON 没有空行概念，`blankLines` 恒为 0。 */
function parsed(headers: string[], rows: string[][]): ParsedRows {
  return { headers, rows, lineCount: rows.length, blankLines: 0 };
}

/**
 * 把 JSON 文件读成「表头 + 行」。
 *
 * 认三种形态，都是接口/日志里最常见的：
 * - `[{...}, {...}]` 对象数组：表头取全部键的并集（按首次出现顺序），缺的键补空；
 * - `[[...], [...]]` 二维数组：表头是「列1…列N」，第一行不当标题（JSON 里没有标题概念）；
 * - `{...}` 单个对象：当成一行。
 *
 * 值一律转成文本：类型由后端按目标列决定（和 CSV 导入同一条路），
 * 这里提前转数字/布尔会引入第二套类型判断，两边迟早不一致。
 */
export function parseJsonRows(text: string): ParsedRows {
  let data: unknown;
  try {
    // 记事本导出的 JSON 常带 UTF-8 BOM，`JSON.parse` 会直接抛「Unexpected token」。
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    // 带上原始报错的位置信息：JSON 少个逗号时用户只能靠 position 找。
    throw new Error(`不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return parsed([], []);
    if (Array.isArray(data[0])) {
      const raw = data.map(r => (Array.isArray(r) ? r.map(cellText) : [cellText(r)]));
      // 参差不齐的行补齐到最宽：导入按列映射取值，短行不补会在写回时变成 undefined。
      const columns = Math.max(0, ...raw.map(r => r.length));
      const rows = raw.map(r => r.length === columns ? r : [...r, ...Array<string>(columns - r.length).fill("")]);
      return parsed(Array.from({ length: columns }, (_, i) => `列${i + 1}`), rows);
    }
    if (data.every(isPlainObject)) {
      const headers: string[] = [];
      for (const row of data as Record<string, unknown>[]) {
        for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
      }
      return parsed(headers, (data as Record<string, unknown>[]).map(row => headers.map(h => cellText(row[h]))));
    }
    // 标量数组：一列。
    return parsed(["值"], data.map(v => [cellText(v)]));
  }

  if (isPlainObject(data)) {
    return parsed(Object.keys(data), [Object.values(data).map(cellText)]);
  }

  throw new Error("JSON 顶层必须是对象、对象数组或二维数组");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 单元格文本化：NULL 保留空串（与 CSV 里空字段同义），嵌套结构退化成 JSON 文本。 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
