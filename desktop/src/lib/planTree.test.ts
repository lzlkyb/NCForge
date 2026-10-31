import { describe, expect, it } from "vitest";
import type { PlanRow } from "./dbApi";
import { buildPlanTree, diffPlans, diffSummary, nodeKey, totalCost } from "./planTree";

/**
 * A5：执行计划的树形化与两次对比。
 *
 * 后端给的是 `depth` 拍平的数组；平表渲染要人数空格认父子。这里盯三件事：
 * 折树对不对、对比算得对不对、「读不到成本」时不能编一个 0% 出来。
 */

const row = (depth: number, operation: string, object = "", cost: number | null = null, rows: number | null = null): PlanRow => ({
  depth,
  operation,
  object,
  access: "",
  filter: "",
  cost,
  rows,
});

describe("buildPlanTree", () => {
  it("按 depth 折回父子关系", () => {
    const tree = buildPlanTree([
      row(0, "SELECT STATEMENT", "", 100),
      row(1, "NESTED LOOPS", "", 100),
      row(2, "TABLE ACCESS FULL", "BD_MATERIAL", 60),
      row(2, "INDEX RANGE SCAN", "PK_BD_MATERIAL", 40),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].children.map((n) => n.row.object)).toEqual(["BD_MATERIAL", "PK_BD_MATERIAL"]);
  });

  it("两个根节点不会被串成父子", () => {
    // 两条 depth=0 的顶层（union all 的典型形态）
    const tree = buildPlanTree([row(0, "SELECT STATEMENT"), row(0, "UNION-ALL")]);
    expect(tree).toHaveLength(2);
  });

  it("depth 跳级时按直连处理（不丢子树）", () => {
    // 0 → 3：计划表偶发（order siblings by 与父子关系不一致）
    const tree = buildPlanTree([row(0, "SELECT STATEMENT"), row(3, "SORT ORDER BY")]);
    expect(tree[0].children).toHaveLength(1);
  });
});

describe("totalCost", () => {
  it("取根节点成本（计划成本是累计值）", () => {
    expect(totalCost([row(0, "SELECT STATEMENT", "", 250), row(1, "TABLE ACCESS FULL", "T", 200)])).toBe(250);
  });

  it("根节点没成本时退回第一行；都没有给 null", () => {
    expect(totalCost([row(0, "SELECT STATEMENT"), row(1, "X", "", 5)])).toBeNull();
    expect(totalCost([])).toBeNull();
  });
});

describe("diffPlans", () => {
  const before = [
    row(0, "SELECT STATEMENT", "", 1000),
    row(1, "TABLE ACCESS FULL", "BD_MATERIAL", 1000, 5000),
  ];
  const after = [
    row(0, "SELECT STATEMENT", "", 120),
    row(1, "INDEX RANGE SCAN", "IDX_MATERIAL_NAME", 120, 50),
  ];

  it("新增与消失的步骤各自列出", () => {
    const d = diffPlans(before, after);
    expect(d.added.map((r) => r.object)).toEqual(["IDX_MATERIAL_NAME"]);
    expect(d.removed.map((r) => r.object)).toEqual(["BD_MATERIAL"]);
  });

  it("总成本变化给百分比（加索引后变好用负数表示）", () => {
    const d = diffPlans(before, after);
    expect(d.costBefore).toBe(1000);
    expect(d.costAfter).toBe(120);
    expect(d.costDelta).toBe(-88);
    expect(diffSummary(d)).toContain("变好");
  });

  it("成本读不到时 delta 是 null（不能编成 0%）", () => {
    const d = diffPlans([row(0, "SELECT STATEMENT")], [row(0, "SELECT STATEMENT")]);
    expect(d.costDelta).toBeNull();
    expect(diffSummary(d)).toBe("与上次计划没有变化");
  });

  it("同一节点的成本变化单独列出", () => {
    const d = diffPlans(
      [row(0, "SELECT STATEMENT", "", 10), row(1, "TABLE ACCESS FULL", "T", 10)],
      [row(0, "SELECT STATEMENT", "", 30), row(1, "TABLE ACCESS FULL", "T", 30)],
    );
    expect(d.added).toHaveLength(0);
    const keys = d.changed.map((c) => c.key);
    expect(keys).toContain(nodeKey(row(1, "table access full", "t")));
    expect(diffSummary(d)).toContain("2 个步骤成本变化");
  });
});
