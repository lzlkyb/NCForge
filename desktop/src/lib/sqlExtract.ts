/**
 * 从 Java 代码里把拼接的 SQL 「拼回来」（Java 编辑器右键 → 在数据库中执行此 SQL）。
 *
 * 只做静态拼接，绝不执行任何 Java 代码：
 * - 光标所在行找到拼 SQL 的变量（`sql.append(...)` / `sql += ...` / `String sql = "..."`），
 *   向上向下收集同一个变量的连续拼接行；
 * - 字符串字面量按顺序接起来；夹在中间的 Java 表达式变成 `:参数名`，执行前由用户填值；
 * - 拼不出变量时退回「光标所在的这条 Java 语句」。
 */

export interface ExtractParam {
  name: string;
  /** 原样的 Java 表达式（对话框里提示用）。 */
  expr: string;
}

export interface Extracted {
  sql: string;
  params: ExtractParam[];
  /** 拼了哪几行（从 1 开始）。 */
  startLine: number;
  endLine: number;
  /** 字符串字面量段数。 */
  pieces: number;
}

type Part = { lit: true; v: string } | { lit: false; v: string };

/** 把一段 Java 代码切成「字面量 / 其它代码」交替的序列（注释丢掉）。 */
function scan(code: string): Part[] {
  const parts: Part[] = [];
  let gap = "";
  let i = 0;
  const n = code.length;
  const flush = () => {
    parts.push({ lit: false, v: gap });
    gap = "";
  };
  while (i < n) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const e = code.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '"' || (c === "'" && code[i + 2] === "'") || (c === "'" && code[i + 1] === "\\" && code[i + 3] === "'")) {
      const q = c;
      let v = "";
      let j = i + 1;
      while (j < n && code[j] !== q) {
        if (code[j] === "\\" && j + 1 < n) {
          const e = code[j + 1];
          v += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "" : e;
          j += 2;
        } else {
          v += code[j];
          j++;
        }
      }
      flush();
      parts.push({ lit: true, v });
      i = j + 1;
      continue;
    }
    gap += c;
    i++;
  }
  flush();
  return parts;
}

/** 去掉拼接用的「胶水」，剩下的就是夹在字面量之间的 Java 表达式（可能为空）。 */
export function gapExpr(gap: string): string {
  let s = gap
    .replace(/(?:final\s+)?(?:String|StringBuilder|StringBuffer)\s+\w+\s*=/g, " ")
    .replace(/new\s+String(?:Builder|Buffer)\s*\(/g, " ")
    .replace(/\b\w+\s*\.\s*append\s*\(/g, " ")
    .replace(/\.\s*append\s*\(/g, " ")
    .replace(/(^|[;{}\s])\w+\s*\+?=(?!=)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
  // 反复剪掉两端的连接符与不配对的括号
  for (let guard = 0; guard < 50; guard++) {
    const open = (s.match(/\(/g) ?? []).length;
    const close = (s.match(/\)/g) ?? []).length;
    const before = s;
    s = s.replace(/^[\s+;,]+/, "").replace(/[\s+;,]+$/, "");
    if (s.startsWith(")") && close > open) s = s.slice(1);
    else if (s.endsWith(")") && close > open) s = s.slice(0, -1);
    else if (s.endsWith("(")) s = s.slice(0, -1);
    else if (s.startsWith("(") && open > close) s = s.slice(1);
    if (s === before) break;
  }
  return s;
}

/** 表达式 → 参数名：`vo.getPk_org()` → `pk_org`，`pkOrg` → `pkOrg`。 */
export function paramName(expr: string): string {
  const m = /([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s*$/.exec(expr);
  let name = m ? m[1] : "p";
  if (/^get[A-Z_]/.test(name) && name.length > 3) {
    name = name.slice(3).replace(/^_/, "");
    name = name[0].toLowerCase() + name.slice(1);
  }
  return name || "p";
}

function joinParts(parts: Part[]): { sql: string; params: ExtractParam[]; pieces: number } {
  let sql = "";
  const params: ExtractParam[] = [];
  let pieces = 0;
  for (const p of parts) {
    if (p.lit) {
      sql += p.v;
      pieces++;
      continue;
    }
    const expr = gapExpr(p.v);
    if (!expr) continue;
    let found = params.find((x) => x.expr === expr);
    if (!found) {
      let name = paramName(expr);
      const base = name;
      for (let k = 2; params.some((x) => x.name === name); k++) name = `${base}${k}`;
      found = { name, expr };
      params.push(found);
    }
    sql += `:${found.name}`;
  }
  return { sql: sql.replace(/[ \t]+/g, " ").trim(), params, pieces };
}

/** 光标所在行里拼 SQL 的变量名。 */
function builderVar(line: string): string | null {
  return (
    /\b(\w+)\s*\.\s*append\s*\(/.exec(line)?.[1] ??
    /\b(\w+)\s*\+=/.exec(line)?.[1] ??
    /\b(\w+)\s*=\s*(?:new\s+String(?:Builder|Buffer)|")/.exec(line)?.[1] ??
    null
  );
}

export function extractSql(text: string, offset: number): Extracted | null {
  const lines = text.split("\n");
  let cur = text.slice(0, offset).split("\n").length - 1;
  if (cur >= lines.length) cur = lines.length - 1;

  // 光标在续行（`+ " where …"` / `.append(...)`）上：往上找到带变量名的那一行
  let v: string | null = null;
  for (let k = cur; k >= Math.max(0, cur - 30) && !v; k--) {
    v = builderVar(lines[k]);
    if (!v && !/^\s*(\+|\.append|")/.test(lines[k]) && k !== cur) break;
  }
  if (!v) return null;
  const esc = v.replace(/\$/g, "\\$");
  const belongs = (l: string) =>
    new RegExp(`\\b${esc}\\s*\\.\\s*append\\s*\\(|\\b${esc}\\s*\\+?=(?!=)`).test(l) || /^\s*(\+|\.append\b|")/.test(l);
  const skippable = (l: string) => /^\s*(\/\/.*)?$/.test(l);

  let a = cur;
  while (a > 0 && (belongs(lines[a - 1]) || skippable(lines[a - 1]))) {
    a--;
    // 初始化那一行就是起点
    if (new RegExp(`\\b${esc}\\s*=\\s*(?:new\\b|")`).test(lines[a])) break;
  }
  let b = cur;
  while (b + 1 < lines.length && (belongs(lines[b + 1]) || skippable(lines[b + 1]))) b++;
  while (a < cur && skippable(lines[a])) a++;
  while (b > cur && skippable(lines[b])) b--;

  // 只保留拼接部分：末行如果是 `sql.toString()` 之类的使用，前面的 belongs 已经排除了
  const code = lines.slice(a, b + 1).join("\n");
  const { sql, params, pieces } = joinParts(scan(code));
  if (!sql || pieces === 0) return null;
  return { sql, params, startLine: a + 1, endLine: b + 1, pieces };
}

/** 把 `:参数` 换成用户填的值（原样插入：引号本来就在 Java 字面量里）。 */
export function fillParams(sql: string, params: ExtractParam[], values: Record<string, string>): string {
  let out = sql;
  for (const p of params) {
    out = out.replace(new RegExp(`:${p.name}\\b`, "g"), values[p.name] ?? "");
  }
  return out;
}
