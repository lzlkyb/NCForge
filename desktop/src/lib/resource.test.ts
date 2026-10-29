import { describe, expect, it } from "vitest";
import { allPacksReady, formatBytes, packStateLabel, type PackStatusInfo } from "./resource";

describe("formatBytes", () => {
  it("按量级选单位：B / KB / MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(100 * 1024)).toBe("100 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(6_700_000)).toBe("6.4 MB");
  });

  it("≥100MB 取整，避免 102.4MB 这种噪音", () => {
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 MB");
    expect(formatBytes(120 * 1024 * 1024)).toBe("120 MB");
    // 63.8MB（安装包实测值）不足 100MB，仍走一位小数
    expect(formatBytes(63_800_000)).toBe("60.8 MB");
  });

  it("无效输入（null / undefined / 负数 / NaN）统一显示占位符", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("packStateLabel", () => {
  it("三种状态各有中文标签", () => {
    expect(packStateLabel("installed")).toBe("已安装");
    expect(packStateLabel("legacy")).toBe("旧版沿用");
    expect(packStateLabel("missing")).toBe("未下载");
  });
});

describe("allPacksReady", () => {
  const pack = (state: PackStatusInfo["state"]): PackStatusInfo => ({
    id: "ecj",
    title: "Java 编译器",
    notes: "编译 NC 模块",
    state,
    version: null,
    size: null,
  });

  it("空快照不算就绪（状态还没读出来）", () => {
    expect(allPacksReady([])).toBe(false);
  });

  it("有任何一个 missing 就不就绪", () => {
    expect(allPacksReady([pack("installed"), pack("missing")])).toBe(false);
  });

  it("installed 与 legacy 混算也算就绪（finder 两条路都认）", () => {
    expect(allPacksReady([pack("installed"), pack("legacy")])).toBe(true);
  });
});
