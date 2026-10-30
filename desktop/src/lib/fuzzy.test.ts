import { describe, expect, it } from "vitest";
import { fuzzyMatch, rankFiles, type FileEntry } from "./fuzzy";

const entry = (rel: string): FileEntry => {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return { path: `C:\\w\\${rel.replace(/\//g, "\\")}`, rel, name, dir: rel.slice(0, Math.max(0, rel.length - name.length - 1)) };
};

describe("fuzzyMatch", () => {
  it("不是子序列就是 null，空查询全部命中", () => {
    expect(fuzzyMatch("xyz", "VoucherBO")).toBeNull();
    expect(fuzzyMatch("", "VoucherBO")).toEqual({ score: 0, ranges: [] });
    expect(fuzzyMatch("toolong", "ab")).toBeNull();
  });

  it("驼峰首字母落在词首，而不是贪心地落在前面的小写字母上", () => {
    const hit = fuzzyMatch("vbo", "VoucherBO")!;
    // V / B O —— 不是 V o(ucher)
    expect(hit.ranges).toEqual([[0, 1], [7, 9]]);
  });

  it("连续命中合并成一个区间", () => {
    expect(fuzzyMatch("vouch", "VoucherBO")!.ranges).toEqual([[0, 5]]);
  });

  it("连续和词首都比散落得分高", () => {
    const tight = fuzzyMatch("bo", "VoucherBO")!.score;
    const loose = fuzzyMatch("bo", "abxxxxxxo")!.score;
    expect(tight).toBeGreaterThan(loose);
  });

  it("大小写不敏感，区间按原文下标", () => {
    expect(fuzzyMatch("VOUCHERBO", "voucherbo")!.ranges).toEqual([[0, 9]]);
  });
});

describe("rankFiles", () => {
  const files = [
    "gl/src/nc/bs/gl/VoucherBO.java",
    "gl/src/nc/bs/gl/VoucherDMO.java",
    "gl/src/nc/vo/gl/Voucher.java",
    "gl/META-INF/voucher_template.xml",
    "arap/src/Other.java",
  ].map(entry);

  it("文件名完全相等 > 前缀 > 子串 > 模糊", () => {
    const r = rankFiles(files, "voucher", 10).map((x) => x.entry.name);
    expect(r[0]).toBe("Voucher.java");
    expect(r.slice(1, 3).sort()).toEqual(["VoucherBO.java", "VoucherDMO.java"]);
    expect(r).toContain("voucher_template.xml");
    expect(r).not.toContain("Other.java");
  });

  it("文件名匹配不上时退到整条路径", () => {
    const r = rankFiles(files, "arap/other", 10);
    expect(r).toHaveLength(1);
    expect(r[0].on).toBe("rel");
  });

  it("反斜杠与斜杠等价，条数受 limit 限制", () => {
    expect(rankFiles(files, "gl\\META", 10)).toHaveLength(1);
    expect(rankFiles(files, "v", 2)).toHaveLength(2);
  });

  it("空查询返回空（由调用方决定显示什么）", () => {
    expect(rankFiles(files, "  ", 10)).toEqual([]);
  });
});
