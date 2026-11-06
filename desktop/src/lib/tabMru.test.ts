import { beforeEach, describe, expect, it } from "vitest";
import { mruNeighbor, pruneMru, resetMru, touchMru, swapGroupMru, mergeGroupMru } from "./tabMru";

beforeEach(() => {
  resetMru();
});

describe("标签 MRU", () => {
  it("共享文件的最近顺序按组隔离，交换及合并保留优先组顺序", () => {
    touchMru("a", "left"); touchMru("b", "left"); touchMru("shared", "left");
    touchMru("c", "right"); touchMru("shared", "right"); touchMru("d", "right");
    expect(mruNeighbor("shared", ["a", "b", "shared"], 1, "left")).toBe("b");
    expect(mruNeighbor("d", ["c", "shared", "d"], 1, "right")).toBe("shared");
    swapGroupMru(); expect(mruNeighbor("shared", ["a", "b", "shared"], 1, "right")).toBe("b");
    mergeGroupMru("right"); expect(mruNeighbor("shared", ["a", "b", "shared", "c", "d"], 1, "left")).toBe("b");
  });
  it("Ctrl+Tab 回到上一个用过的标签", () => {
    touchMru("a");
    touchMru("b");
    touchMru("c");
    expect(mruNeighbor("c", ["a", "b", "c"], 1)).toBe("b");
  });

  it("Ctrl+Shift+Tab 去最久没用的那个", () => {
    touchMru("a");
    touchMru("b");
    touchMru("c");
    expect(mruNeighbor("c", ["a", "b", "c"], -1)).toBe("a");
  });

  it("已关闭的标签不参与选择", () => {
    touchMru("a");
    touchMru("b");
    touchMru("c");
    pruneMru(["a", "c"]);
    expect(mruNeighbor("c", ["a", "c"], 1)).toBe("a");
  });

  it("只有一个标签时返回 null，不假装能切", () => {
    touchMru("a");
    expect(mruNeighbor("a", ["a"], 1)).toBeNull();
  });

  it("顺序表还没收到当前标签时退回标签栏顺序", () => {
    expect(mruNeighbor("b", ["a", "b", "c"], 1)).toBe("c");
    expect(mruNeighbor("b", ["a", "b", "c"], -1)).toBe("a");
  });

  it("当前标签最近用过之后，再切就是刚离开的那个", () => {
    touchMru("a");
    touchMru("b");
    touchMru("a");
    expect(mruNeighbor("a", ["a", "b"], 1)).toBe("b");
  });
});
