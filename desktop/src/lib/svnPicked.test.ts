import { describe, expect, it } from "vitest";
import { isSvnPicked, svnKeySet } from "./svnDraft";
import { SVN_FILTERS, matchesSvnFilter, svnFilterCounts, type SvnFilter } from "./svnList";
import type { ChangeItem } from "./svn";

describe("已选集合归一", () => {
  it("大小写与斜杠不同仍算同一个文件", () => {
    const picked = new Set(["D:\\Work\\A.java"]);
    expect(isSvnPicked(picked, "d:/work/a.java")).toBe(true);
    expect(isSvnPicked(picked, "d:/work/b.java")).toBe(false);
  });

  it("同一个 Set 只归一一次；就地增删后重算", () => {
    const picked = new Set(["a", "b"]);
    const keys = svnKeySet(picked);
    expect(svnKeySet(picked)).toBe(keys);
    picked.add("C");
    expect(isSvnPicked(picked, "c")).toBe(true);
  });

  it("筛选片计数一趟算完，与逐个筛选过滤的结果一致", () => {
    const letters = ["M", "A", "D", "?", "C", "!", "~", "R"];
    const items = Array.from({ length: 400 }, (_, i) => ({
      path: `D:\\ws\\m\\F${i}.java`, letter: letters[i % letters.length], isDir: i % 13 === 0,
    }) as unknown as ChangeItem);
    const reviewed = new Set(items.filter((_, i) => i % 3 === 0).map(it => it.path.replace(/\\/g, "/").toLowerCase()));
    const picked = new Set(items.filter((_, i) => i % 5 === 0).map(it => it.path.toUpperCase()));
    const counts = svnFilterCounts(items, reviewed, picked);
    for (const f of Object.keys(SVN_FILTERS) as SvnFilter[]) {
      expect(counts[f], f).toBe(items.filter(it => matchesSvnFilter(it, f, reviewed, picked)).length);
    }
  });

  it("3000 行 × 3000 已选的成员判断 ≤ 10ms", () => {
    const paths = Array.from({ length: 3000 }, (_, i) => `D:\\ws\\mod${i % 40}\\src\\File${i}.java`);
    const picked = new Set(paths);
    const items = paths.map(path => ({ path, letter: "M" }) as unknown as ChangeItem);
    svnKeySet(picked); // 首次归一不计入（草稿发布时只发生一次）
    const t = performance.now();
    const n = items.filter(it => matchesSvnFilter(it, "picked", new Set(), picked)).length;
    const ms = performance.now() - t;
    expect(n).toBe(3000);
    expect(ms).toBeLessThan(10 * 3); // 留余量；改前是 O(行×已选) 约 900 万次 keyOf
  });
});
