// @vitest-environment jsdom
/**
 * A5：树形计划与「与上次对比」。
 *
 * 盯两件事：① depth 真的表现了嵌套（缩进）；② 保存过对照后，新计划顶部给出
 * 总成本变化与「新增 / 消失」标记——这才是 explain 的实际用法（加索引前后各查一次）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PlanRow } from "../../lib/dbApi";
import { savedPlanKey } from "../../lib/planTree";
import { PlanView } from "./PlanView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (depth: number, operation: string, object = "", cost: number | null = null): PlanRow => ({
  depth,
  operation,
  object,
  access: "",
  filter: "",
  cost,
  rows: cost,
});

let host: HTMLDivElement;
let root: Root | null = null;
const SQL = "select * from bd_material";

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

function render(rows: PlanRow[]) {
  act(() => {
    root = createRoot(host);
    root.render(<PlanView plan={{ sql: SQL, rows }} connId="c1" />);
  });
}

describe("PlanView（A5）", () => {
  it("按 depth 缩进，子节点缩进更大", () => {
    render([row(0, "SELECT STATEMENT", "", 100), row(1, "TABLE ACCESS FULL", "BD_MATERIAL", 100)]);
    const cells = [...host.querySelectorAll("td.op")];
    expect(cells).toHaveLength(2);
    const padding = (el: Element) => Number((el as HTMLElement).style.paddingLeft.replace(/px$/, ""));
    expect(padding(cells[1])).toBeGreaterThan(padding(cells[0]));
  });

  it("没有对照时不显示对比条", () => {
    render([row(0, "SELECT STATEMENT", "", 100)]);
    expect(host.textContent).not.toContain("总成本");
  });

  it("保存过对照后显示成本变化与新增步骤", () => {
    localStorage.setItem(
      savedPlanKey("c1", SQL),
      JSON.stringify({ at: 1, sql: SQL, rows: [row(0, "SELECT STATEMENT", "", 1000), row(1, "TABLE ACCESS FULL", "BD_MATERIAL", 1000)] }),
    );
    render([row(0, "SELECT STATEMENT", "", 120), row(1, "INDEX RANGE SCAN", "IDX_NAME", 120)]);
    expect(host.textContent).toContain("总成本 1000 → 120");
    expect(host.textContent).toContain("变好");
    expect(host.textContent).toContain("新增");
  });

  it("换了一条 SQL 就不拿上一条的对照来比", () => {
    localStorage.setItem(
      savedPlanKey("c1", "select 1 from dual"),
      JSON.stringify({ at: 1, sql: "select 1 from dual", rows: [row(0, "SELECT STATEMENT", "", 1000)] }),
    );
    render([row(0, "SELECT STATEMENT", "", 120)]);
    expect(host.textContent).not.toContain("总成本");
  });
});
