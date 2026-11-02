// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readTabSnapshot, saveTabSnapshot } from "./tabPersistence";

beforeEach(() => {
  localStorage.clear();
});

describe("标签快照", () => {
  it("存了能原样读回（标签顺序 / 激活项 / 分屏）", () => {
    saveTabSnapshot("C:\\w\\a", {
      tabs: ["C:\\w\\a\\A.java", "C:\\w\\a\\B.java"],
      activePath: "C:\\w\\a\\B.java",
      splitPath: "C:\\w\\a\\A.java",
    });
    expect(readTabSnapshot("c:\\W\\A")).toEqual({
      tabs: ["C:\\w\\a\\A.java", "C:\\w\\a\\B.java"],
      activePath: "C:\\w\\a\\B.java",
      splitPath: "C:\\w\\a\\A.java",
    });
  });

  it("不同工作区互不影响", () => {
    saveTabSnapshot("C:\\w\\a", { tabs: ["a1"], activePath: "a1", splitPath: null });
    saveTabSnapshot("C:\\w\\b", { tabs: ["b1"], activePath: "b1", splitPath: null });
    expect(readTabSnapshot("C:\\w\\a")?.tabs).toEqual(["a1"]);
    expect(readTabSnapshot("C:\\w\\b")?.tabs).toEqual(["b1"]);
  });

  it("jdt:// 与超过 20 个的部分不存；激活项失效时退回第一个", () => {
    const tabs = ["jdt://contents/A.class", ...Array.from({ length: 25 }, (_, i) => `f${i}.java`)];
    saveTabSnapshot("C:\\w\\a", { tabs, activePath: "not-open.java", splitPath: "jdt://contents/A.class" });
    const snap = readTabSnapshot("C:\\w\\a")!;
    expect(snap.tabs).toHaveLength(20);
    expect(snap.tabs.some((p) => p.startsWith("jdt://"))).toBe(false);
    expect(snap.activePath).toBe("f0.java");
    expect(snap.splitPath).toBeNull();
  });

  it("关光标签后快照是空的，重启不再恢复", () => {
    saveTabSnapshot("C:\\w\\a", { tabs: ["a"], activePath: "a", splitPath: null });
    saveTabSnapshot("C:\\w\\a", { tabs: [], activePath: null, splitPath: null });
    expect(readTabSnapshot("C:\\w\\a")).toBeNull();
  });

  it("存储被写坏时当作没有快照", () => {
    localStorage.setItem("ncforge-open-tabs", "[]");
    expect(readTabSnapshot("C:\\w\\a")).toBeNull();
  });
});
