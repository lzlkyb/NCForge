import { invoke } from "./tauri";
import { trackOperation } from "./operations";
import { getSession } from "./workspaceSession";
import { workspaceEpoch } from "./workspaceEpoch";
import { withSvnWriteLock } from "./svnWrite";
import type { BlameLine, ResolveResult } from "./svn";
export interface HistoryPath { path: string; action: string; copyFromPath: string | null; copyFromRevision: number; }
export interface HistoryEntry { revision: number; author: string; date: number; message: string; paths: HistoryPath[]; }
export interface HistoryResult { repositoryPath: string; entries: HistoryEntry[]; }
export interface RevisionDiff { path: string; beforePath: string; beforeRevision: number; revision: number; beforeEmpty: boolean; afterEmpty: boolean; beforeText: string; afterText: string; beforeEncoding: string; afterEncoding: string; }
export interface BlameSnapshot { sourceRevision: number; text: string; encoding: string; lines: BlameLine[]; }
export interface ConflictVersion { role: string; name: string; revision: number; binary: boolean; text: string; encoding: string; }
export interface ConflictSnapshot { treeConflict: boolean; propertyConflict: boolean; textConflict: boolean; mine: ConflictVersion | null; base: ConflictVersion | null; theirs: ConflictVersion | null; workingReadable: boolean; workingHasMarkers: boolean; }
const normalized = (root: string | null | undefined) => root?.replace(/\\/g, "/").toLowerCase();
function context() {
  const root = getSession().root;
  if (!root) throw new Error("还没有选择工作副本");
  const epoch = workspaceEpoch();
  return { root, epoch, assertCurrent: () => { if (normalized(root) !== normalized(getSession().root) || epoch !== workspaceEpoch()) throw new Error("来源工程已切换，本次结果已忽略"); } };
}
export function svnHistory(path: string, limit = 30, from = 0) {
  const ctx = context();
  return trackOperation({ key: `svn.history:${normalized(ctx.root)}:${ctx.epoch}:${path}:${from}`, label: "读取 SVN 历史", scope: path, page: "svn" }, async () => {
    const result = await invoke<HistoryResult>("svn_history", { root: ctx.root, path, limit, from }); ctx.assertCurrent(); return result;
  });
}
export function svnRevisionDiff(repositoryPath: string, revision: number) {
  const ctx = context();
  return trackOperation({ key: `svn.revision:${normalized(ctx.root)}:${ctx.epoch}:${revision}:${repositoryPath}`, label: `读取 r${revision} 版本差异`, scope: repositoryPath, page: "svn" }, async () => {
    const result = await invoke<RevisionDiff>("svn_revision_diff", { root: ctx.root, repositoryPath, revision }); ctx.assertCurrent(); return result;
  });
}
export function svnBlameSnapshot(path: string, revision = 0) {
  const ctx = context();
  return trackOperation({ key: `svn.blame.snapshot:${normalized(ctx.root)}:${ctx.epoch}:${path}:${revision}`, label: "读取准确逐行追溯", scope: path, page: "svn" }, async () => {
    const result = await invoke<BlameSnapshot>("svn_blame_snapshot", { root: ctx.root, path, revision }); ctx.assertCurrent(); return result;
  });
}
export function svnConflictSnapshot(path: string) {
  const ctx = context();
  return trackOperation({ key: `svn.conflict.snapshot:${normalized(ctx.root)}:${ctx.epoch}:${path}`, label: "读取实际冲突副本", scope: path, page: "svn" }, async () => {
    const result = await invoke<ConflictSnapshot>("svn_conflict_snapshot", { root: ctx.root, path }); ctx.assertCurrent(); return result;
  });
}
export function svnResolveWorking(path: string) {
  const ctx = context();
  return withSvnWriteLock(ctx.root, "resolve", async () => {
    ctx.assertCurrent();
    return trackOperation({ key: `svn.resolve.working:${normalized(ctx.root)}:${ctx.epoch}:${path}`, label: "保留手工合并结果", scope: path, page: "svn", phase: "验证冲突标记并备份，然后解除文本冲突" }, async () => {
      const result = await invoke<ResolveResult>("svn_resolve_working", { root: ctx.root, path }); ctx.assertCurrent(); return result;
    }, result => ({ state: "success", detail: result.backupDir ? `合并结果已保留，备份位于 ${result.backupDir}` : "合并结果已保留，文本冲突已解除" }));
  });
}
export function filterHistory(entries: HistoryEntry[], keyword: string, author: string, since: string, until: string) {
  const query = keyword.trim().toLowerCase();
  const start = since ? new Date(`${since}T00:00:00`).getTime() : -Infinity;
  const end = until ? new Date(`${until}T23:59:59.999`).getTime() : Infinity;
  return entries.filter(entry => (!query || `${entry.message} ${entry.revision} ${entry.paths.map(p => p.path).join(" ")}`.toLowerCase().includes(query)) && (!author || entry.author === author) && entry.date >= start && entry.date <= end);
}
