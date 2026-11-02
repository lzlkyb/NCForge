import { describe, expect, it } from "vitest";
import { parseLineQuery, rankFilesRecent, recentFirst } from "./gotoAnything";
import type { FileEntry } from "./fuzzy";

const entry = (path: string): FileEntry => ({
  path,
  rel: path.replace(/^C:\\w\\/, "").replace(/\\/g, "/"),
  name: path.slice(path.lastIndexOf("\\") + 1),
  dir: "",
});

describe("行号解析", () => {
  it("认 :行号 与 :行号:列号", () => {
    expect(parseLineQuery(":12")).toEqual({ line: 12 });
    expect(parseLineQuery(" :12:5 ")).toEqual({ line: 12, column: 5 });
  });

  it("非数字 / 0 / 多余字符一律不认（宁可给提示，不要跳到第 1 行）", () => {
    expect(parseLineQuery(":")).toBeNull();
    expect(parseLineQuery(":0")).toBeNull();
    expect(parseLineQuery(":12a")).toBeNull();
    expect(parseLineQuery(":12:0")).toBeNull();
    expect(parseLineQuery("12")).toBeNull();
  });
});

describe("最近使用排序", () => {
  const items = ["a", "b", "c", "d"];

  it("最近用过的排前面，其余保持原顺序", () => {
    expect(recentFirst(items, (x) => x, ["c", "a"])).toEqual(["c", "a", "b", "d"]);
  });

  it("路径大小写不敏感；没有最近记录时原样返回", () => {
    expect(recentFirst(["C:\\w\\A.java"], (x) => x, ["c:\\W\\a.java"])).toEqual(["C:\\w\\A.java"]);
    expect(recentFirst(items, (x) => x, [])).toBe(items);
  });

  it("文件排序：最近加成能顶到同分附近，但压不过文件名完全相等", () => {
    const files = [entry("C:\\w\\Keep.java"), entry("C:\\w\\Key.java"), entry("C:\\w\\OldKey.java")];
    // "Key" 与 Key.java 完全相等（+200），即使 OldKey 最近打开也不该超过它
    const ranked = rankFilesRecent(files, "Key", 10, ["C:\\w\\OldKey.java"]);
    expect(ranked[0].entry.name).toBe("Key.java");
    expect(ranked.map((r) => r.entry.name)).toContain("OldKey.java");
  });

  it("最近加成按顺位递减：同分时越近越靠前", () => {
    const files = [entry("C:\\w\\KeyA.java"), entry("C:\\w\\KeyB.java")];
    const ranked = rankFilesRecent(files, "Key", 10, ["C:\\w\\KeyB.java", "C:\\w\\KeyA.java"]);
    expect(ranked.map((r) => r.entry.name)).toEqual(["KeyB.java", "KeyA.java"]);
  });

  it("最近加成只在同分附近起作用：完全不匹配的最近文件不会凭空出现", () => {
    const files = [entry("C:\\w\\Alpha.java"), entry("C:\\w\\Beta.java")];
    const ranked = rankFilesRecent(files, "Alpha", 10, ["C:\\w\\Beta.java"]);
    expect(ranked.map((r) => r.entry.name)).toEqual(["Alpha.java"]);
  });
});
