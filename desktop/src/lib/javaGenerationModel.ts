import { blankLiterals, parseJava, type JavaType } from "./javaModel";
import { javaTreeMembers } from "./javaTreeMembers";

/** 生成到光标所在最内层类；文件头光标则选第一个顶层类。 */
export function javaGenerationModel(text: string, line: number, column: number): (JavaType & { baseIndent: string; bodyEndOffset: number }) | null {
  const code = blankLiterals(text), lines = text.split("\n"), offsets = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") offsets.push(i + 1);
  const cursor = (offsets[line - 1] ?? 0) + column - 1;
  const candidates = javaTreeMembers("generation", text).filter(row => [5, 11, 10, 102].includes(row.kind)).map(row => {
    const nameOffset = (offsets[row.line - 1] ?? 0) + row.column - 1;
    const before = code.slice(0, nameOffset), match = /\b(class|interface|enum|record)\s*$/.exec(before);
    const start = match?.index ?? nameOffset, open = code.indexOf("{", nameOffset);
    let end = open, depth = 0;
    for (let i = open; i >= 0 && i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) { end = i; break; }
    }
    return { row, start, end };
  });
  const selected = candidates.filter(candidate => candidate.start <= cursor && cursor <= candidate.end).sort((a, b) => b.row.depth - a.row.depth)[0]
    ?? candidates.find(candidate => candidate.row.depth === 0);
  if (!selected) return null;
  const parsed = parseJava(text.slice(selected.start, selected.end + 1));
  if (!parsed) return null;
  const declarationLine = text.slice(0, selected.start).split("\n").length - 1;
  return { ...parsed, bodyEndLine: parsed.bodyEndLine + declarationLine, bodyEndOffset: selected.end, packageName: /\bpackage\s+([\w.]+)\s*;/.exec(code)?.[1] ?? null,
    baseIndent: /^\s*/.exec(lines[declarationLine])?.[0] ?? "" };
}
