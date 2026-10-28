import { describe, expect, it } from "vitest";
import { buildStageTree, countClasses, countEntries, type TreeNode } from "./patchTree";
import type { PatchItem } from "./patch";

/**
 * 落位预览树的纯逻辑。
 *
 * 这棵树是「打出来的 zip 长什么样」的唯一展示。它错了不会报任何错——
 * 用户会照着错的落位点一次「生成」，然后把包上传到服务器，直到发现补丁不生效。
 */

function item(p: Partial<PatchItem> = {}): PatchItem {
  return {
    path: "D:/ws/ic/private/nc/bs/ic/eye/crossborrow/A.java",
    rel: "ic/private/nc/bs/ic/eye/crossborrow/A.java",
    label: "ic/private/nc/bs/ic/eye/crossborrow/A.java",
    module: "ic",
    section: "private",
    pkgRel: "nc/bs/ic/eye/crossborrow",
    target: "replacement/modules/ic/META-INF/hyext/classes/nc/bs/ic/eye/crossborrow",
    layer: { hyext: true, why: "hyext（默认模块 ic,不查 jar）" },
    classes: [{ name: "A.class", path: "", fresh: true }],
    problems: [],
    blocked: false,
    outRootUsed: "out",
    ...p,
  };
}

/** 把树摊成「路径 → 元信息」便于断言。 */
function flatten(nodes: TreeNode[], prefix = ""): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    out.push(`${p}${n.badge ? `[${n.badge}]` : ""}${n.meta ? `{${n.meta}}` : ""}`);
    out.push(...flatten(n.children, p));
  }
  return out;
}

describe("buildStageTree", () => {
  it("zip 根固定有 CHANGES.md，SQL 也放根", () => {
    const tree = buildStageTree([item()], ["D:/nc/ddl/aier_crossborrow_ddl.sql"]);
    expect(tree.map((n) => n.name)).toEqual(["CHANGES.md", "aier_crossborrow_ddl.sql", "replacement"]);
    expect(tree[0].meta).toBe("自动生成");
    expect(tree[1].meta).toBe("需人工执行");
  });

  it("单链目录合并成一行（hyext/classes/…/crossborrow）", () => {
    const lines = flatten(buildStageTree([item()], []));
    expect(lines).toContain(
      "replacement/modules/ic/META-INF/hyext/classes/nc/bs/ic/eye/crossborrow",
    );
    // 合并后不该再有单独一层 hyext
    expect(lines.some((l) => l.endsWith("/hyext"))).toBe(false);
  });

  it("分叉点不合并：META-INF 下同时有 upm 与 hyext 时分开", () => {
    const items = [
      item(),
      item({
        path: "D:/ws/ic/META-INF/aier.upm",
        rel: "ic/META-INF/aier.upm",
        section: "upm",
        target: "replacement/modules/ic/META-INF",
        classes: [],
      }),
    ];
    const lines = flatten(buildStageTree(items, []));
    expect(lines).toContain("replacement/modules/ic/META-INF");
    expect(lines).toContain("replacement/modules/ic/META-INF/aier.upm{整文件替换}");
    expect(lines).toContain(
      "replacement/modules/ic/META-INF/hyext/classes/nc/bs/ic/eye/crossborrow",
    );
  });

  it("class 按 fresh 与内部类标注：源码与 class 并排", () => {
    const it = item({
      classes: [
        { name: "A.class", path: "", fresh: true },
        { name: "A$1.class", path: "", fresh: true },
      ],
    });
    const lines = flatten(buildStageTree([it], []));
    expect(lines).toContain("replacement/modules/ic/META-INF/hyext/classes/nc/bs/ic/eye/crossborrow/A.class[private]");
    expect(lines).toContain("replacement/modules/ic/META-INF/hyext/classes/nc/bs/ic/eye/crossborrow/A$1.class{内部类}");
    expect(lines).toContain("replacement/modules/ic/META-INF/hyext/classes/nc/bs/ic/eye/crossborrow/A.java{源码一并带}");
  });

  it("没有 class 的项（未编译）仍然占位，能看到目录在，只是没产物", () => {
    const tree = buildStageTree([item({ classes: [] })], []);
    const lines = flatten(tree);
    expect(lines).toContain("replacement/modules/ic/META-INF/hyext/classes/nc/bs/ic/eye/crossborrow/A.java{源码一并带}");
    expect(countEntries(tree)).toBe(2); // CHANGES.md + A.java
  });

  it("根层顺序是语义顺序：CHANGES.md 在最前，SQL 其次，replacement 最后", () => {
    const tree = buildStageTree([item()], ["D:/nc/b.sql", "D:/nc/a.sql"]);
    expect(tree.map((n) => n.name)).toEqual([
      "CHANGES.md",
      "b.sql",
      "a.sql",
      "replacement",
    ]);
    // 前三层（replacement / modules / 模块名）保持独立，不揉成一行
    const lines = flatten(tree);
    expect(lines).toContain("replacement");
    expect(lines).toContain("replacement/modules");
    expect(lines).toContain("replacement/modules/ic");
  });

  it("空清单只有 CHANGES.md（说明没勾任何东西也不能是空树）", () => {
    const tree = buildStageTree([], []);
    expect(tree.map((n) => n.name)).toEqual(["CHANGES.md"]);
  });
});

describe("countEntries / countClasses", () => {
  it("条目数只算文件，不算目录", () => {
    const tree = buildStageTree([item()], ["D:/nc/a.sql"]);
    // CHANGES.md + a.sql + A.class + A.java
    expect(countEntries(tree)).toBe(4);
  });

  it("class 数按项累加", () => {
    expect(countClasses([item(), item({ classes: [] })])).toBe(1);
  });
});
