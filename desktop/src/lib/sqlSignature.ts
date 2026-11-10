import type { ProcArguments, ProcOverload } from "./dbApi";

/**
 * SQL 签名帮助的纯逻辑：从光标前的文本判断「正在写哪个过程的第几个参数」，以及
 * 多个重载里该显示哪一个。Monaco 的接线在 `sqlProviders.ts`。
 *
 * 只做一件事：给 `pickStatement` 拿到的当前语句 + 光标偏移，算出调用上下文。
 * 解析不出（不在括号里、括号前不是标识符、是 `in (1,2,3)` 这种关键字括号）就返回 null，
 * 编辑器不弹提示——宁可不提示，也不要弹一个「(1,2,3) 的第 1 个参数」的错误签名。
 */

/** 光标前最多扫多少字符。超出就只看尾部：签名帮助只在 `(` / `,` 触发，长脚本下别每次全文扫。 */
const MAX_SCAN = 8000;

/** 括号前不可能是过程名的关键字：`in (...)` / `values (...)` / `exists (...)` 之类。 */
const NOT_CALL = new Set([
  "in", "exists", "values", "and", "or", "not", "where", "on", "select", "from", "join", "having",
  "when", "then", "else", "case", "returning", "into", "between", "like", "is", "as", "by", "set",
]);

export interface CallContext {
  /** 调用名，可能是 `proc` 或 `pkg.proc`（原样保留大小写）。 */
  name: string;
  /** 第几个参数，从 0 开始（按深度 1 的逗号数算）。 */
  argIndex: number;
}

/**
 * 从光标前的文本算出调用上下文。
 *
 * 做法：正向扫一遍（跳过字符串与注释）维护括号栈，扫描结束时栈顶就是那个还没闭合的 `(`；
 * 再取它前面的标识符链作为过程名，最后数它之后深度 0 的逗号。
 */
export function callContext(before: string): CallContext | null {
  const text = before.length > MAX_SCAN ? before.slice(before.length - MAX_SCAN) : before;
  const stack: number[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      // 单引号字符串：'' 是转义，直接跳过一对
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "(") stack.push(i);
    else if (c === ")") stack.pop();
    i++;
  }
  const open = stack.length > 0 ? stack[stack.length - 1] : undefined;
  if (open === undefined) return null;

  const head = text.slice(0, open);
  const m = /([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)*)\s*$/.exec(head);
  if (!m) return null;
  const name = m[1];
  // `in (` 的 `in` 是关键字不是函数；`pkg.proc` 的最后一段才可能是关键字
  if (NOT_CALL.has(name.split(".").pop()!.toLowerCase())) return null;

  return { name, argIndex: topLevelCommas(text.slice(open + 1)) };
}

/** 数一段文本里「深度 0」的逗号（嵌套括号里的逗号不算，字符串与注释里的也不算）。 */
function topLevelCommas(text: string): number {
  let depth = 0;
  let n = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    // 注释也要跳过：`-- )` 里的右括号不能把深度算成负的，否则后面真正的逗号就不计数了
    if (c === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) n++;
    i++;
  }
  return n;
}

/**
 * 选哪个重载。
 *
 * - 有「第 argIndex 个参数存在」的：取其中**参数最少**的。`proc(a)` 与
 *   `proc(a, b default)` 两个重载，写 `proc(` 时该提示短的——长的那条后面是可选参数。
 * - 参数写超了（没有够用的）：取**参数最多**的，至少能看到边界在哪。
 */
export function pickOverload(overloads: ProcOverload[], argIndex: number): ProcOverload | null {
  if (overloads.length === 0) return null;
  const fitting = overloads.filter((o) => o.args.length > argIndex);
  if (fitting.length > 0) {
    return fitting.reduce((best, cur) => (cur.args.length < best.args.length ? cur : best));
  }
  return overloads.reduce((best, cur) => (cur.args.length > best.args.length ? cur : best));
}

/** 签名文本：`PROC(P_X NUMBER, P_Y VARCHAR2 DEFAULT)`。 */
export function signatureLabel(name: string, o: ProcOverload): string {
  const args = o.args.map(parameterLabel).join(", ");
  // name 可能已经写成 `pkg.proc`，别再拼一次包名成 `pkg.pkg.proc`
  const head = o.package && !name.includes(".") ? `${o.package}.${name}` : name;
  return `${head}(${args})${o.returns ? ` RETURN ${o.returns}` : ""}`;
}

/** 单个参数的展示文案（Monaco 的参数说明）。 */
export function parameterLabel(a: ProcOverload["args"][number]): string {
  return `${a.name || "?"} ${a.inOut !== "IN" ? `${a.inOut} ` : ""}${a.type}${a.defaulted ? " DEFAULT" : ""}`;
}

/** 接口返回的空壳（查不到过程）判断。 */
export function hasOverloads(data: ProcArguments | null | undefined): data is ProcArguments {
  return !!data && Array.isArray(data.overloads) && data.overloads.length > 0;
}
