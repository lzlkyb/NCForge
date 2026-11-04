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

// root/bill 是 manifest 登记过的业务组件，root/aim 不是
//   bill/
//     src/public/…  src/client/…  resources/…
//   aim/src/…
const NC_ROOT = "root";
const BILL = j(NC_ROOT, "bill");
const AIM = j(NC_ROOT, "aim");
const BILL_SRC = j(BILL, "src");
const BILL_PUBLIC = j(BILL_SRC, "public");
const BILL_PUBLIC_X = j(BILL_PUBLIC, "x.java");
const ncDirs: Record<string, TreeDirState> = {
  [NC_ROOT]: dir(["bill", "aim"], ["bill", "aim"]),
  [BILL]: dir(["src", "resources"], ["src", "resources"]),
  [BILL_SRC]: dir(["public", "client"], ["public", "client"]),
  [BILL_PUBLIC]: dir(["x.java"]),
  [AIM]: dir(["src", "lib"], ["src", "lib"]),
  [j(AIM, "src")]: dir(["main.java"]),
};

describe("flattenTree 的 NC 结构视图", () => {
  const onlyBill = (d: string) => d.toLowerCase() === BILL.toLowerCase();

  it("摊平：bill 下直接是源码根，src 不占行，路径仍是真实路径", () => {
    const flat = flattenTree(ncDirs, new Set([NC_ROOT, BILL]), NC_ROOT, { hoist: onlyBill });
    const names = flat.map((r) => r.label ?? r.path);
    expect(names).toEqual(["bill", "public", "client", "resources", "aim"]);
    // 行上的路径是磁盘真实路径；显示父级还是 bill（用户看到的层级），
    // 真身所在目录单独放 realParent——展开/收起要拿它去问压缩链
    const pub = flat.find((r) => r.path === BILL_PUBLIC)!;
    expect(pub.parent).toBe(BILL);
    expect(pub.realParent).toBe(BILL_SRC);
    expect(pub.isDir).toBe(true);
  });

  it("摊平：往下展开仍按真实目录走，父级是 bill/src 而不是 bill", () => {
    const flat = flattenTree(ncDirs, new Set([NC_ROOT, BILL, BILL_PUBLIC]), NC_ROOT, {
      hoist: onlyBill,
    });
    const x = flat.find((r) => r.path === BILL_PUBLIC_X)!;
    expect(x.parent).toBe(BILL_PUBLIC);
  });

  it("不摊平（开关关着）：bill 下先看到 src", () => {
    const flat = flattenTree(ncDirs, new Set([NC_ROOT, BILL]), NC_ROOT, { hoist: () => false });
    expect(flat.map((r) => r.label ?? r.path)).toEqual(["bill", "src", "resources", "aim"]);
  });

  it("没登记的 aim 不摊平：它下面照旧是 src/lib", () => {
    const flat = flattenTree(ncDirs, new Set([NC_ROOT, BILL, AIM]), NC_ROOT, {
      hoist: onlyBill,
    });
    expect(flat.map((r) => r.label ?? r.path)).toEqual([
      "bill",
      "public",
      "client",
      "resources",
      "aim",
      "src",
      "lib",
    ]);
  });

  it("src 还没读出来时它也不占行（不会露出半棵树）", () => {
    const partial: Record<string, TreeDirState> = {
      [NC_ROOT]: ncDirs[NC_ROOT],
      [BILL]: ncDirs[BILL],
    };
    const flat = flattenTree(partial, new Set([NC_ROOT, BILL]), NC_ROOT, { hoist: onlyBill });
    expect(flat.map((r) => r.label ?? r.path)).toEqual(["bill", "resources", "aim"]);
  });

  it("src 读失败时原样露出 src，错误不被吞掉", () => {
    const broken: Record<string, TreeDirState> = {
      ...ncDirs,
      [BILL_SRC]: { status: "error", message: "拒绝访问" },
    };
    const flat = flattenTree(broken, new Set([NC_ROOT, BILL]), NC_ROOT, { hoist: onlyBill });
    expect(flat.map((r) => r.label ?? r.path)).toEqual(["bill", "src", "resources", "aim"]);
  });
});

describe("treeKeyAction 在 NC 结构视图下", () => {
  const flat = flattenTree(ncDirs, new Set([NC_ROOT, BILL, BILL_PUBLIC]), NC_ROOT, {
    hoist: (d: string) => d.toLowerCase() === BILL.toLowerCase(),
  });

  it("右：从 bill 进第一个子项，落到摊平后的 public 上", () => {
    const act = treeKeyAction("ArrowRight", flat, { path: BILL, isDir: true }, new Set([NC_ROOT, BILL]));
    expect(act).toEqual({ kind: "select", path: BILL_PUBLIC, isDir: true });
  });

  it("左：从摊平后的 public 回到看得见的父行 bill，不是隐藏的 bill/src", () => {
    // public 收起时左键才是「回父行」；展开着的话先收起（现有语义，不动）
    const collapsed = flattenTree(ncDirs, new Set([NC_ROOT, BILL]), NC_ROOT, {
      hoist: (d: string) => d.toLowerCase() === BILL.toLowerCase(),
    });
    const act = treeKeyAction(
      "ArrowLeft",
      collapsed,
      { path: BILL_PUBLIC, isDir: true },
      new Set([NC_ROOT, BILL]),
    );
    expect(act).toEqual({ kind: "select", path: BILL, isDir: true });
  });

  it("右右左一圈：从 bill 能下到 x.java 再回 public", () => {
    const exp = new Set([NC_ROOT, BILL, BILL_PUBLIC]);
    const at = (p: string) => flat.findIndex((r) => r.path === p);
    expect(treeKeyAction("ArrowRight", flat, { path: BILL_PUBLIC, isDir: true }, exp)).toEqual({
      kind: "select",
      path: BILL_PUBLIC_X,
      isDir: false,
    });
    expect(treeKeyAction("ArrowLeft", flat, { path: BILL_PUBLIC_X, isDir: false }, exp)).toEqual({
      kind: "select",
      path: BILL_PUBLIC,
      isDir: true,
    });
    expect(at(BILL_PUBLIC_X)).toBeGreaterThan(at(BILL_PUBLIC));
  });
});
