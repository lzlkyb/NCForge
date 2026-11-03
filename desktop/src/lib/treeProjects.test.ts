import { describe, expect, it } from "vitest";
import { isUnderPath, projectForPath, resolvableProjects } from "./treeProjects";
import type { LinkedProject } from "./linkedProjects";

const project = (name: string, root: string | null, depth = 0): LinkedProject => ({
  name,
  root,
  origin: depth === 0 ? "primary" : "classpath",
  depth,
  exported: false,
  classDirs: [],
  disabled: false,
  hasClasspath: true,
});

describe("isUnderPath", () => {
  it("含根自身，且按 Windows 规则不分大小写", () => {
    expect(isUnderPath("C:\\w\\newar", "C:\\w\\newar")).toBe(true);
    expect(isUnderPath("c:\\W\\NEWAR\\a\\B.java", "C:\\w\\newar")).toBe(true);
  });

  it("前缀相同但不在树上（newar2）不算", () => {
    expect(isUnderPath("C:\\w\\newar2\\A.java", "C:\\w\\newar")).toBe(false);
  });

  it("其它盘符 / 兄弟目录都不算", () => {
    expect(isUnderPath("D:\\w\\newar\\A.java", "C:\\w\\newar")).toBe(false);
    expect(isUnderPath("C:\\w\\other\\A.java", "C:\\w\\newar")).toBe(false);
  });
});

describe("resolvableProjects", () => {
  it("丢掉磁盘上找不到的工程与重复根（不区分大小写）", () => {
    const list = [
      project("newar", "C:\\w\\newar"),
      project("bad", null, 1),
      project("NEWAR", "c:\\W\\newar", 1),
      project("lib", "C:\\w\\lib", 1),
    ];
    expect(resolvableProjects(list).map((p) => p.name)).toEqual(["newar", "lib"]);
  });
});

describe("projectForPath", () => {
  const projects = [
    project("newar", "C:\\w\\newar"),
    project("modules", "C:\\w\\newar\\modules", 1),
    project("lib", "C:\\w\\lib", 1),
  ];

  it("根互相嵌套时归给最长（最具体）的那个", () => {
    expect(projectForPath("C:\\w\\newar\\modules\\ic\\A.java", projects)?.name).toBe("modules");
  });

  it("不在任何工程里返回 undefined", () => {
    expect(projectForPath("E:\\tmp\\A.java", projects)).toBeUndefined();
  });
});
