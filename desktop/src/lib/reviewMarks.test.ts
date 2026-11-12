import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P0-4 契约回归：后端 `svn_review::is_valid` 要求 revision 全等。
 * 代码面没有 status 数据时绝不能传 0（0 != 14231，标记下次扫描必失效），
 * 统一传 -1 让后端自己查单文件 BASE 版本；后端查不到时跳过版本维度。
 */
const h = vi.hoisted(() => ({
  mark: vi.fn(() => Promise.resolve()),
  ext: [] as ((paths: readonly string[]) => void)[],
  saves: [] as ((path: string) => void)[],
}));

vi.mock("./svn", () => ({
  keyOf: (p: string) => p.replace(/\\/g, "/").toLowerCase(),
  svnReviewMark: h.mark,
}));
vi.mock("./externalJavaChanges", () => ({
  onExternalJavaChanged: (cb: (paths: readonly string[]) => void) => { h.ext.push(cb); return () => {}; },
}));
vi.mock("./localSaves", () => ({
  onLocalSave: (cb: (path: string) => void) => { h.saves.push(cb); return () => {}; },
}));

import {
  initReviewMarks, isReviewOutdated, isReviewed, markReviewed, resetReviewMarks, syncReviewMarks,
} from "./reviewMarks";

const path = "D:/work/src/A.java";
const status = (reviewed: string[], revision = 14231) => ({
  changes: { groups: [{ items: [{ path, revision }] }] },
  reviewed,
  scanned: 1,
  generatedAtMs: 0,
  hasConflict: false,
});

beforeEach(() => {
  resetReviewMarks();
  h.mark.mockClear();
  h.ext.length = 0;
  h.saves.length = 0;
});

describe("reviewMarks revision 契约", () => {
  it("代码面直接标记：没有 status 数据时传 -1，不传 0", async () => {
    await markReviewed(path, true);
    expect(h.mark).toHaveBeenCalledWith(path, -1, true);
    expect(isReviewed(path)).toBe(true);
  });

  it("版本控制面扫描过：透传真 revision，四元组全等由后端守", async () => {
    syncReviewMarks(status([]) as never);
    await markReviewed(path, true);
    expect(h.mark).toHaveBeenCalledWith(path, 14231, true);
  });

  it("后端有效标记是唯一真相：扫描结果不含该路径时角标撤掉", () => {
    syncReviewMarks(status([path]) as never);
    expect(isReviewed(path)).toBe(true);
    syncReviewMarks(status([]) as never);
    expect(isReviewed(path)).toBe(false);
  });

  it("文件被外部改动后需要重审，旧扫描不会恢复角标", () => {
    initReviewMarks();
    syncReviewMarks(status([path]) as never);
    expect(isReviewed(path)).toBe(true);
    expect(h.ext.length).toBe(1);
    h.ext[0]([path]);
    expect(isReviewed(path)).toBe(false);
    expect(isReviewOutdated(path)).toBe(true);
    expect(h.mark).not.toHaveBeenCalled();
    syncReviewMarks(status([path]) as never);
    expect(isReviewed(path)).toBe(false);
  });
});
