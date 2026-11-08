/**
 * CSV / TSV 解析（导入用）。
 *
 * 三条与"随手 split(',')"的差别，都是真实文件里踩过的：
 * - **引号字段里可以有分隔符和换行**：`"a,b"` 是一格，`"a\nb"` 也是一格；
 * - **引号里的 `""` 是一个引号**（Excel 导出的标准写法）；
 * - **首行可能有 BOM**：Excel 存 UTF-8 CSV 会带，不去掉的话第一个表头会变成 `\uFEFFID`。
 *
 * 只解析不判类型：类型由后端按目标列决定（`sql_export::literal`），这里保持纯文本。
 */

export type Delimiter = "," | "\t" | ";";

/**
 * 导入流程真正需要的形状：表头 + 行 + 行数。
 *
 * CSV / TSV / JSON / XLSX 四种来源共用它——`delimiter` 只有分隔符文本类才有，
 * 让 xlsx 去假造一个 `","` 会把「这个字段一定有意义」这句谎话写进类型里。
 */
export interface ParsedRows {
  /** 第一行（已去 BOM 与首尾空白）。空文件是空数组。 */
  headers: string[];
  /** 数据行，长度与 headers 不一定相等（短行补空串，长行截断由调用方决定）。 */
  rows: string[][];
  /** 去掉空行后的总行数（含表头），用于把失败行号对回文件。 */
  lineCount: number;
  /** 被跳过的空行条数（用来解释"行数怎么少了"）。 */
  blankLines: number;
}

export interface ParsedCsv extends ParsedRows {
  delimiter: Delimiter;
}

/** 按首行猜分隔符：制表符优先（TSV 里几乎不会有逗号当分隔），其次分号（部分欧洲区 CSV）。 */
export function guessDelimiter(firstLine: string): Delimiter {
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semis = (firstLine.match(/;/g) ?? []).length;
  if (tabs > 0 && tabs >= commas) return "\t";
  if (commas > 0) return ",";
  if (semis > 0) return ";";
  return ",";
}

export function parseCsv(text: string, force?: Delimiter): ParsedCsv {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = body.slice(0, body.indexOf("\n") === -1 ? body.length : body.indexOf("\n"));
  const delimiter = force ?? guessDelimiter(firstLine);

  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let blank = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // 全是空串的行当空行跳过：Excel 常在末尾留一行空行，插进去就是一条全 NULL 的记录
    if (row.some((c) => c !== "")) records.push(row);
    else blank += 1;
    row = [];
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      continue;
    }
    if (ch === "\r") {
      // CRLF：由 \n 那一支收尾；单独的 CR 也当换行
      if (body[i + 1] === "\n") continue;
      pushRow();
      continue;
    }
    if (ch === "\n") {
      pushRow();
      continue;
    }
    field += ch;
  }
  // 文件不以换行结尾时，最后一个字段/行还在缓冲里
  if (field !== "" || row.length > 0) pushRow();

  const headers = (records.shift() ?? []).map((h) => h.trim());
  // 表头本身也算一行（失败行号是按文件行数说的，不是按数据行）
  return { headers, rows: records, delimiter, lineCount: records.length + 1, blankLines: blank };
}

/**
 * 表头与目标列的自动映射：同名列（忽略大小写、下划线、空格）直接对上。
 *
 * 只做"看起来就是同一列"的那部分，剩下的留给用户手点——猜错列比不猜更危险
 * （把名字写进日期列，插进去就是一串脏数据）。
 */
export function autoMap(headers: string[], cols: { name: string }[]): number[] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
  return headers.map((h) => {
    const k = norm(h);
    if (!k) return -1;
    const i = cols.findIndex((c) => norm(c.name) === k);
    return i;
  });
}

/**
 * 按字节解码 CSV 文本。Excel 中文环境默认导出的「CSV（逗号分隔）」是 GBK，
 * 直接按 UTF-8 读会把整列中文变成 �——用户看到的只是「乱码」，却未必知道要回去改导出格式。
 * BOM 优先，其次严格 UTF-8，解不动就退回 GB18030（GBK 的超集）：两者都是逐字映射，不会漏字。
 */
export async function decodeCsvBytes(f: Blob): Promise<{ text: string; encoding: string }> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const has = (n: number) => bytes.length >= n;
  if (has(3) && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "UTF-8" };
  }
  if (has(2) && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "UTF-16LE" };
  }
  if (has(2) && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "UTF-16BE" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("gb18030").decode(bytes), encoding: "GB18030" };
  }
}
