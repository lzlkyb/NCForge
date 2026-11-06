import { searchTypes, type TypeHit } from "./typeSearch";
import { requestOpenFile } from "./openFileRequest";

export interface StackLocation { className: string; file: string; line: number; }
export function stackLocation(text: string): StackLocation | null {
  const match = /\bat\s+(?:[\w.@-]+\/)?([\w.$]+)\.([\w$<>]+)\(([\w$]+\.java):(\d+)\)/.exec(text);
  if (!match) return null;
  const line = Number(match[4]);
  return Number.isSafeInteger(line) && line > 0 ? { className: match[1].split("$")[0], file: match[3], line } : null;
}

export async function findStackSources(location: StackLocation): Promise<TypeHit[]> {
  const result = await searchTypes(location.className, 60);
  return result.workspace.filter(hit => hit.name === location.className && hit.file.split(/[\\/]/).pop() === location.file);
}

export function openStackSource(hit: TypeHit, location: StackLocation): void {
  requestOpenFile({ path: hit.file, line: location.line, column: 1 });
}
