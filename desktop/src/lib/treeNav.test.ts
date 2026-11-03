import { describe, expect, it } from "vitest";
import { flattenTree, treeKeyAction, type FlatRow } from "./treeNav";
import type { TreeDirState } from "./workspaceSession";
import { joinPath } from "./workspace";

/** 路径用 joinPath 拼：Windows 反斜杠、Unix 斜杠，两边跑测试都对得上。 */
const j = (...parts: string[]) => parts.reduce((a, b) => joinPath(a, b));

const dir = (names: string[], dirs: string[] = []): TreeDirState => ({
  status: "ok",
  items: names.map((name) => ({ name, isDir: dirs.includes(name), size: 0 })),
});

// root
//   a/           ← 展开
//     x.java
//     sub/       ← 展开
//       y.java
//   b.java
const ROOT = "root";
const A = j(ROOT, "a");
const SUB = j(A, "sub");
const dirs: Record<string, TreeDirState> = {
  [ROOT]: dir(["a", "b.java"], ["a"]),
  [A]: dir(["x.java", "sub"], ["sub"]),
  [SUB]: dir(["y.java"]),
};
const expanded = new Set([A, SUB]);

const names = (flat: FlatRow[]) => flat.map((r) => r.path);

describe("flattenTree", () => {
  it("只摊平已展开的目录，顺序即显示顺序", () => {
    expect(names(flattenTree(dirs, expanded, ROOT))).toEqual([
      A,
      j(A, "x.java"),
      SUB,
      j(SUB, "y.java"),
      j(ROOT, "b.java"),
    ]);
  });

  it("收起的目录不往下走", () => {
    const flat = flattenTree(dirs, new Set([A]), ROOT);
    expect(names(flat)).toEqual([A, j(A, "x.java"), SUB, j(ROOT, "b.java")]);
  });
});

// root/com/aier/erp/ 是一路单链，erp 下面才有文件
const COM = j(ROOT, "com");
const AIER = j(COM, "aier");
const ERP = j(AIER, "erp");
const chainDirs: Record<string, TreeDirState> = {
  [ROOT]: dir(["com"], ["com"]),
  [COM]: dir(["aier"], ["aier"]),
  [AIER]: dir(["erp"], ["erp"]),
  [ERP]: dir(["Deep.java"]),
};

describe("flattenTree 的压缩中间包", () => {
  it("单链只占一行，路径指向链尾，显示名用点连起来", () => {
    const flat = flattenTree(chainDirs, new Set([ROOT]), ROOT);
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ path: ERP, isDir: true, label: "com.aier.erp", parent: null });
  });

  it("关掉压缩后每层各占一行，父子关系按真实目录", () => {
    const flat = flattenTree(chainDirs, new Set([ROOT, COM]), ROOT, { compact: false });
    expect(flat.map((r) => [r.path, r.parent, r.label])).toEqual([
      [COM, null, "com"],
      [AIER, COM, "aier"],
    ]);
  });
});

describe("flattenTree 的多工程根", () => {
  const OTHER = "other";
  const multiDirs: Record<string, TreeDirState> = {
    ...dirs,
    [OTHER]: dir(["lib.java"]),
  };

  it("每个工程根先占一行，展开后才走子项", () => {
    const roots = [
      { path: ROOT, label: "newar" },
      { path: OTHER, label: "lib" },
    ];
    const flat = flattenTree(multiDirs, new Set([A, SUB, OTHER]), roots, { projectRows: true });

    expect(flat[0]).toMatchObject({
      path: ROOT,
      project: true,
      isDir: true,
      parent: null,
      label: "newar",
    });
    expect(names(flat)).toContain(j(OTHER, "lib.java"));
    // 工程根自己展开后，子项挂在它下面
    const libRow = flat.find((r) => r.path === OTHER)!;
    expect(libRow.project).toBe(true);
    expect(flat.find((r) => r.path === j(OTHER, "lib.java"))!.parent).toBe(OTHER);
  });

  it("收起的工程只占一行，不往下走", () => {
    const flat = flattenTree(multiDirs, new Set([A]), [{ path: ROOT }, { path: OTHER }], {
      projectRows: true,
    });
    expect(flat.map((r) => r.path)).not.toContain(j(OTHER, "lib.java"));
    expect(flat.find((r) => r.path === OTHER)!.project).toBe(true);
  });

  it("压缩链只作用于工程内的目录，不把工程根吸进链里", () => {
    const flat = flattenTree(chainDirs, new Set([ROOT]), [{ path: ROOT }], {
      projectRows: true,
    });
    expect(flat[0]).toMatchObject({ path: ROOT, project: true, label: undefined });
    // com/aier/erp 仍是链尾一行，父级是工程根
    expect(flat[1]).toMatchObject({ path: ERP, label: "com.aier.erp", parent: ROOT });
  });
});

describe("treeKeyAction", () => {
  const flat = flattenTree(dirs, expanded, ROOT);
  const at = (path: string) => flat.find((r) => r.path === path)!;

  it("上下移动不越过首尾", () => {
    expect(treeKeyAction("ArrowDown", flat, null, expanded)).toEqual({
      kind: "select",
      path: A,
      isDir: true,
    });
    const last = j(ROOT, "b.java");
    expect(treeKeyAction("ArrowDown", flat, at(last), expanded)).toEqual({
      kind: "select",
      path: last,
      isDir: false,
    });
    expect(treeKeyAction("ArrowUp", flat, at(A), expanded)).toEqual({
      kind: "select",
      path: A,
      isDir: true,
    });
  });

  it("右：未展开先展开，已展开进第一个子项", () => {
    expect(treeKeyAction("ArrowRight", flat, at(A), new Set())).toEqual({
      kind: "toggle",
      path: A,
    });
    expect(treeKeyAction("ArrowRight", flat, at(A), expanded)).toEqual({
      kind: "select",
      path: j(A, "x.java"),
      isDir: false,
    });
    // 文件上按右没有动作，也不该报错
    expect(treeKeyAction("ArrowRight", flat, at(j(ROOT, "b.java")), expanded)).toBeNull();
  });

  it("左：展开的目录先收起，否则回到父目录", () => {
    expect(treeKeyAction("ArrowLeft", flat, at(SUB), expanded)).toEqual({
      kind: "toggle",
      path: SUB,
    });
    expect(treeKeyAction("ArrowLeft", flat, at(j(A, "x.java")), new Set([A]))).toEqual({
      kind: "select",
      path: A,
      isDir: true,
    });
  });

  it("Enter / 空格：目录展开，文件打开", () => {
    expect(treeKeyAction("Enter", flat, at(A), expanded)).toEqual({ kind: "toggle", path: A });
    expect(treeKeyAction(" ", flat, at(j(ROOT, "b.java")), expanded)).toEqual({
      kind: "open",
      path: j(ROOT, "b.java"),
    });
  });

  it("Home / End 跳到首尾", () => {
    expect(treeKeyAction("Home", flat, at(SUB), expanded)).toEqual({
      kind: "select",
      path: A,
      isDir: true,
    });
    expect(treeKeyAction("End", flat, null, expanded)).toEqual({
      kind: "select",
      path: j(ROOT, "b.java"),
      isDir: false,
    });
  });

  it("不是导航键就不接管", () => {
    expect(treeKeyAction("F2", flat, at(A), expanded)).toBeNull();
  });
});
