import { uriToPath, type LspRange } from "./langConvert";
import { libraryLocation } from "./libraryFiles";
import { blankLiterals } from "./javaModel";

export type NavigationKind = "definition" | "implementation" | "type" | "super" | "references" | "assembly";
export const NAVIGATION_LABELS: Record<NavigationKind, string> = {
  definition: "打开声明", implementation: "打开实现", type: "打开声明类型", super: "打开父方法", references: "找引用", assembly: "查看 NC 服务装配",
};
export interface NavigationTarget {
  uri: string; range: LspRange; label: string; source: string;
  origin: "source" | "library" | "assembly"; module?: string;
  access?: "read" | "write" | "readWrite" | "unknown";
}
const position = (value: unknown): value is { line: number; character: number } => {
  const p = value as { line?: unknown; character?: unknown } | null;
  return !!p && Number.isSafeInteger(p.line) && Number.isSafeInteger(p.character) && Number(p.line) >= 0 && Number(p.character) >= 0;
};
export function validNavigationRange(value: unknown): value is LspRange {
  const r = value as LspRange | null;
  return !!r && position(r.start) && position(r.end)
    && (r.end.line > r.start.line || r.end.line === r.start.line && r.end.character >= r.start.character);
}
export function targetSource(uri: string): string {
  const path = uriToPath(uri) ?? libraryLocation(uri);
  if (path) return path;
  try { return decodeURIComponent(uri.split("?")[0]).replace(/^jdt:\/\/contents\//, "").replace(/\.jar\//, ".jar ! "); }
  catch { return uri; }
}
/** Keep complete URI identities: two archives with the same filename are separate targets. */
export function navigationTargets(value: unknown): NavigationTarget[] {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>(), result: NavigationTarget[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>, loc = (row.location ?? row) as Record<string, unknown>;
    const uri = loc.targetUri ?? loc.uri, range = loc.targetSelectionRange ?? loc.targetRange ?? loc.range;
    if (typeof uri !== "string" || !/^(file|jdt|nc-library):\/\//.test(uri) || !validNavigationRange(range)) continue;
    const id = `${uri}:${range.start.line}:${range.start.character}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const source = targetSource(uri), name = row.displayName ?? row.name;
    const access = ["read", "write", "readWrite", "unknown"].includes(String(row.access)) ? row.access as NavigationTarget["access"] : undefined;
    result.push({ uri, range, source, label: typeof name === "string" ? name : `${source.split(/[\\/]/).pop()}:${range.start.line + 1}`, origin: uri.startsWith("file:") ? "source" : "library", ...(access ? { access } : {}) });
  }
  return result;
}
export function filterNavigationTargets(targets: NavigationTarget[], query: string, scope = "all", module = "all", access = "all") {
  const text = query.trim().toLocaleLowerCase();
  return targets.filter(target => (scope === "all" || target.origin === scope) && (module === "all" || target.module === module) && (access === "all" || target.access === access || target.access === "readWrite" && (access === "read" || access === "write"))
    && (!text || `${target.label} ${target.source} ${target.module ?? ""}`.toLocaleLowerCase().includes(text)));
}
export function qualifiedTypeAt(text: string, line: number, column: number): string | null {
  const code = blankLiterals(text), row = code.split(/\r?\n/)[line - 1] ?? "", offset = Math.max(0, column - 1);
  const pattern = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(row))) {
    if (offset < match.index || offset > match.index + match[0].length) continue;
    const parts = match[0].replace(/\.class$/, "").split(".");
    const typeIndex = parts.findIndex(part => /^[A-Z_$]/.test(part));
    if (typeIndex < 0) return null;
    let end = typeIndex + 1;
    while (end < parts.length && /^[A-Z_$]/.test(parts[end])) end++;
    // A member or method after the type is not itself a type navigation target.
    if (offset > match.index + parts.slice(0, end).join(".").length) return null;
    const name = parts.slice(0, end).join(".");
    if (typeIndex > 0) return name;
    const rootName = parts[0], escaped = rootName.replace(/\$/g, "\\$");
    const imported = new RegExp(`\\bimport\\s+(?:static\\s+)?([\\w.$]+\\.${escaped})\\s*;`).exec(code);
    if (imported) return imported[1] + name.slice(rootName.length);
    const pkg = /\bpackage\s+([\w.]+)\s*;/.exec(code)?.[1];
    const declaredHere = new RegExp(`\\b(?:class|interface|enum)\\s+${escaped}\\b`).test(code);
    return pkg && declaredHere ? `${pkg}.${name}` : name;
  }
  return null;
}
export function typeSearchQueries(name: string): string[] {
  const parts = name.split("."), first = parts.findIndex(part => /^[A-Z_$]/.test(part));
  if (first < 0 || parts.length - first < 2) return [name];
  const binary = [...parts.slice(0, first), parts.slice(first).join("$")].join(".");
  return binary === name ? [name] : [name, binary];
}
