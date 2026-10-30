import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabMeta } from "./workspaceSession";

/**
 * 「退出前保存全部」的挑选与失败归类。
 *
 * 两个模块被 mock 掉：
 * - `./workspaceSession`：真实实现会 import editorStore → monaco（node 环境加载不了），
 *   这里换成一个能读写的假会话；
 * - `./fileSave`：写盘动作本身，用假的返回/抛错来驱动三种结局。
 *
 * 真正写盘与 Monaco 记账的联动不在单测范围，靠 `docs/手工验收清单` 的退出项验。
 */

const h = vi.hoisted(() => ({
  state: { tabs: [] as unknown[] },
  saveOne: vi.fn(),
}));

vi.mock("./workspaceSession", () => ({
  getSession: () => h.state,
  setSession: (patch: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(patch)) {
      const cur = (h.state as Record<string, unknown>)[k];
      (h.state as Record<string, unknown>)[k] =
        typeof v === "function" ? (v as (prev: unknown) => unknown)(cur) : v;
    }
  },
}));

vi.mock("./fileSave", () => ({ saveOne: h.saveOne }));

import { collectUnsaved, isUnsaved, saveAllDirty } from "./saveAllDirty";

const tab = (path: string, over: Partial<TabMeta> = {}): TabMeta => ({
  path,
  name: path.split("/").pop() ?? path,
  encoding: "UTF-8",
  hasBom: false,
  eol: "LF",
  mtimeMs: 1000,
  dirty: false,
  eolChanged: false,
  readOnly: false,
  readOnlyReason: null,
  lines: 10,
  ...over,
});

const ok = (mtimeMs = 2000) => ({ mtimeMs, encoding: "UTF-8", hasBom: false, converted: false });

beforeEach(() => {
  h.state.tabs = [];
  h.saveOne.mockReset();
  h.saveOne.mockResolvedValue(ok());
});

describe("isUnsaved", () => {
  it("改过内容算未保存", () => {
    expect(isUnsaved(tab("a.java", { dirty: true }))).toBe(true);
  });

  it("只改了换行也算——保存后行尾会变", () => {
    expect(isUnsaved(tab("a.java", { eolChanged: true }))).toBe(true);
  });

  it("干净的文件不算", () => {
    expect(isUnsaved(tab("a.java"))).toBe(false);
  });

  it("只读标签不算：编辑器本身锁着，改不了", () => {
    expect(isUnsaved(tab("a.java", { dirty: true, readOnly: true, readOnlyReason: "mixed" }))).toBe(false);
  });

  it("jar 里的虚拟标签不算：不在磁盘上", () => {
    expect(isUnsaved(tab("jdt://x", { dirty: true, virtual: "source" }))).toBe(false);
  });
});

describe("collectUnsaved", () => {
  it("只挑该问的那几个，保留预览标记与文件名", () => {
    h.state.tabs = [
      tab("/w/A.java", { dirty: true }),
      tab("/w/B.java"),
      tab("/w/C.java", { eolChanged: true, preview: true }),
    ];
    expect(collectUnsaved()).toEqual([
      { path: "/w/A.java", name: "A.java", preview: false },
      { path: "/w/C.java", name: "C.java", preview: true },
    ]);
  });

  it("全干净时返回空数组——调用方据此决定「直接退出，不用问」", () => {
    h.state.tabs = [tab("/w/A.java")];
    expect(collectUnsaved()).toEqual([]);
  });
});

describe("saveAllDirty", () => {
  it("全部成功：按顺序保存，并把新的修改时间回写到标签", async () => {
    h.state.tabs = [tab("/w/A.java", { dirty: true }), tab("/w/B.java", { dirty: true })];
    h.saveOne.mockResolvedValueOnce(ok(2001)).mockResolvedValueOnce(ok(2002));

    const r = await saveAllDirty();

    expect(r.saved).toEqual(["/w/A.java", "/w/B.java"]);
    expect(r.failed).toEqual([]);
    // 每次都用最新标签取内容：带着旧 mtime 写盘会被后端判成异地冲突
    expect(h.saveOne.mock.calls[0][0]).toMatchObject({ path: "/w/A.java", mtimeMs: 1000 });
    expect(h.saveOne.mock.calls[1][0]).toMatchObject({ path: "/w/B.java", mtimeMs: 1000 });
    expect((h.state.tabs as TabMeta[]).map((t) => t.mtimeMs)).toEqual([2001, 2002]);
  });

  it("单个失败不中断：剩下的继续存，失败原因翻成人话", async () => {
    h.state.tabs = [
      tab("/w/A.java", { dirty: true }),
      tab("/w/B.java", { dirty: true }),
      tab("/w/C.java", { dirty: true }),
    ];
    // 后端的错误是**字符串**（Tauri 的 `Err(String)` 直接 reject 成字符串），
    // `isConflictError` / `isUnencodableError` 也是按字符串前缀判的
    h.saveOne
      .mockResolvedValueOnce(ok(2001))
      .mockRejectedValueOnce("CONFLICT:磁盘上的文件更新")
      .mockRejectedValueOnce("UNENCODABLE:编码写不出");

    const r = await saveAllDirty();

    expect(r.saved).toEqual(["/w/A.java"]);
    expect(r.failed.map((f) => f.path)).toEqual(["/w/B.java", "/w/C.java"]);
    // 冲突必须提示「需要先处理」，不能悄悄带 force 覆盖
    expect(r.failed[0].reason).toContain("其他程序修改");
    expect(r.failed[1].reason).toContain("UTF-8");
  });

  it("进度回调覆盖每个文件，最后停在总数上", async () => {
    h.state.tabs = [tab("/w/A.java", { dirty: true }), tab("/w/B.java", { dirty: true })];
    const seen: string[] = [];

    await saveAllDirty((done, total) => seen.push(`${done}/${total}`));

    expect(seen).toEqual(["1/2", "2/2"]);
  });

  it("没有要保存的文件时一次都不写盘", async () => {
    h.state.tabs = [tab("/w/A.java")];
    const r = await saveAllDirty();
    expect(r).toEqual({ saved: [], failed: [] });
    expect(h.saveOne).not.toHaveBeenCalled();
  });
});
