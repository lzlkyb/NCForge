import { blankLiterals } from "./javaModel";
import { javaTreeMembers } from "./javaTreeMembers";

export interface JavaRunDeclaration {
  kind: "type" | "method"; name: string; binaryName: string;
  start: number; end: number; line: number; column: number; depth: number; test: boolean;
}

/** Resolve enclosing types from outline parents; binary names use `$` for nested Java classes. */
export function javaRunDeclarations(text: string): JavaRunDeclaration[] {
  const code = blankLiterals(text), rows = javaTreeMembers("run-target", text);
  const starts = [0], braceEnds = new Map<number, number>(), braces: number[] = [], boundaries = [0];
  let parens = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n") starts.push(i + 1);
    if (code[i] === "(") parens++;
    if (code[i] === ")") parens = Math.max(0, parens - 1);
    if (code[i] === "{") braces.push(i);
    if (code[i] === "}" && braces.length) braceEnds.set(braces.pop()!, i);
    // Annotation arguments may contain braces and semicolons inside literals: they remain in the header.
    if (!parens && /[;{}]/.test(code[i])) boundaries.push(i + 1);
  }
  const packageName = /\bpackage\s+([\w.]+)\s*;/.exec(code)?.[1] ?? "";
  const types = new Map(rows.filter(row => [5, 10, 11, 101, 102].includes(row.kind)).map(row => [row.id, row]));
  const endOf = (offset: number) => {
    let depth = 0;
    for (let i = offset; i < code.length; i++) {
      if (code[i] === "(") depth++;
      if (code[i] === ")") depth = Math.max(0, depth - 1);
      if (depth) continue;
      if (code[i] === ";") return i + 1;
      if (code[i] === "{") return (braceEnds.get(i) ?? i) + 1;
    }
    return offset;
  };
  return rows.filter(row => types.has(row.id) || row.kind === 6).map(row => {
    const offset = starts[row.line - 1] + row.column - 1;
    let low = 0, high = boundaries.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (boundaries[mid] <= offset) low = mid; else high = mid; }
    const boundary = boundaries[low], first = boundary + code.slice(boundary, offset).search(/\S/);
    const lineStart = code.lastIndexOf("\n", first - 1) + 1;
    // Include indentation on the declaration line, but never preceding blank/comment-only lines.
    const start = code.slice(lineStart, first).trim() ? first : lineStart, names: string[] = [];
    let owner = types.get(types.has(row.id) ? row.id : row.parent);
    while (owner) { names.unshift(owner.name); owner = types.get(owner.parent); }
    return {
      kind: types.has(row.id) ? "type" as const : "method" as const,
      name: row.name.split("(")[0], binaryName: [packageName, names.join("$")].filter(Boolean).join("."),
      start, end: endOf(offset), line: row.line, column: row.column, depth: row.depth,
      test: row.kind === 6 && /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest)\b/.test(code.slice(start, offset)),
    };
  });
}

export function javaTestLensTargets(text: string): Map<string, string> {
  return new Map(javaRunDeclarations(text).filter(row => row.kind === "method" && row.test)
    .map(row => [`${row.line}:${row.column}`, `${row.binaryName}#${row.name}`]));
}
