import { describe, expect, it, vi } from "vitest";

vi.mock("./tauri", () => ({ invoke: vi.fn() }));

import { invoke } from "./tauri";
import {
  EMPTY_INDEX,
  bcBadge,
  componentIndex,
  loadNcManifest,
  mergeIndexes,
  type NcComponent,
} from "./ncManifest";

/**
 * manifest.xml 只是「业务组件」标注，这里的用例盯的是三件会安静出错的事：
 * ① 大小写（Windows 目录名不区分，manifest 里也会写大写）；
 * ② `dispname` 与目录名相同时别给出重复信息；
 * ③ 读失败必须退化成空索引，不能抛给树。
 */

const comp = (name: string, dispname = "", roots: string[] = []): NcComponent => ({
  name,
  dispname,
  roots,
});

describe("componentIndex", () => {
  it("键统一小写，显示名与目录名相同时只留名字", () => {
    const idx = componentIndex([comp("Bill"), comp("gl", "总账")]);
    expect(idx.get("bill")).toBe("Bill");
    expect(idx.get("gl")).toBe("总账");
  });

  it("空名忽略；同名后者不覆盖前者", () => {
    const idx = componentIndex([comp("  "), comp("ic", "存货"), comp("IC", "别处")]);
    expect(idx.size).toBe(1);
    expect(idx.get("ic")).toBe("存货");
  });
});

describe("bcBadge", () => {
  it("按名字匹配且不区分大小写", () => {
    const idx = componentIndex([comp("arap")]);
    expect(bcBadge("ARAP", idx)).toBe("arap");
    expect(bcBadge("bad", idx)).toBeUndefined();
  });

  it("空索引直接短路，不产生任何徽章", () => {
    expect(bcBadge("bill", EMPTY_INDEX)).toBeUndefined();
  });
});

describe("mergeIndexes", () => {
  it("多工程合并时先到者优先（roots[0] 是当前工作区）", () => {
    const merged = mergeIndexes([
      componentIndex([comp("bill", "票据")]),
      componentIndex([comp("bill", "另一个工程"), comp("gl")]),
    ]);
    expect(merged.get("bill")).toBe("票据");
    expect(merged.has("gl")).toBe(true);
  });
});

describe("loadNcManifest", () => {
  const call = invoke as unknown as ReturnType<typeof vi.fn>;

  it("读失败返回空索引而不是抛异常", async () => {
    call.mockRejectedValueOnce(new Error("manifest.xml 不存在"));
    await expect(loadNcManifest("D:/work/aier/newar")).resolves.toBe(EMPTY_INDEX);
  });

  it("命令返回的组件清单压成索引", async () => {
    call.mockResolvedValueOnce({
      components: [comp("bill"), comp("baseapp", "基础")],
      notes: [],
    });
    const idx = await loadNcManifest("D:/work/aier/newar");
    expect(call).toHaveBeenCalledWith("nc_manifest", { root: "D:/work/aier/newar" });
    expect([...idx.keys()].sort()).toEqual(["baseapp", "bill"]);
  });
});
