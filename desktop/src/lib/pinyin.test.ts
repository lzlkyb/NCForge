import { describe, expect, it } from "vitest";
import { matchInitials, matchText, pinyinInitials } from "./pinyin";

describe("拼音首字母", () => {
  it("常见的多字标题映射成首字母串", () => {
    expect(pinyinInitials("编译当前模块")?.text).toBe("bydqmk");
    expect(pinyinInitials("全工程搜索")?.text).toBe("qgcss");
  });

  it("标点与空白不占位，ASCII 字母数字原样保留", () => {
    const p = pinyinInitials("工具：NCC / BIP 报文解密")!;
    expect(p.text).toBe("gjnccbipbwjm");
    expect(p.chars[0]).toBe(0);
    expect(p.chars[1]).toBe(1);
  });

  it("纯英文没有首字母映射（交给原有模糊匹配）", () => {
    expect(pinyinInitials("VoucherBO")).toBeNull();
    expect(matchInitials("vbo", "VoucherBO")).toBeNull();
  });

  it("命中区间映射回原文，供列表高亮", () => {
    const hit = matchInitials("bydq", "编译当前模块")!;
    expect(hit.ranges).toEqual([[0, 4]]);
  });

  it("matchText 在原文与首字母之间取更高分", () => {
    expect(matchText("编译", "编译当前模块")?.ranges).toEqual([[0, 2]]);
    expect(matchText("bydq", "编译当前模块")?.ranges).toEqual([[0, 4]]);
    expect(matchText("zzz", "编译当前模块")).toBeNull();
  });
});
