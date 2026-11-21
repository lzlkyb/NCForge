import { invoke } from "./tauri";
import type { SearchOptions, MatchRange } from "./search";
import { tabMetaFromJdt } from "./tabSession";
import type { TabMeta } from "./workspaceSession";

export interface LibraryHit {
  source: string;
  entry: string;
  archive: boolean;
  class: boolean;
  line: number;
  column?: number;
  text: string;
  ranges: MatchRange[];
}
export interface LibraryOutcome {
  items: LibraryHit[];
  building: boolean;
  stale: boolean;
  cancelled: boolean;
  truncated: boolean;
  scanned: number;
  skipped: number;
  error: string | null;
}
export type LibraryTarget = Pick<LibraryHit, "source" | "entry" | "archive">;
export interface LibraryText { text: string; decompiled: boolean; sourceOrigin?: string; }
export function libraryTabMeta(uri: string, target: LibraryTarget, source: LibraryText): TabMeta {
  return { ...tabMetaFromJdt(uri, source.text, source.decompiled), name: target.entry.split("/").pop() ?? target.entry,
    virtual: source.decompiled ? "decompiled" : source.sourceOrigin ? "source" : "resource", sourceOrigin: source.sourceOrigin };
}
export function sameLibrarySource(left: string, right: string): boolean {
  const key = (value: string) => value.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
  return key(left) === key(right);
}
export function libraryLocation(uri: string): string | null {
  const target = parseLibraryUri(uri);
  return target ? `${target.source}${target.archive ? " ! " : "/"}${target.entry}` : null;
}
export function libraryUri(target: LibraryTarget): string {
  return `nc-library://files/${encodeURIComponent(target.source)}/${target.entry.split("/").map(encodeURIComponent).join("/")}?archive=${target.archive ? 1 : 0}`;
}
export function parseLibraryUri(uri: string): LibraryTarget | null {
  if (!uri.startsWith("nc-library://files/")) return null;
  try {
    const url = new URL(uri);
    const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
    const source = parts.shift() ?? "", entry = parts.join("/");
    if (!source || !entry || parts.some(p => !p || p === "." || p === ".." || /[\\:\0]/.test(p))) return null;
    return { source, entry, archive: url.searchParams.get("archive") === "1" };
  } catch { return null; }
}
export const searchLibraryFiles = (options: SearchOptions, names = false, source = "library-content") =>
  invoke<LibraryOutcome>("search_library_files", { options: { ...options, maxResults: 100 }, names, source });
export const cancelLibrarySearch = (source = "library-content") => invoke("library_search_cancel", { source }).catch(() => {});
export const readLibraryFile = (target: LibraryTarget) =>
  invoke<LibraryText>("read_library_file", target);
