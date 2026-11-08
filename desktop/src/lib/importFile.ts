import { decodeCsvBytes, parseCsv, type ParsedRows } from "./csvParse";
import { parseJsonRows } from "./jsonRows";
import { isXlsxFile, sheetToRows } from "./xlsxRows";
import { dbApi } from "./dbApi";

/** 选完文件后的统一中间态：三种来源都归成「表头 + 行」再进映射界面。 */
export interface ImportSource {
  rows: ParsedRows;
  /** 给界面看的来源说明：文本类是实际编码，xlsx 是 "XLSX"。 */
  encoding: string;
  /** 读到的工作表名；非 xlsx 为空串。 */
  sheet: string;
}

/**
 * 按扩展名挑解析器。
 *
 * xlsx 必须走后端：它是 zip，浏览器侧没有解压能力（也不该为一次导入拖进一个表格库）。
 * 其余都是文本，但编码规则不同：JSON 一定是 UTF-8，CSV/TSV 得按字节猜 GBK/UTF-8。
 */
export async function readImportFile(f: File): Promise<ImportSource> {
  if (isXlsxFile(f.name)) {
    const out = await dbApi.readXlsx(new Uint8Array(await f.arrayBuffer()));
    return { rows: sheetToRows(out), encoding: "XLSX", sheet: out.sheet };
  }
  if (/\.xls$/i.test(f.name)) {
    // 旧 BIFF 格式压根不是 zip。给明路，别让用户以为是文件坏了
    throw new Error("不支持旧版 .xls：请在 Excel 里另存为 .xlsx 或 CSV 再导入");
  }
  if (/\.json$/i.test(f.name)) {
    return { rows: parseJsonRows(await f.text()), encoding: "UTF-8", sheet: "" };
  }
  const { text, encoding } = await decodeCsvBytes(f);
  return { rows: parseCsv(text), encoding, sheet: "" };
}
