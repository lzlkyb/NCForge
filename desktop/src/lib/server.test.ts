import { describe, expect, it } from "vitest";
import { formatHeapMb } from "./server";

/**
 * 堆上限的显示文案。
 *
 * 规则看着琐碎，但错了会让人白找半天：把 2560（2.5G）显示成 `2 GB` 会让用户以为
 * 自己填的数被改了；把 4096 显示成 `4096 MB` 又不像大家平时说的「4G」。
 */
describe("formatHeapMb", () => {
  it("整 G 用 GB 显示", () => {
    expect(formatHeapMb(1024)).toBe("1 GB");
    expect(formatHeapMb(3072)).toBe("3 GB");
    expect(formatHeapMb(4096)).toBe("4 GB");
    expect(formatHeapMb(8192)).toBe("8 GB");
  });

  it("非整 G 保留 MB，不四舍五入成 G", () => {
    expect(formatHeapMb(512)).toBe("512 MB");
    expect(formatHeapMb(2560)).toBe("2560 MB");
    expect(formatHeapMb(5632)).toBe("5632 MB");
    expect(formatHeapMb(65536)).toBe("64 GB");
  });

  it("非法值给破折号，不显示 0 或 NaN", () => {
    expect(formatHeapMb(0)).toBe("—");
    expect(formatHeapMb(-1)).toBe("—");
    expect(formatHeapMb(Number.NaN)).toBe("—");
  });
});
