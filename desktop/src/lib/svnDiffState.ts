export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

export interface SvnDiffSummary { ready: boolean; add: number; del: number; at: number; total: number }
export const emptyDiffSummary: SvnDiffSummary = { ready: false, add: 0, del: 0, at: 0, total: 0 };

// Monaco 用 end=0 表示这一侧没有正文（纯新增/删除），不能把它计成一行。
const lengthOf = (start: number, end: number) => start > 0 && end > 0 ? Math.max(0, end - start + 1) : 0;
export function diffSummary(changes: LineChange[] | null, at: number): SvnDiffSummary {
  if (!changes) return emptyDiffSummary;
  return {
    ready: true,
    add: changes.reduce((sum, c) => sum + lengthOf(c.modifiedStartLineNumber, c.modifiedEndLineNumber), 0),
    del: changes.reduce((sum, c) => sum + lengthOf(c.originalStartLineNumber, c.originalEndLineNumber), 0),
    at: Math.min(Math.max(0, at), changes.length),
    total: changes.length,
  };
}

export const changedLine = (change: Pick<LineChange, "modifiedStartLineNumber">): number => Math.max(1, change.modifiedStartLineNumber);
