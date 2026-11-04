import { aliasMap } from "./sqlComplete";

/**
 * 找出 SQL 里哪些词是「表」，给编辑器的 Ctrl+点击 跳转用（对标 PL/SQL Developer：
 * 按住 Ctrl 点 SQL 窗口里的表名，直接看这张表的定义）。
 *
 * 纯文本判断，不发请求。三件事同时成立才算一个表名：
 * 1) 不在注释或字符串里——先掩码成空格，下标仍对得上原文（`maskSql`）；
 * 2) 不是限定名的前半段（`sys.bd_material` 里的 `sys`）；
 * 3) 要么紧跟在 from/join/update/into/table/truncate/merge 后面，要么是 `aliasMap`
 *    认得的表名或别名（`from bd_material m` 里点 `m` 也能跳回 bd_material）。
 *
 * 只认单条语句里出现过的表，不猜库里的其它同名对象：`e.pk_used_status` 里的别名
 * 可能指一百张表，乱猜就是误跳。
 */

/** 这些关键字后面紧跟的标识符就是表名（`into` 覆盖 insert/merge）。 */
const PREV_TABLE = new Set(["from", "join", "update", "into", "table", "truncate", "merge"]);

export interface TableLink {
  /** 词在原文里的起止下标（0 基，左闭右开）。 */
  start: number;
  end: number;
  /** 真正要打开的表名（小写，别名已解析成表）。 */
  table: string;
}

/**
 * 把注释与字符串字面量换成空格，**长度与换行都不变**，所以下标可以直接对回原文。
 *
 * 不能像 `sqlComplete.strip` 那样整段删掉：这里要的是「某个位置在不在注释里」，
 * 位置一变就对不上了。
 */
export function maskSql(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  // 块注释与多行字符串里的换行要留着，否则行列关系会错
  const blank = (c: string) => (c === "\n" || c === "\r" ? c : " ");
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "-" && d === "-") {
      while (i < n && sql[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out.push(blank(sql[i]));
        i++;
      }
      if (i < n) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      out.push(" ");
      i++;
      while (i < n) {
        // Oracle 里 '' 与 "" 都是转义，不能当成结束引号
        if (sql[i] === c && sql[i + 1] === c) {
          out.push("  ");
          i += 2;
          continue;
        }
        if (sql[i] === c) {
          out.push(" ");
          i++;
          break;
        }
        out.push(blank(sql[i]));
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/** 全文扫一遍，返回所有可以跳转的表名词及其位置（按出现顺序）。 */
export function tableLinks(sql: string): TableLink[] {
  const masked = maskSql(sql);
  const alias = aliasMap(masked);
  const out: TableLink[] = [];
  const re = /[A-Za-z_][\w$#]*/g;
  let prev = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const word = m[0].toLowerCase();
    const prevWord = prev;
    prev = word;
    // 后面跟点的这一段是 schema 或别名（`sys.xxx`、`m.code`），本身不是表
    if (masked[end] === ".") continue;
    const hit = alias.get(word);
    // 前面带点的是限定名的后一段（`sys.bd_material`）：只有别名表里认得才算
    const byPosition = start > 0 && masked[start - 1] === "." ? null : PREV_TABLE.has(prevWord) ? word : null;
    const table = hit ?? byPosition;
    if (table) out.push({ start, end, table });
  }
  return out;
}
