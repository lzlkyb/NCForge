// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getRecentRoots, rememberRoot } from "./recentRoots";

beforeEach(() => {
  localStorage.clear();
});

describe("最近工作区", () => {
  it("默认是空列表", () => {
    expect(getRecentRoots()).toEqual([]);
  });

  it("新打开的置顶，大小写不同视为同一个", () => {
    rememberRoot("C:\\work\\aier");
    rememberRoot("C:\\work\\newar");
    rememberRoot("c:\\WORK\\AIER");
    expect(getRecentRoots()).toEqual(["c:\\WORK\\AIER", "C:\\work\\newar"]);
  });

  it("空路径不记，最多保留 8 个", () => {
    rememberRoot("   ");
    for (let i = 0; i < 12; i++) rememberRoot(`C:\\w\\p${i}`);
    const list = getRecentRoots();
    expect(list).toHaveLength(8);
    expect(list[0]).toBe("C:\\w\\p11");
  });

  it("存储被写坏时当作空列表，不抛错", () => {
    localStorage.setItem("ncforge-recent-roots", "{not json");
    expect(getRecentRoots()).toEqual([]);
  });
});
