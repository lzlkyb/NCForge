import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: deps.invoke }));

/** 每个用例重新加载模块：缓存是模块级状态，跨用例必须清干净。 */
let mod: typeof import("./fileIndex");

/** 推进「现在」，用来跨过 5 分钟软过期。 */
let now = 1_000_000;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  deps.invoke.mockReset();
  deps.invoke.mockResolvedValue({ files: ["a/A.java"], truncated: false });
  vi.resetModules();
  mod = await import("./fileIndex");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("文件索引的缓存策略", () => {
  it("文件名转条目：路径用反斜杠、目录单独拆出来", () => {
    expect(mod.toEntry("C:\\w", "bill/src/BillVO.java")).toEqual({
      path: "C:\\w\\bill\\src\\BillVO.java",
      rel: "bill/src/BillVO.java",
      name: "BillVO.java",
      dir: "bill/src",
    });
    // 根目录下的文件没有目录段
    expect(mod.toEntry("C:\\w", "build.xml").dir).toBe("");
  });

  it("首次加载后重复取用不再打后端", async () => {
    const first = await mod.getFileIndex("C:\\w");
    expect(first).toHaveLength(1);
    expect(deps.invoke).toHaveBeenCalledTimes(1);

    now += 1_000;
    const again = await mod.getFileIndex("C:\\w");
    expect(again).toBe(first);
    expect(deps.invoke).toHaveBeenCalledTimes(1);
  });

  it("过期时先返回旧表、后台再刷新（不阻塞按键）", async () => {
    await mod.getFileIndex("C:\\w");
    deps.invoke.mockResolvedValueOnce({ files: ["b/B.java"], truncated: false });

    now += 6 * 60_000;
    const stale = await mod.getFileIndex("C:\\w");
    // 关键：过期那一刻拿到的仍是旧数据，而不是等一次扫盘
    expect(stale[0].rel).toBe("a/A.java");

    await flush();
    expect(deps.invoke).toHaveBeenCalledTimes(2);
    const fresh = await mod.getFileIndex("C:\\w");
    expect(fresh[0].rel).toBe("b/B.java");
  });

  it("主动失效后仍秒回旧表，并通知后端丢弃缓存", async () => {
    await mod.getFileIndex("C:\\w");
    mod.invalidateFileIndex();
    expect(deps.invoke).toHaveBeenCalledWith("search_invalidate_files");

    // 失效不等于必须等：旧表还能顶上，刷新在后台跑
    const got = await mod.getFileIndex("C:\\w");
    expect(got[0].rel).toBe("a/A.java");

    await flush();
    expect(deps.invoke.mock.calls.filter((c) => c[0] === "search_list_files")).toHaveLength(2);
  });

  it("换工作区不会拿上一个工程的清单", async () => {
    await mod.getFileIndex("C:\\w");
    deps.invoke.mockResolvedValueOnce({ files: ["x/X.java"], truncated: false });
    const other = await mod.getFileIndex("C:\\w2");
    expect(other[0].rel).toBe("x/X.java");
    expect(other[0].path).toBe("C:\\w2\\x\\X.java");
  });

  it("加载失败返回空表而不抛（面板照常可用）", async () => {
    deps.invoke.mockRejectedValueOnce(new Error("目录没了"));
    await expect(mod.getFileIndex("C:\\w")).resolves.toEqual([]);
  });
});
