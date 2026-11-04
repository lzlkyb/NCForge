import { describe, expect, it } from "vitest";
import { SRC_DIR, ncDepthOffset, visibleChildren } from "./ncStructure";
import { joinPath } from "./workspace";
import type { TreeDirState } from "./workspaceSession";

const j = (...parts: string[]) => parts.reduce((a, b) => joinPath(a, b));

/** 只装「读成功」的目录：这样 `x.items` 能直接取，不用在每个用例里收窄。 */
type OkDir = Extract<TreeDirState, { status: "ok" }>;

const dir = (names: string[], dirs: string[] = []): OkDir => ({
  status: "ok",
  items: names.map((name) => ({ name, isDir: dirs.includes(name), size: 0 })),
});

const err = (message: string): TreeDirState => ({ status: "error", message });

/** newar/bill 的样子：`src/{public,client,private,test}` + `resources` + `META-INF`。 */
const ROOT = "root";
const MOD = j(ROOT, "bill");
const SRC = j(MOD, SRC_DIR);
const moduleDirs: Record<string, OkDir> = {
  [ROOT]: dir(["bill"], ["bill"]),
  [MOD]: dir(["src", "resources", "META-INF"], ["src", "resources", "META-INF"]),
  [SRC]: dir(["public", "client", "private", "test"], ["public", "client", "private", "test"]),
  [j(SRC, "public")]: dir(["A.java", "b"], ["b"]),
};

const names = (kids: { dir: string; item: { name: string } }[]) => kids.map((k) => k.item.name);

describe("visibleChildren", () => {
  it("关掉摊平时原样返回，父目录就是这一层自己", () => {
    const kids = visibleChildren(MOD, moduleDirs[MOD].items, {
      hoist: false,
      dirs: moduleDirs,
    });
    expect(names(kids)).toEqual(["src", "resources", "META-INF"]);
    expect(kids.every((k) => k.dir === MOD)).toBe(true);
  });

  it("摊平时 src 不占位，它的子目录顶到模块这一层", () => {
    const kids = visibleChildren(MOD, moduleDirs[MOD].items, {
      hoist: true,
      dirs: moduleDirs,
    });
    expect(names(kids)).toEqual([
      "public",
      "client",
      "private",
      "test",
      "resources",
      "META-INF",
    ]);
  });

  it("摊平后的行仍带真实路径：父目录记成 src，不是虚拟出来的", () => {
    const kids = visibleChildren(MOD, moduleDirs[MOD].items, {
      hoist: true,
      dirs: moduleDirs,
    });
    const pub = kids.find((k) => k.item.name === "public")!;
    expect(pub.dir).toBe(SRC);
    expect(joinPath(pub.dir, pub.item.name)).toBe(j(SRC, "public"));
    // resources 不是 src 的子目录，父目录仍是模块本身
    expect(kids.find((k) => k.item.name === "resources")!.dir).toBe(MOD);
  });

  it("src 还没读出来时它也不显示（由 useTreeLoad 预读补上）", () => {
    const kids = visibleChildren(MOD, moduleDirs[MOD].items, { hoist: true, dirs: {} });
    expect(names(kids)).toEqual(["resources", "META-INF"]);
  });

  it("src 读失败要把 src 原样露出来，不能把错误吞掉", () => {
    const kids = visibleChildren(MOD, moduleDirs[MOD].items, {
      hoist: true,
      dirs: { [MOD]: moduleDirs[MOD], [SRC]: err("拒绝访问") },
    });
    expect(names(kids)).toEqual(["src", "resources", "META-INF"]);
    expect(kids.every((k) => k.dir === MOD)).toBe(true);
  });

  it("没有 src 的模块（纯 resources）摊平后原样显示", () => {
    const plain = dir(["resources"], ["resources"]);
    const kids = visibleChildren(MOD, plain.items, { hoist: true, dirs: { [MOD]: plain } });
    expect(names(kids)).toEqual(["resources"]);
  });

  it("大小写不同的 src 也认（NC 工具生成的工程里有 Src）", () => {
    const odd = dir(["Src", "resources"], ["Src", "resources"]);
    const kids = visibleChildren(MOD, odd.items, {
      hoist: true,
      dirs: { [MOD]: odd, [j(MOD, "Src")]: dir(["public"], ["public"]) },
    });
    expect(names(kids)).toEqual(["public", "resources"]);
  });
});

describe("ncDepthOffset", () => {
  const hoisted = (dir: string) => dir.toLowerCase() === MOD.toLowerCase();

  it("摊平后的源码根比真实路径少一层，跟 resources 同级", () => {
    expect(ncDepthOffset(ROOT, j(SRC, "public"), hoisted)).toBe(-1);
    // 更深层的目录也只摊掉 src 这一层
    expect(ncDepthOffset(ROOT, j(SRC, "public", "b"), hoisted)).toBe(-1);
  });

  it("模块自己、模块下的非 src 目录不受影响", () => {
    expect(ncDepthOffset(ROOT, MOD, hoisted)).toBe(0);
    expect(ncDepthOffset(ROOT, j(MOD, "resources"), hoisted)).toBe(0);
  });

  it("src 本身是隐藏的，不给它算偏移", () => {
    expect(ncDepthOffset(ROOT, SRC, hoisted)).toBe(0);
  });

  it("不是业务组件的模块不摊平（aim 没登记在 manifest 里）", () => {
    expect(ncDepthOffset(ROOT, j(SRC, "public"), () => false)).toBe(0);
    // 包里的同名目录更不算：`gl/bill/src/public` 的父级不是模块
    expect(ncDepthOffset(ROOT, j(MOD, "gl", "bill", SRC_DIR, "public"), hoisted)).toBe(0);
  });

  it("没传判断函数时恒为 0（开关关着）", () => {
    expect(ncDepthOffset(ROOT, j(SRC, "public"))).toBe(0);
  });

  it("工作区外的路径不按当前根算（多工程树里关联工程各有各的根）", () => {
    // 兄弟目录 `rootbill`：按 root 硬切正好切成 `bill/src/public`，伪装成
    // 「root 下的 bill 模块」——共享前缀的关联工程就是这么被误算的
    expect(ncDepthOffset(ROOT, "rootbill\\src\\public", hoisted)).toBe(0);
    expect(ncDepthOffset(ROOT, "other\\bill\\src\\public", hoisted)).toBe(0);
  });
});
