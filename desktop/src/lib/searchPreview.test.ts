import { describe, expect, it } from "vitest";
import { buildSearchPreview } from "./searchPreview";

describe("搜索命中上下文", () => {
  it("长行围绕第一命中裁剪，全部可见区间按展示副本重映射", () => {
    const text = `${"x".repeat(160)}billSave(); billLoad();${"y".repeat(160)}`;
    const ranges = [{ start: 160, end: 168 }, { start: 172, end: 180 }];
    const preview = buildSearchPreview(text, ranges);
    expect(preview.text).toMatch(/^…x{8}billSave/);
    expect(preview.text.endsWith("…")).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(82);
    expect(preview.ranges).toEqual([{ start: 9, end: 17 }, { start: 21, end: 29 }]);
    expect(ranges).toEqual([{ start: 160, end: 168 }, { start: 172, end: 180 }]);
  });

  it("UTF-16 位置保留 emoji 高亮，不把裁剪边界的代理对拆开", () => {
    const text = `${"x".repeat(100)}😀${"y".repeat(7)}命中${"z".repeat(69)}😀tail`;
    // 起点本应落在第一个 emoji 的低代理项，终点也落在第二个 emoji 内。
    const preview = buildSearchPreview(text, [{ start: 109, end: 111 }]);
    expect(preview.text.startsWith("…😀")).toBe(true);
    expect(preview.text.endsWith("😀…")).toBe(true);
    const range = preview.ranges[0];
    expect(preview.text.slice(range.start, range.end)).toBe("命中");
    const emoji = buildSearchPreview("前😀后", [{ start: 1, end: 3 }]);
    expect(emoji.text.slice(emoji.ranges[0].start, emoji.ranges[0].end)).toBe("😀");
  });

  it("首尾命中都不增加多余省略号，跨窗口范围夹到可见文本", () => {
    expect(buildSearchPreview("abc", [{ start: 0, end: 3 }])).toEqual({
      text: "abc", ranges: [{ start: 0, end: 3 }],
    });
    const preview = buildSearchPreview("x".repeat(120), [{ start: 110, end: 140 }]);
    expect(preview.text.endsWith("…")).toBe(false);
    expect(preview.ranges).toEqual([{ start: 9, end: 19 }]);
  });

  it("缺失或已超出后端截断文本的范围不凭空重新匹配", () => {
    expect(buildSearchPreview("billSave", []).ranges).toEqual([]);
    expect(buildSearchPreview("billSave…", [{ start: 320, end: 328 }]).ranges).toEqual([]);
    expect(buildSearchPreview("", []).text).toBe("");
  });
});
