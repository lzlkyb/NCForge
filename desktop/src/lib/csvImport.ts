/**
 * 导入计划（把解析好的 CSV 切成一批批发给后端）。
 *
 * 这里只有一件容易做错、做错了还**不报错**的事：**失败行号要能对回文件的第几行**。
 * 文件第 1 行是表头，所以第 i 条数据（从 0 数）在文件第 i + 2 行；分批之后每批的
 * 起始行号必须是 `批起始下标 + 2`，漏了 +2 用户拿到的"第 3 行"永远对不上 Excel。
 *
 * 所以把它从组件里拆出来做纯函数，配单测锁住——组件里那些 hook 只是壳。
 */

import type { ParsedRows } from "./csvParse";

/** 一条映射：文件第 `from` 列 → 目标表第 `to` 列。`to < 0` 表示这一列不导入。 */
export interface Mapping {
  to: number;
  from: number;
}

/** 目标列（名字 + Oracle 类型名，类型决定后端怎么写日期/数字字面量）。 */
export interface TargetCol {
  name: string;
  type: string;
}

export interface ImportChunk {
  /** 该批的数据；每行长度等于 `columns.length`，缺格是 `null`。 */
  rows: (string | null)[][];
  /** 这批第 1 条数据在**文件里**的行号（表头算第 1 行）。 */
  startLine: number;
}

export interface ImportPlan {
  columns: { name: string; ty: string }[];
  chunks: ImportChunk[];
}

/**
 * 按 `batch` 大小切批。
 *
 * 空单元格 **原样传空串**，不在这里转 `null`——空串写 NULL 是后端 `sql_export::literal`
 * 的口径（Oracle 里空串本来就是 NULL），前端提前转会让"字符串里真的有一个空格"没法区分。
 * 只有**行比映射列短**（文件某行少了几格）才补 `null`。
 */
export function planImport(
  csv: ParsedRows,
  target: TargetCol[],
  picked: Mapping[],
  batch: number,
): ImportPlan {
  const columns = picked.map((p) => {
    const c = target[p.to];
    return { name: c?.name ?? "", ty: c?.type ?? "" };
  });
  // batch 是常量，但调用方传 0 / 负数会让 for 循环永不前进，宁可用 1 兜底也不死循环
  const step = Math.max(1, Math.floor(batch) || 1);
  const chunks: ImportChunk[] = [];
  for (let start = 0; start < csv.rows.length; start += step) {
    const rows = csv.rows
      .slice(start, start + step)
      .map((r) => picked.map((p) => r[p.from] ?? null));
    chunks.push({ rows, startLine: start + 2 });
  }
  return { columns, chunks };
}
