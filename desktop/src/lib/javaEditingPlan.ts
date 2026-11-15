import { blankLiterals } from "./javaModel";

export interface JavaTextPlan { start: number; end: number; text: string; }

export const POSTFIX_TEMPLATES = [
  { key: "sout", detail: "打印表达式", body: (value: string) => `System.out.println(${value});$0` },
  { key: "null", detail: "表达式为空时执行", body: (value: string) => `if (${value} == null) {\n\t$0\n}` },
  { key: "notnull", detail: "表达式非空时执行", body: (value: string) => `if (${value} != null) {\n\t$0\n}` },
  { key: "nn", detail: "表达式非空时执行", body: (value: string) => `if (${value} != null) {\n\t$0\n}` },
  { key: "if", detail: "将布尔表达式包成条件", body: (value: string) => `if (${value}) {\n\t$0\n}` },
  { key: "not", detail: "将布尔表达式取反", body: (value: string) => `!(${value})$0` },
  { key: "return", detail: "返回表达式", body: (value: string) => `return ${value};$0` },
  { key: "throw", detail: "抛出异常表达式", body: (value: string) => `throw ${value};$0` },
] as const;

/** 仅截取完整表达式，不能把赋值左侧、注释或字符串当成后缀目标。 */
export function postfixExpression(line: string, column: number): { expression: string; startColumn: number; prefix: string; statement: boolean } | null {
  const before = line.slice(0, column - 1), suffix = /\.([a-z]*)$/.exec(before);
  if (!suffix) return null;
  const dot = suffix.index, code = blankLiterals(before);
  if (code.slice(dot) !== before.slice(dot)) return null;
  let start = dot, parens = 0, brackets = 0;
  for (let i = dot - 1; i >= 0; i--) {
    const ch = code[i];
    if (ch === ")") parens++;
    else if (ch === "]") brackets++;
    else if (ch === "(") { if (!parens) break; parens--; }
    else if (ch === "[") { if (!brackets) break; brackets--; }
    if (!parens && !brackets && (/[;{},]/.test(ch) || ch === "=" && code[i - 1] !== "=" && code[i + 1] !== "=" && !/[!<>]/.test(code[i - 1] ?? ""))) break;
    start = i;
  }
  const raw = before.slice(start, dot), leading = raw.length - raw.trimStart().length;
  start += leading;
  let expression = before.slice(start, dot).trim();
  const keyword = /^(?:return|throw)\s+/.exec(expression);
  if (keyword) { start += keyword[0].length; expression = expression.slice(keyword[0].length); }
  if (!expression || parens || brackets || /^(?:public|private|protected|class|interface|import|package)\b/.test(expression)) return null;
  if (/^(?!new\b)[\w.$<>[\]]+\s+[\w$]+$/.test(expression)) return null;
  const beforeExpression = before.slice(0, start).trimEnd();
  return { expression, startColumn: start + 1, prefix: suffix[1], statement: !beforeExpression || /[;{}]$/.test(beforeExpression) };
}

function splitParameters(value: string): string[] {
  const items: string[] = []; let start = 0, depth = 0;
  for (let i = 0; i < value.length; i++) {
    if ("<([".includes(value[i])) depth++;
    else if (">)]".includes(value[i])) depth--;
    else if (value[i] === "," && !depth) { items.push(value.slice(start, i).trim()); start = i + 1; }
  }
  if (value.slice(start).trim()) items.push(value.slice(start).trim());
  return items;
}

/** 在当前声明前生成文档标签，不臆造业务说明，也不覆盖已有 JavaDoc。 */
export function javaDocPlan(text: string, offset: number): JavaTextPlan | null {
  const code = blankLiterals(text);
  let start = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  while (start > 0) {
    const previousStart = text.lastIndexOf("\n", start - 2) + 1;
    if (!/^\s*@[\w.]+(?:\([^]*\))?\s*$/.test(text.slice(previousStart, start))) break;
    start = previousStart;
  }
  if (/^\s*\/\*\*/.test(text.slice(start))) return null;
  const preceding = text.slice(0, start).trimEnd();
  if (preceding.endsWith("*/")) return null;
  const rest = code.slice(start), end = rest.search(/[;{]/);
  if (end < 0 || end > 4000) return null;
  let declaration = rest.slice(0, end).replace(/@[\w.]+(?:\([^)]*\))?\s*/g, "").trim();
  const assignment = declaration.indexOf("=");
  if (assignment >= 0 && (declaration.indexOf("(") < 0 || assignment < declaration.indexOf("("))) declaration = declaration.slice(0, assignment).trim();
  if (!declaration || /^(?:if|for|while|switch|return|throw|new|else)\b/.test(declaration)) return null;
  const indent = /^\s*/.exec(text.slice(start).split("\n")[0])?.[0] ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const tags: string[] = [];
  const type = /\b(class|interface|enum|record)\s+[\w$]+(?:\s*<([^>]+)>)?/.exec(declaration);
  if (type) {
    if (type[2]) tags.push(...splitParameters(type[2]).map(param => `@param <${param.split(/\s/)[0]}>`));
  } else {
    const method = /([\w$]+)\s*\(([^]*)\)\s*(?:throws\s+([^]+))?$/.exec(declaration);
    if (method) {
      const prefix = declaration.slice(0, method.index).replace(/\b(public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\b/g, "").trim();
      if (prefix.includes("=")) return null;
      const generics = /^<([^>]+)>/.exec(prefix);
      if (generics) tags.push(...splitParameters(generics[1]).map(param => `@param <${param.split(/\s/)[0]}>`));
      for (const param of splitParameters(method[2])) {
        const name = /([\w$]+)\s*(?:\[\s*\])*\s*$/.exec(param)?.[1];
        if (!name) return null;
        tags.push(`@param ${name}`);
      }
      const returnType = prefix.replace(/^<[^>]+>\s*/, "").trim();
      if (returnType && returnType !== "void") tags.push("@return");
      if (method[3]) tags.push(...splitParameters(method[3]).map(exception => `@throws ${exception}`));
    } else if (!/^(?:(?:public|private|protected|static|final|transient|volatile)\s+)*[\w.$<>?, [\]]+\s+[\w$]+(?:\s*=.*)?$/.test(declaration)) return null;
  }
  const lines = ["/**", " *", ...tags.map(tag => ` * ${tag}`), " */"];
  return { start, end: start, text: lines.map(line => indent + line).join(eol) + eol };
}

export function completeJavaStatement(line: string, indentUnit: string): string | null {
  const trimmed = line.trimEnd(), code = blankLiterals(trimmed), clean = code.trim();
  if (!clean || /[;{}]$/.test(clean) || /^(?:package|import|class|interface|enum)\b/.test(clean)) return null;
  let quote = "";
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (quote && char === "\\") { i++; continue; }
    if (quote && char === quote) quote = "";
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && char === "/" && /[/*]/.test(trimmed[i + 1] ?? "")) return null;
  }
  if (quote) return null;
  // 行尾注释属于原文，不能在它后面追加分号使代码仍然缺少结束符。
  if (trimmed !== code && /(?:\/\/|\/\*)/.test(trimmed.slice(code.trimEnd().length))) return null;
  const stack: string[] = [];
  for (const character of code) {
    if (character === "(" || character === "[") stack.push(character);
    else if (character === ")" || character === "]") { if (stack.pop() !== (character === ")" ? "(" : "[")) return null; }
  }
  const closed = trimmed + stack.reverse().map(character => character === "(" ? ")" : "]").join("");
  if (/^(?:if|for|while|switch|catch|synchronized)\s*\(/.test(clean) || /^(?:try|else|finally)$/.test(clean)) {
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    return `${closed} {\n${indent}${indentUnit}\n${indent}}`;
  }
  return `${closed};`;
}

const JAVA_LANG = new Set("String Object Boolean Byte Short Integer Long Float Double Character Number Class System Math Thread Throwable Exception RuntimeException Error StringBuilder StringBuffer Iterable Comparable Enum Void Override Deprecated SuppressWarnings FunctionalInterface".split(" "));

export function pastedJavaTypes(text: string, pasted: string): string[] {
  const code = blankLiterals(pasted), known = new Set<string>(JAVA_LANG);
  for (const match of blankLiterals(text).matchAll(/\b(?:class|interface|enum|record)\s+([\w$]+)|\bimport\s+(?!static)([\w.]+)\s*;/g)) known.add(match[1] ?? match[2].split(".").pop()!);
  const out = new Set<string>();
  for (const match of code.matchAll(/\b[A-Z][\w$]*\b/g)) {
    const before = code.slice(0, match.index).trimEnd();
    if (!before.endsWith(".") && !known.has(match[0])) out.add(match[0]);
  }
  return [...out].slice(0, 20);
}

export function javaImportPlan(text: string, names: string[]): JavaTextPlan | null {
  const code = blankLiterals(text), existing = [...code.matchAll(/\bimport\s+(?!static)([\w.$]+)\s*;/g)];
  const packageName = /\bpackage\s+([\w.]+)\s*;/.exec(code)?.[1];
  const imports = new Map(existing.map(match => [match[1].split(".").pop()!, match[1]]));
  const additions: string[] = [];
  for (const name of [...new Set(names)]) {
    if (!/^[\w$]+(?:\.[\w$]+)+$/.test(name)) throw new Error("导入类名不合法");
    const simple = name.split(".").pop()!, current = imports.get(simple);
    if (current && current !== name) throw new Error(`${simple} 已导入 ${current}，请先解决同名类冲突`);
    const importedPackage = name.slice(0, name.lastIndexOf("."));
    if (current === name || importedPackage === "java.lang" || importedPackage === packageName) continue;
    imports.set(simple, name); additions.push(name);
  }
  if (!additions.length) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const last = existing[existing.length - 1], pkg = /\bpackage\s+[\w.]+\s*;/.exec(code);
  const offset = last ? last.index! + last[0].length : pkg ? pkg.index! + pkg[0].length : code.search(/\S/);
  const at = Math.max(0, offset);
  return { start: at, end: at, text: `${at ? eol : ""}${additions.sort().map(name => `import ${name};`).join(eol)}${last ? "" : eol}` };
}
