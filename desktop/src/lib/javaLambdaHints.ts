import { blankLiterals } from "./javaModel";
import { contentsToMarkdown } from "./langConvert";

export interface JavaLambdaParameter { name: string; start: number; }

/** Java 8 has implicit lambda parameters but no local `var`: only request their semantic types. */
export function javaLambdaParameters(text: string, start: number, end: number): JavaLambdaParameter[] {
  const code = blankLiterals(text), parameters: JavaLambdaParameter[] = [];
  const pattern = /(?:\(([\s\w$,]*)\)|(?<![\w$])([A-Za-z_$][\w$]*))\s*->/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) && match.index < end && parameters.length < 8) {
    const body = match[1] ?? match[2];
    if (!body.trim() || !body.split(",").every(name => /^[A-Za-z_$][\w$]*$/.test(name.trim()))) continue;
    const at = match.index + (match[1] !== undefined ? 1 : 0), names = /[A-Za-z_$][\w$]*/g;
    let name: RegExpExecArray | null;
    while ((name = names.exec(body)) && parameters.length < 8) {
      const offset = at + name.index;
      if (offset >= start && offset < end) parameters.push({ name: name[0], start: offset });
    }
  }
  return parameters;
}

/** Accept the variable declaration returned by hover, never infer types from expressions ourselves. */
export function javaHoverParameterType(contents: unknown, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`^\\s*(?:final\\s+)?(.+?)\\s+${escaped}(?:\\s*-|\\s*$)`);
  for (const part of contentsToMarkdown(contents)) {
    for (const line of part.split(/\r?\n/)) {
      const match = declaration.exec(line);
      if (!match) continue;
      const type = match[1].trim();
      if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\s*<[\w$.,?<> &[\]]+>)?(?:\s*\[\s*\])*$/.test(type)) return type;
    }
  }
  return null;
}
