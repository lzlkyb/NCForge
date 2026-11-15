import { applyLspEdits, type RenameGroup } from "./renameEdits";
import { uriToPath } from "./langConvert";

export interface ResourceEdit { kind: "create" | "rename" | "delete"; path: string; destination?: string; }
export interface SemanticEditResponse {
  edit?: unknown;
  before?: { uri: string; text: string }[];
  warnings?: string[];
  matches?: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string }[];
  filesScanned?: number;
}
export interface ParsedWorkspaceEdit { groups: RenameGroup[]; resources: ResourceEdit[]; before: Map<string,string>; warnings: string[]; }
export const editPathKey = (path: string): string => path.replace(/\\/g,"/").toLowerCase();
export const normalizedEditText = (text: string): string => text.replace(/\r\n/g,"\n");
function filePath(uri: string): string {
  const path = uriToPath(uri);
  if (!path) throw new Error(`重构涉及不可写目标：${uri}`);
  return path;
}

/** Resource operations must be preserved; dropping them would apply references without moving files. */
export function parseWorkspaceEdit(response: SemanticEditResponse): ParsedWorkspaceEdit {
  const raw = response.edit as { changes?: Record<string,RenameGroup["edits"]>; documentChanges?: unknown[] } | undefined;
  const groups = new Map<string,RenameGroup>(), resources: ResourceEdit[] = [];
  const add = (uri: string, edits: RenameGroup["edits"]) => {
    const path=filePath(uri), key=editPathKey(path), existing=groups.get(key);
    if (existing) existing.edits.push(...edits); else groups.set(key,{path,edits:[...edits]});
  };
  for (const [uri,edits] of Object.entries(raw?.changes ?? {})) add(uri,edits);
  for (const entry of raw?.documentChanges ?? []) {
    const change=entry as {kind?: string; uri?: string; oldUri?: string; newUri?: string; textDocument?: {uri: string}; edits?: RenameGroup["edits"]};
    if (change.textDocument && Array.isArray(change.edits)) add(change.textDocument.uri,change.edits);
    else if (change.kind === "rename" && change.oldUri && change.newUri) resources.push({kind:"rename",path:filePath(change.oldUri),destination:filePath(change.newUri)});
    else if ((change.kind === "create" || change.kind === "delete") && change.uri) resources.push({kind:change.kind,path:filePath(change.uri)});
    else throw new Error("语言服务返回了不支持的文件操作，未应用任何改动");
  }
  const before=new Map<string,string>();
  for (const snapshot of response.before ?? []) before.set(editPathKey(filePath(snapshot.uri)),normalizedEditText(snapshot.text));
  for (const resource of resources) if (!groups.has(editPathKey(resource.path))) groups.set(editPathKey(resource.path),{path:resource.path,edits:[]});
  for (const resource of resources.filter(r=>r.kind==="rename")) {
    const next=groups.get(editPathKey(resource.destination!));
    if (next) { groups.get(editPathKey(resource.path))!.edits.push(...next.edits); groups.delete(editPathKey(resource.destination!)); }
  }
  return {groups:[...groups.values()],resources,before,warnings:response.warnings ?? []};
}
export function plannedText(before: string, group: RenameGroup): string {
  return applyLspEdits(normalizedEditText(before),group.edits);
}
