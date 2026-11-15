import { searchTypes, jarTypeUri, type TypeHit } from "./typeSearch";
import { requestOpenFile } from "./openFileRequest";
import { toast } from "../components/ui/toast";

export interface StackLocation { className: string; file: string; line: number; }
export function stackLocation(text: string): StackLocation | null {
  const match = /\bat\s+(?:[\w.@-]+\/)?([\w.$]+)\.([\w$<>]+)\(([\w$]+\.java):(\d+)\)/.exec(text);
  if (!match) return null;
  const line = Number(match[4]);
  return Number.isSafeInteger(line) && line > 0 ? { className: match[1].split("$")[0], file: match[3], line } : null;
}

export async function findStackSources(location: StackLocation): Promise<TypeHit[]> {
  const result = await searchTypes(location.className, 60);
  return [...result.workspace, ...(result.jars ?? [])].filter(hit => hit.name === location.className && (hit.jar || hit.file.split(/[\\/]/).pop() === location.file));
}

export function openStackSource(hit: TypeHit, location: StackLocation): void {
  if (hit.jar) {
    toast(`日志中的 ${location.file}:${location.line} 是原始源码行号；依赖类将只读打开，反编译行号可能不同。`, "info");
    void import("./lang").then(({ navigate }) => navigate({ kind: "jdt", uri: jarTypeUri(hit), line: 1, column: 1 }));
    return;
  }
  requestOpenFile({ path: hit.file, line: location.line, column: 1 });
}
