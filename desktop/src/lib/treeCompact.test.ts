import { describe, expect, it } from "vitest";
import { chainFor, chainOpen, collapseChain } from "./treeCompact";
import { joinPath } from "./workspace";
import type { TreeDirState } from "./workspaceSession";

const j = (...parts: string[]) => parts.reduce((a, b) => joinPath(a, b));

const dir = (names: string[], dirs: string[] = []): TreeDirState => ({
  status: "ok",
  items: names.map((name) => ({ name, isDir: dirs.includes(name), size: 0 })),
});

const ROOT = "root";
const COM = j(ROOT, "com");
const AIER = j(COM, "aier");
const ERP = j(AIER, "erp");
const VO = j(ERP, "vo");

/** root/com/aier/erp/vo/ 一路单链，vo 下面才分叉。 */
const dirs: Record<string, TreeDirState> = {
  [ROOT]: dir(["com"], ["com"]),
  [COM]: dir(["aier"], ["aier"]),
  [AIER]: dir(["erp"], ["erp"]),
  [ERP]: dir(["vo"], ["vo"]),
  [VO]: dir(["A.java", "B.java"]),
};

describe("collapseChain", () => {
  it("把单链合并成一行，label 用点连接", () => {
    const c = collapseChain(COM, "com", dirs);
    expect(c.nodes).toEqual([COM, AIER, ERP, VO]);
    expect(c.label).toBe("com.aier.erp.vo");
    expect(c.tail).toBe(VO);
  });

  it("有文件就停：不会再往下压", () => {
    const c = collapseChain(VO, "vo", dirs);
    expect(c.nodes).toEqual([VO]);
    expect(c.label).toBe("vo");
  });

  it("两个子目录就停（分叉的包名不合并）", () => {
    const d = { ...dirs, [AIER]: dir(["erp", "ui"], ["erp", "ui"]) };
    const c = collapseChain(COM, "com", d);
    expect(c.tail).toBe(AIER);
    expect(c.label).toBe("com.aier");
  });

  it("没加载过的目录不往下猜（否则展开瞬间会改名）", () => {
    const c = collapseChain(COM, "com", { [COM]: dir(["aier"], ["aier"]) });
    expect(c.nodes).toEqual([COM, AIER]);
    expect(c.label).toBe("com.aier");
  });

  it("只认 isDir：唯一的子项是文件时不合并", () => {
    const d = { [COM]: dir(["Only.java"]) };
    expect(collapseChain(COM, "com", d).nodes).toEqual([COM]);
  });
});

describe("chainOpen", () => {
  const chain = collapseChain(COM, "com", dirs);

  it("链上任意一层展开就算展开", () => {
    expect(chainOpen(chain, new Set())).toBe(false);
    expect(chainOpen(chain, new Set([AIER]))).toBe(true);
    expect(chainOpen(chain, new Set([VO]))).toBe(true);
  });
});

describe("chainFor", () => {
  it("从链尾反推出整条链（收起时要逐层删，少删一层下一帧又压回去）", () => {
    // `parent` 是压缩行自己的父级（这一行的上一层），不是链尾的父级
    const c = chainFor(VO, ROOT, dirs);
    expect(c.nodes).toEqual([COM, AIER, ERP, VO]);
    expect(c.tail).toBe(VO);
  });

  it("给的是链内部某一层时，只能还原出它下面那段（不会凭空接上更外层）", () => {
    const c = chainFor(VO, ERP, dirs);
    expect(c.nodes).toEqual([VO]);
  });

  it("链尾不在父目录下时退回单节点，不瞎连", () => {
    const c = chainFor(j("elsewhere", "X"), ROOT, dirs);
    expect(c.nodes).toEqual([j("elsewhere", "X")]);
  });

  it("没有父目录（根）时就是自身", () => {
    const c = chainFor(ROOT, null, dirs);
    expect(c.nodes).toEqual([ROOT]);
    expect(c.label).toBe(ROOT);
  });
});
