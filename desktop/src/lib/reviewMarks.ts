/**
 * 代码面的「已审」角标：与版本控制面共用后端同一份标记数据，不另起一套。
 *
 * 保存或外部修改会立即使标记失效。保留磁盘上的审查记录，
 * 这样下次扫描仍可告诉用户该文件需要重审。
 *
 * revision 契约（P0-4）：后端 `is_valid` 要求 `mark.revision == 扫描到的真 revision`。
 * 代码面通常没有 status 数据，**不能传 0**（0 != 14231，标记下次扫描必失效）。
 * 现在统一传 -1 表示「未知」，由后端 `svn_review_mark` 自己查单文件 BASE 版本；
 * 查不到时后端按「仅比 mtime/size」处理，标记照样能保住。
 */
import { keyOf, svnReviewMark } from "./svn";
import { onExternalJavaChanged } from "./externalJavaChanges";
import { onLocalSave } from "./localSaves";
import type { StatusResult } from "./svn";

/** 「版本未知」的哨兵；0 是一个合法的 SVN 版本号，不能拿来当缺省值。 */
export const UNKNOWN_REVISION = -1;

let lastSynced: StatusResult | undefined;
let marks = new Set<string>();
const invalidated = new Set<string>();
let scannedOutdated = new Set<string>();
export const isReviewOutdated = (path: string) => {
  const key = keyOf(path);
  return invalidated.has(key) || scannedOutdated.has(key);
};
export const getReviewedPaths = () => marks;
/** path → SVN revision：有扫描结果时带上，能省掉后端一次 info 查询。 */
const revisions = new Map<string, number>();
let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version += 1; listeners.forEach((l) => l()); };
export function reviewMarksVersion(): number { return version; }

export function subscribeReviewMarks(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function isReviewed(path: string): boolean {
  return marks.has(keyOf(path));
}

/** 版本控制面每次扫描结果落地时调用：后端有效标记是唯一真相。 */
export function syncReviewMarks(status: StatusResult | undefined): void {
  if (status === lastSynced) return;
  lastSynced = status;
  revisions.clear();
  for (const g of status?.changes.groups ?? []) {
    for (const it of g.items) revisions.set(keyOf(it.path), it.revision);
  }
  const nextOutdated = new Set(status?.reviewOutdated);
  const sameOutdated = nextOutdated.size === scannedOutdated.size && [...nextOutdated].every(key => scannedOutdated.has(key));
  scannedOutdated = nextOutdated;
  const next = new Set((status?.reviewed ?? []).map(keyOf).filter(key => !invalidated.has(key)));
  if (sameOutdated && next.size === marks.size && [...next].every((k) => marks.has(k))) return;
  marks = next;
  emit();
}

/** 代码面点「标记已审」：成功后本地立刻生效，失败由调用方提示去版本控制面。 */
export async function markReviewed(path: string, next: boolean, revision = revisions.get(keyOf(path)) ?? UNKNOWN_REVISION): Promise<void> {
  await svnReviewMark(path, revision, next);
  if (!next) revisions.delete(keyOf(path));
  const k = keyOf(path);
  invalidated.delete(k);
  scannedOutdated.delete(k);
  const updated = new Set(marks);
  if (next) updated.add(k); else updated.delete(k);
  marks = updated;
  emit();
}

let started = false;
export function initReviewMarks(): void {
  if (started) return;
  started = true;
  const invalidate = (p: string | readonly string[]) => {
    const paths = typeof p === "string" ? [p] : [...p];
    let changed = false;
    for (const path of paths) {
      if (!marks.delete(keyOf(path))) continue;
      changed = true;
      invalidated.add(keyOf(path));
    }
    if (changed) { marks = new Set(marks); emit(); }
  };
  onExternalJavaChanged(invalidate);
  onLocalSave(invalidate);
}

/** 单测 / 换工作区用：重置本地标记与接线状态。 */
export function resetReviewMarks(): void {
  lastSynced = undefined;
  marks = new Set();
  invalidated.clear();
  scannedOutdated.clear();
  revisions.clear();
  started = false;
  emit();
}
