import { describe, expect, it } from "vitest";
import { isHeavyFile, LARGE_FILE_BYTES, LARGE_FILE_LINES } from "./largeFile";

describe("isHeavyFile", () => {
  it("普通源码不降级", () => {
    expect(isHeavyFile({ lines: 300, bytes: 12 * 1024 })).toBe(false);
  });

  it("行数超阈就降级，字节没超也算", () => {
    expect(isHeavyFile({ lines: LARGE_FILE_LINES + 1, bytes: 1024 })).toBe(true);
  });

  it("字节超阈就降级：报文 XML / 整年 SQL 行数不多但单行极长", () => {
    expect(isHeavyFile({ lines: 600, bytes: LARGE_FILE_BYTES + 1 })).toBe(true);
  });

  it("两条线都是「严格大于」，正好等于不算大文件", () => {
    expect(isHeavyFile({ lines: LARGE_FILE_LINES, bytes: 1024 })).toBe(false);
    expect(isHeavyFile({ lines: 10, bytes: LARGE_FILE_BYTES })).toBe(false);
    expect(isHeavyFile({ lines: LARGE_FILE_LINES, bytes: LARGE_FILE_BYTES })).toBe(false);
  });

  it("后台恢复的空标签（还没读到内容）不降级", () => {
    expect(isHeavyFile({ lines: 0, bytes: 0 })).toBe(false);
  });
});