/**
 * D2：从改动行里抽出代码引用的表名，交给已有表结构缓存核对。
 *
 * 不重造表结构查询：`tableLookup.ts` + `tableHover.ts` 已经有全局悬停卡片
 * （含「在数据库中打开」），补丁页 `TableCheck` 也已有出包前核对。这里只补
 * 它俩都没有的一件事——**「AI 刚改的这几行」引用了哪些表、哪些在库里查不到**。
 *
 * 边界：这是「代码引用的表结构核对」，不是 14 项不做里的「表数据 diff」。
 * 提取是纯文本规则（NC 的 SQL 常量基本写在一行 Java 字符串里），不做语法解析。
 */
import { getTableLookup } from "./tableLookup";

export interface TableRef {
  line: number;
  name: string;
}

export interface TableCheckItem extends TableRef {
  /** null = 当前没有可用的表结构缓存（没连库/没同步），此时不下「不存在」的结论。 */
  exists: boolean | null;
}

/** SQL 关键字后跟的表名，以及 NC 常见的 md_/bd_/so_/po_/sm_ 前缀表名。 */
const AFTER_KEYWORD = /\b(?:from|join|into|update|table)\s+([a-z][\w$#]*)/gi;
const NC_TABLE = /\b((?:md|bd|so|po|sm|ar|ap|ia|ic|pu|wh)_[\w$#]+)\b/gi;

/** 从一批「行文本 + 行号」里抽表名候选；纯函数，可单测。 */
export function tableRefsInChangedLines(rows: readonly { line: number; text: string }[]): TableRef[] {
  const out: TableRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // 只看字符串字面量：Java 标识符 String pam_equip 不是表名（与 tableHover 同口径）
    const literals = row.text.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g) ?? [];
    // 没有字符串字面量就整行跳过：NC 的 SQL 常量都在 Java 字符串里，
    // 回退到整行会把 private String md_fake; 这种标识符误报成表名。
    if (literals.length === 0) continue;
    const text = literals.join(" ");
    for (const re of [AFTER_KEYWORD, NC_TABLE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const name = m[1];
        const key = `${row.line}|${name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ line: row.line, name });
      }
    }
  }
  return out;
}

/** 拿现有表结构缓存判存在性。没有缓存一律返回 null，不误报「表不存在」。 */
export function checkChangedTables(refs: readonly TableRef[]): TableCheckItem[] {
  const lookup = getTableLookup();
  return refs.map((r) => ({ ...r, exists: lookup ? lookup.has(r.name) : null }));
}
