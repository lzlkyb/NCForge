import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DRAFT } from "./patch";
import { loadPatchDraft, savePatchDraft, type PatchDraft } from "./patchDraft";

/**
 * 补丁草稿的读写。node 环境没有 localStorage，用内存替身。
 *
 * 重点不是「存进去能读出来」这种常识，而是三条容易写错的边界：
 * 空草稿别留垃圾、`picked: []`（明确全不勾）不能被当成空、坏数据不能把页面顶崩。
 */

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const draft = (over: Partial<PatchDraft> = {}): PatchDraft => ({
  desc: "修复台账保存报错",
  draft: { ...EMPTY_DRAFT, 修改点: "加了空判断" },
  sqls: ["update x set y = 1"],
  picked: ["C:/w/A.java"],
  layers: [["C:/w/A.java", "hy"]],
  ...over,
});

beforeEach(() => store.clear());

describe("savePatchDraft / loadPatchDraft", () => {
  it("存进去能原样读回来", () => {
    savePatchDraft("C:/w", draft());
    expect(loadPatchDraft("C:/w")).toEqual(draft());
  });

  it("按工作区隔离：换个工程读不到上一个工程的草稿", () => {
    savePatchDraft("C:/w1", draft());
    expect(loadPatchDraft("C:/w2")).toBeNull();
  });

  it("从没存过返回 null", () => {
    expect(loadPatchDraft("C:/w")).toBeNull();
  });

  it("空草稿不写，还会把上次的清掉", () => {
    savePatchDraft("C:/w", draft());
    savePatchDraft("C:/w", { desc: "  ", draft: EMPTY_DRAFT, sqls: [], picked: null, layers: [] });
    expect(loadPatchDraft("C:/w")).toBeNull();
  });

  it("「全不勾」是有效意图，不能被当成空草稿丢掉", () => {
    savePatchDraft("C:/w", { desc: "", draft: EMPTY_DRAFT, sqls: [], picked: [], layers: [] });
    expect(loadPatchDraft("C:/w")?.picked).toEqual([]);
  });

  it("内容坏了返回 null，不抛", () => {
    store.set("ncforge.patchDraft.v1:C:/w", "{not json");
    expect(loadPatchDraft("C:/w")).toBeNull();
  });

  it("老草稿少了分节字段时用空分节补齐", () => {
    store.set(
      "ncforge.patchDraft.v1:C:/w",
      JSON.stringify({ desc: "旧格式", draft: { 修改点: "只写了一节" }, sqls: [], picked: null, layers: [] }),
    );
    const d = loadPatchDraft("C:/w");
    expect(d?.draft.修改点).toBe("只写了一节");
    expect(d?.draft.功能说明).toBe("");
  });
});
