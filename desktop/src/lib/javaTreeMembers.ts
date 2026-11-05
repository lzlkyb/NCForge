import { blankLiterals, javaEnumConstant, javaMemberHeader } from "./javaModel";

export interface JavaTreeMember {
  id: string;
  parent: string;
  name: string;
  kind: number;
  depth: number;
  line: number;
  column: number;
  endLine: number;
}

export type TreeMembers = ReadonlyMap<string, { status: "loading" | "error" | "ready"; rows: JavaTreeMember[] }>;

const typeKinds: Record<string, number> = { class: 5, interface: 11, enum: 10, "@interface": 101, record: 102 };

/** Source-only outline for unopened files. The scanner skips comments, literals and method bodies. */
export function javaTreeMembers(path: string, text: string, typesOnly = false): JavaTreeMember[] {
  const code = blankLiterals(text);
  const lineStarts = [0];
  const braceEnds = new Map<number, number>();
  const braces: number[] = [];
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === "\n") lineStarts.push(i + 1);
    if (code[i] === "{") braces.push(i);
    if (code[i] === "}" && braces.length) braceEnds.set(braces.pop()!, i);
  }
  const rows: JavaTreeMember[] = [];
  const lineIndex = (offset: number) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid;
    }
    return low;
  };
  const add = (name: string, kind: number, offset: number, parent: string, depth: number, end = offset) => {
    const low = lineIndex(offset);
    const id = `java-member:${path}:${offset}`;
    rows.push({ id, parent, name, kind, depth, line: low + 1, column: offset - lineStarts[low] + 1, endLine: lineIndex(end) + 1 });
    return id;
  };
  const walk = (from: number, to: number, parent: string, depth: number, owner = "", enumBody = false) => {
    if (depth > 24) return;
    let start = from;
    let parens = 0;
    for (let i = from; i < to; i += 1) {
      const ch = code[i];
      if (ch === "(") parens += 1;
      if (ch === ")") parens = Math.max(0, parens - 1);
      if (parens) continue;
      if (enumBody) {
        if (ch === "{") {
          const end = braceEnds.get(i);
          if (end === undefined) break;
          i = end;
        } else if (ch === "," || ch === ";") {
          const constant = javaEnumConstant(code.slice(start, i));
          if (constant) add(constant.name, 22, start + constant.offset, parent, depth);
          start = i + 1;
          enumBody = ch !== ";";
        }
        continue;
      }
      if (ch !== "{" && ch !== ";") continue;
      const header = code.slice(start, i);
      if (ch === "{") {
        const end = braceEnds.get(i);
        if (end === undefined) break;
        const declared = /(?:^|\s)(@interface|class|interface|enum|record)\s+([\p{L}_$][\p{L}\p{N}_$]*)/u.exec(header);
        if (declared) {
          const name = declared[2];
          const node = add(name, typeKinds[declared[1]], start + declared.index + declared[0].lastIndexOf(name), parent, depth, end);
          if (!typesOnly) walk(i + 1, end, node, depth + 1, name, declared[1] === "enum");
        } else if (owner) {
          const member = javaMemberHeader(header, owner);
          if (member) add(member.label, member.kind, start + member.offset, parent, depth, end);
        }
        i = end;
      } else if (owner) {
        const member = javaMemberHeader(header, owner);
        if (member) add(member.label, member.kind, start + member.offset, parent, depth);
      }
      start = i + 1;
    }
    if (enumBody) {
      const constant = javaEnumConstant(code.slice(start, to));
      if (constant) add(constant.name, 22, start + constant.offset, parent, depth);
    }
  };
  walk(0, code.length, path, 0);
  return rows;
}

export function hasJavaMembers(path: string): boolean {
  return /\.java$/i.test(path) && !/(?:^|[\\/])(?:package|module)-info\.java$/i.test(path);
}
