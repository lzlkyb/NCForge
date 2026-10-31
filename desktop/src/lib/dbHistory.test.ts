/**
 * 历史检索：跨连接摊平、只搜结果也能搜到、命中高亮区间。
 *
 * 这几条都是「不做测试也不会报错、但用户会沉默地找不到东西」的地方：
 * 搜 `ORA-00942` 只搜 SQL 文本永远搜不到；高亮区间算错会让长 SQL 里的 mark 标到别的字上。
 */
import { describe, expect, it } from "vitest";

import { filterHits, historyHits, matchRanges } from "./dbHistory";

const e = (at: number, sql: string, summary = "1 行", ok = true) => ({ at, sql, ms: 10, summary, ok });

const MAP = {
  a: [e(300, "select * from t_a"), e(100, "delete from t_a where id = 1", "更新 1 行", false)],
  b: [e(200, "select * from t_b", "ORA-00942: 表或视图不存在", false)],
};

describe("historyHits", () => {
  it("单连接：只取这个连接，顺序照旧", () => {
    const hits = historyHits(MAP, "a", false);
    expect(hits.map((h) => h.entry.at)).toEqual([300, 100]);
    expect(hits.every((h) => h.connId === "a")).toBe(true);
  });

  it("全部连接：混起来按时间倒序（用户记的是「上午跑过」，不是「在哪个库跑过」）", () => {
    expect(historyHits(MAP, "a", true).map((h) => h.entry.at)).toEqual([300, 200, 100]);
  });

  it("连接不存在时返回空，不抛", () => {
    expect(historyHits(MAP, "zzz", false)).toEqual([]);
  });
});

describe("filterHits", () => {
  const all = historyHits(MAP, "a", true);

  it("关键词命中 SQL", () => {
    expect(filterHits(all, "t_b").map((h) => h.entry.sql)).toEqual(["select * from t_b"]);
  });

  it("关键词只出现在结果摘要里也能搜到（错误码就是这种）", () => {
    const hits = filterHits(all, "ora-00942");
    expect(hits).toHaveLength(1);
    expect(hits[0].connId).toBe("b");
  });

  it("多个关键词要求全部命中（在不同字段里也算）", () => {
    // 「select」在 SQL 里，「不存在」在摘要里
    expect(filterHits(all, "t_b 不存在")).toHaveLength(1);
    expect(filterHits(all, "t_a 不存在")).toEqual([]);
  });

  it("只看失败", () => {
    expect(filterHits(all, "", true).map((h) => h.entry.at)).toEqual([200, 100]);
  });

  it("空查询返回全部（不看失败时）", () => {
    expect(filterHits(all, "   ")).toHaveLength(3);
  });
});

describe("matchRanges", () => {
  it("多处命中都标出来", () => {
    expect(matchRanges("ab ab ab", "ab")).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ]);
  });

  it("重叠与相邻的区间合并，且不越界", () => {
    // 「abc」0..3 与「cde」2..5 在 index 2 处重叠 → 合成 0..5
    expect(matchRanges("abcde", "abc cde")).toEqual([{ start: 0, end: 5 }]);
    // 「ab」0..2 与「bc」1..3 重叠 → 0..3（不是 0..4：bc 的 c 在 index 2）
    expect(matchRanges("abcde", "ab bc")).toEqual([{ start: 0, end: 3 }]);
  });

  it("大小写不敏感，但返回的是原文的位置", () => {
    expect(matchRanges("Select * From", "SELECT")).toEqual([{ start: 0, end: 6 }]);
  });

  it("关键词里带正则元字符不会当成正则", () => {
    expect(matchRanges("a(b)c", "(")).toEqual([{ start: 1, end: 2 }]);
    expect(matchRanges("xa*b", "*")).toEqual([{ start: 2, end: 3 }]);
    // 若被当成正则，`.` 会匹配任意字符并命中 3 次
    expect(matchRanges("abc", ".")).toEqual([]);
  });

  it("没命中或空查询返回空数组", () => {
    expect(matchRanges("abc", "zzz")).toEqual([]);
    expect(matchRanges("abc", "  ")).toEqual([]);
  });
});
