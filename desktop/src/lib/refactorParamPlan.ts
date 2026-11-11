// 提取参数（受限版）的纯逻辑：表达式能不能搬、改动清单怎么排。
//
// 单独一个文件，理由同 `refactorPlan.ts`：编排那一半要引 Monaco，纯函数跟过去，
// 单测环境没有 window 就一条都跑不起来。
//
// 做法的前提：把方法体里的一个表达式变成新参数，调用点补上同一段文本。
// 只有「表达式搬到调用点仍然成立」才安全——所以这里先用文本规则挡掉明显不行的
// （副作用、方法调用、赋值目标……），语义层面的判断（是不是局部变量、是不是
// static final）交给编排那一半去问 jdt.ls。

/** 窄档：只放字面量与 static final 常量；宽档：再放字段等不依赖方法局部状态的引用。 */
export type ExtractParamScope = "narrow" | "wide";

const KEYWORDS = new Set([
  "true", "false", "null", "instanceof", "int", "long", "short", "byte", "char", "float", "double", "boolean", "void",
]);

/** 把字符串 / 字符字面量的内容抹成空格（引号保留），扫结构字符时不会被引号里的括号、等号干扰。 */
export function maskLiterals(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < s.length && s[i] !== c) {
        if (s[i] === "\\") {
          out += " ";
          i++;
        }
        if (i < s.length) {
          out += s[i] === "\n" ? "\n" : " ";
          i++;
        }
      }
      if (i < s.length) {
        out += c;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 从 `open`（必须是 `(`）起找配对的 `)`，跳过字符串、字符字面量与注释。找不到返回 -1。
 */
export function matchParen(text: string, open: number): number {
  if (text[open] !== "(") return -1;
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** 类声明头（到第一个 `{`）里有没有 extends / implements。 */
export function classHeaderHasSupertype(text: string, classStart: number): boolean {
  const masked = maskLiterals(text.slice(classStart, classStart + 2000));
  const brace = masked.indexOf("{");
  const header = brace < 0 ? masked : masked.slice(0, brace);
  return /\b(extends|implements)\b/.test(header);
}

/** 收窄区间：去掉首尾空白。 */
export function trimRange(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return { start: s, end: e };
}

/**
 * 表达式本身有没有「搬到调用点就会变样」的写法。返回不能提取的原因；null = 文本层面可以。
 */
export function syntaxProblem(expr: string): string | null {
  if (!expr.trim()) return "没有选中表达式";
  if (/\n/.test(expr)) return "请选中单行的表达式";
  const m = maskLiterals(expr);
  if (/->|::/.test(m)) return "含 lambda 或方法引用";
  if (/\+\+|--/.test(m)) return "含自增 / 自减，有副作用";
  if (/[+\-*/%&|^]=|<<=|>>>?=|(^|[^=!<>])=([^=]|$)/.test(m)) return "含赋值，有副作用";
  if (/\bnew\b/.test(m)) return "含 new：每次创建新对象，搬到调用点会改变行为";
  if (/[A-Za-z_$][\w$]*\s*\(/.test(m)) return "含方法调用，可能有副作用";
  if (/\b(this|super)\b/.test(m)) return "含 this / super，搬到调用点指的是别的对象";
  return null;
}

const STRING_RE = /^"(?:[^"\\\n]|\\.)*"$/;
const CHAR_RE = /^'(?:[^'\\\n]|\\.)'$/;
const NUMBER_RE = /^-?(?:0[xX][0-9a-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[lLfFdD]?$/;

/** 字面量的类型；不是字面量（或 null，没有类型）返回 null。 */
export function literalType(expr: string): string | null {
  const e = expr.trim();
  if (STRING_RE.test(e)) return "String";
  if (CHAR_RE.test(e)) return "char";
  if (e === "true" || e === "false") return "boolean";
  if (NUMBER_RE.test(e)) {
    const hex = /^-?0[xX]/.test(e);
    if (/[lL]$/.test(e)) return "long";
    if (!hex && /[fF]$/.test(e)) return "float";
    if (!hex && (/[dD]$/.test(e) || /[.eE]/.test(e))) return "double";
    return "int";
  }
  return null;
}

/** 形如 `A.B.C` 的限定名（常量引用的典型写法）。 */
export function isQualifiedName(expr: string): boolean {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(expr.trim());
}

/** 表达式里「不是成员选择」的标识符（`a.b` 只取 `a`）及其在表达式内的偏移。 */
export function leadingIdentifiers(expr: string): { name: string; offset: number }[] {
  const m = maskLiterals(expr);
  const out: { name: string; offset: number }[] = [];
  const re = /[A-Za-z_$][\w$]*/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(m))) {
    if (KEYWORDS.has(hit[0])) continue;
    // 数字里的 `e`、`L` 之类：前一个字符是数字或点说明它在数字字面量里
    const prev = hit.index > 0 ? m[hit.index - 1] : "";
    if (/[\d]/.test(prev)) continue;
    const before = m.slice(0, hit.index).trimEnd();
    if (before.endsWith(".")) continue;
    out.push({ name: hit[0], offset: hit.index });
  }
  return out;
}

/** 选区紧邻处是不是赋值 / 自增的目标（把它换成参数名会得到非法代码）。 */
export function isAssignmentTarget(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 4), start);
  if (/(\+\+|--)\s*$/.test(before)) return true;
  const after = text.slice(end, end + 6);
  return /^\s*(\+\+|--|[+\-*/%&|^]=|<<=|>>>?=|=(?!=))/.test(after);
}

/** 挑一个不会和文件里任何已有标识符重名的参数名（和字段重名会改变方法体里字段引用的含义）。 */
export function uniqueParamName(base: string, fileText: string): string {
  let name = /^[A-Za-z_$][\w$]*$/.test(base) ? base : "param";
  name = name[0].toLowerCase() + name.slice(1);
  if (KEYWORDS.has(name) || ["class", "new", "this", "super", "return", "default"].includes(name)) name = "param";
  const used = (n: string) => new RegExp(`(^|[^\\w$])${n.replace(/\$/g, "\\$")}($|[^\\w$])`).test(fileText);
  if (!used(name)) return name;
  for (let i = 2; i < 100; i++) {
    if (!used(`${name}${i}`)) return `${name}${i}`;
  }
  return `${name}_`;
}

/**
 * 从「提取变量」返回的编辑里读出表达式类型。
 *
 * 提取变量会插入一行 `Type name = expr;`，类型和 jdt.ls 建议的变量名都在里面。
 * 这个结果只用来读类型，绝不会被应用。
 */
export function parseExtractedDeclaration(newTexts: string[]): { type: string; name: string } | null {
  const re = /^\s*(?:final\s+)?([A-Za-z_$][\w$.<>,?&\s[\]]*?)\s+([A-Za-z_$][\w$]*)\s*=/;
  for (const t of newTexts) {
    const m = re.exec(t);
    if (!m) continue;
    const type = m[1].replace(/\s+/g, " ").trim();
    if (!type || /[{};]/.test(type)) continue;
    return { type, name: m[2] };
  }
  return null;
}

/** 悬停文本（markdown 拼起来的）里是否声明为 static final。 */
export function hoverIsStaticFinal(markdown: string): boolean {
  return /\bstatic\b/.test(markdown) && /\bfinal\b/.test(markdown);
}

export interface TextEditByOffset {
  start: number;
  end: number;
  text: string;
}

export interface ParamPlanInput {
  text: string;
  /** 选中的表达式（已去首尾空白）在原文里的区间。 */
  exprStart: number;
  exprEnd: number;
  name: string;
  type: string;
  methodName: string;
  /** 声明里 `(` 的偏移。 */
  openParen: number;
  /** 调用点里方法名起点的偏移（原文，不含声明自身）。 */
  calls: number[];
}

export type ParamPlan =
  | { ok: true; edits: TextEditByOffset[]; nameOffset: number }
  | { ok: false; reason: string };

/** 在 `(`…`)` 的参数区里找到「追加一个参数」的插入点。 */
function appendPoint(
  text: string,
  open: number,
  close: number,
): { at: number; hasItems: boolean } {
  const inner = trimRange(text, open + 1, close);
  if (inner.start === inner.end) return { at: close, hasItems: false };
  return { at: inner.end, hasItems: true };
}

/** 声明与调用点的改动清单。全部以原文偏移表示，互不重叠。 */
export function planParameterEdits(p: ParamPlanInput): ParamPlan {
  const { text } = p;
  const exprText = text.slice(p.exprStart, p.exprEnd);
  const declClose = matchParen(text, p.openParen);
  if (declClose < 0) return { ok: false, reason: "找不到方法声明的右括号" };
  if (p.exprStart <= declClose) return { ok: false, reason: "选中的表达式不在方法体里" };
  const decl = appendPoint(text, p.openParen, declClose);
  if (/\.\.\./.test(text.slice(p.openParen, declClose))) {
    return { ok: false, reason: "方法已有可变参数（...），新参数不能排在它后面" };
  }

  const edits: TextEditByOffset[] = [];
  const declText = `${decl.hasItems ? ", " : ""}${p.type} ${p.name}`;
  edits.push({ start: decl.at, end: decl.at, text: declText });
  edits.push({ start: p.exprStart, end: p.exprEnd, text: p.name });

  const seen = new Set<number>();
  for (const nameStart of p.calls) {
    if (seen.has(nameStart)) continue;
    seen.add(nameStart);
    if (text.slice(nameStart, nameStart + p.methodName.length) !== p.methodName) {
      return { ok: false, reason: "有一处引用的位置对不上方法名，已放弃" };
    }
    let i = nameStart + p.methodName.length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "(") return { ok: false, reason: "有引用不是普通调用（方法引用等），无法补参数" };
    const close = matchParen(text, i);
    if (close < 0) return { ok: false, reason: "有调用的括号没配对上，已放弃" };
    const args = appendPoint(text, i, close);
    edits.push({ start: args.at, end: args.at, text: `${args.hasItems ? ", " : ""}${exprText}` });
  }

  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let k = 1; k < edits.length; k++) {
    if (edits[k].start < edits[k - 1].end || (edits[k].start === edits[k - 1].start && edits[k].end === edits[k - 1].end)) {
      return { ok: false, reason: "改动位置互相重叠，已放弃" };
    }
  }

  // 新参数名在结果文本里的偏移：声明插入点之前所有改动造成的位移 + 声明插入文本里名字的位置
  let shift = 0;
  for (const e of edits) {
    if (e.start < decl.at) shift += e.text.length - (e.end - e.start);
  }
  const nameOffset = decl.at + shift + (decl.hasItems ? 2 : 0) + p.type.length + 1;
  return { ok: true, edits, nameOffset };
}

/** 把偏移改动应用到字符串（单测与预检用；编辑器里走 model）。 */
export function applyOffsetEdits(text: string, edits: TextEditByOffset[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
