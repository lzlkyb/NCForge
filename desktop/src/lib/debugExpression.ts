// 从源码行里取出「光标所在的表达式」，给调试悬停求值用。
//
// 不追求完整 Java 语法：只认标识符、点、方法调用括号、下标、字符串字面量这类
// 连续片段。遇到空白、运算符、逗号、分号就停——把 `int a = foo(bar);` 整行丢给
// 调试适配器只会得到语法错误，悬停提示适得其反。
//
// 纯函数，便于单测；列号与 Monaco 一致（1 基）。

const KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class",
  "const", "continue", "default", "do", "double", "else", "enum", "extends", "final",
  "finally", "float", "for", "goto", "if", "implements", "import", "instanceof", "int",
  "interface", "long", "native", "new", "package", "private", "protected", "public",
  "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this",
  "throw", "throws", "transient", "try", "void", "volatile", "while", "true", "false",
  "null", "var", "record", "yield",
]);

/** 表达式的最大长度：再长基本不是「悬停一个词」，而是整段代码被吞进来了。 */
const MAX_EXPR = 200;

const isWord = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);

/** 表达式内部允许的字符（不跨空格与运算符）。 */
const isInner = (ch: string): boolean => isWord(ch) || ch === "." || ch === "(" || ch === ")" ||
  ch === "[" || ch === "]" || ch === '"' || ch === "'";

function balanced(text: string): boolean {
  let paren = 0;
  let bracket = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket--;
    if (paren < 0 || bracket < 0) return false;
  }
  return paren === 0 && bracket === 0 && quote === null;
}

/**
 * 取光标所在的表达式；判断不出一个有意义的表达式时返回 null。
 *
 * `column` 是 1 基光标列：光标可能停在标识符中间，也可能正好在词尾。
 */
export function expressionAt(line: string, column: number): string | null {
  if (!line) return null;
  const idx = Math.min(Math.max(column - 1, 0), line.length);
  if (!isInner(line[idx] ?? "") && idx > 0 && !isInner(line[idx - 1] ?? "")) return null;
  // 光标落在空格/运算符上时，优先取左边紧邻的表达式（IDE 也是这个手感）
  const anchor = isInner(line[idx] ?? "") ? idx : idx - 1;
  if (anchor < 0 || !isInner(line[anchor])) return null;

  let start = anchor;
  while (start > 0 && isInner(line[start - 1])) start--;
  let end = anchor + 1;
  while (end < line.length && isInner(line[end])) end++;

  let expr = line.slice(start, end).trim();
  // 去掉两侧的调用点/数组括号（光标停在外层时常见）
  while (expr.endsWith(".")) expr = expr.slice(0, -1);
  // 单字符变量（i / e / x）在 NC 代码里很常见，不能因为短就丢掉；
  // 纯数字与纯字符串字面量在下面单独排除。
  if (expr.length === 0 || expr.length > MAX_EXPR) return null;
  if (!balanced(expr)) return null;
  if (KEYWORDS.has(expr.toLowerCase())) return null;
  // 纯数字或纯字符串字面量没必要求值
  if (/^[0-9.]+$/.test(expr)) return null;
  if (/^["'][^"']*["']$/.test(expr)) return null;
  return expr;
}
