// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readTabSnapshot, saveTabSnapshot } from "./tabPersistence";

beforeEach(() => {
  localStorage.clear();
});

describe("标签快照", () => {
  it("库文件地址不能被当作磁盘文件恢复", () => {
    saveTabSnapshot("C:/work", { tabs: ["nc-library://files/a.jar/config.xml?archive=1", "C:/work/A.java"], activePath: "nc-library://files/a.jar/config.xml?archive=1", splitPath: null });
    expect(readTabSnapshot("C:/work")).toEqual({ tabs: ["C:/work/A.java"], activePath: "C:/work/A.java", splitPath: null });
  });
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

  it("前台与分屏同时超限时两个都要保住（不能互相顶掉末位）", () => {
    const tabs = Array.from({ length: 25 }, (_, i) => `f${i}.java`);
    saveTabSnapshot("C:\\w\\a", { tabs, activePath: "f23.java", splitPath: "f24.java" });
    const snap = readTabSnapshot("C:\\w\\a")!;
    expect(snap.tabs).toHaveLength(20);
    expect(snap.tabs).toContain("f23.java");
    expect(snap.tabs).toContain("f24.java");
    expect(snap.activePath).toBe("f23.java");
    expect(snap.splitPath).toBe("f24.java");
  });

  it("keep 已在截断范围内时不占用别人的槽位", () => {
    const tabs = Array.from({ length: 25 }, (_, i) => `f${i}.java`);
    saveTabSnapshot("C:\\w\\a", { tabs, activePath: "f3.java", splitPath: "f24.java" });
    const snap = readTabSnapshot("C:\\w\\a")!;
    expect(snap.tabs).toHaveLength(20);
    expect(snap.tabs).toContain("f3.java");
    expect(snap.tabs).toContain("f24.java");
    expect(snap.activePath).toBe("f3.java");
    expect(snap.splitPath).toBe("f24.java");
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

it("retains only the latest twenty workspaces", () => {
  for (let i = 0; i < 30; i++) saveTabSnapshot(`root${i}`, { tabs: ["a"], activePath: "a", splitPath: null });
  expect(readTabSnapshot("root0")).toBeNull();
  expect(readTabSnapshot("root9")).toBeNull();
  expect(readTabSnapshot("root10")).not.toBeNull();
  expect(Object.keys(JSON.parse(localStorage.getItem("ncforge-open-tabs")!))).toHaveLength(20);
});
it("observes snapshots changed outside the module cache", () => {
  saveTabSnapshot("root", { tabs: ["a"], activePath: "a", splitPath: null });
  localStorage.setItem("ncforge-open-tabs", JSON.stringify({ root: { tabs: ["b"], activePath: "b", splitPath: null } }));
  expect(readTabSnapshot("root")?.tabs).toEqual(["b"]);
});
