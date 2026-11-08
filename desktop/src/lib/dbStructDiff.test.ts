import { describe, expect, it } from "vitest";
import { ddlScript, filterColumns, STATUS_TEXT, summarize, type ColumnDiff, type StructDiff } from "./dbStructDiff";

const col = (name: string, ty = "VARCHAR2(40)"): ColumnDiff["left"] => ({
  name,
  ty,
  nullable: true,
  defaultText: null,
  comment: null,
});

function columnDiff(name: string, status: ColumnDiff["status"]): ColumnDiff {
  return {
    name,
    status,
    left: status === "onlyRight" ? null : col(name),
    right: status === "onlyLeft" ? null : col(name),
    changes: [],
  };
}

const DIFF: StructDiff = {
  left: { label: "NC65.BD_MATERIAL", columns: [], pk: ["ID"], pkName: "PK_A", indexes: [], comment: "物料" },
  right: { label: "NC66.BD_MATERIAL", columns: [], pk: [], pkName: null, indexes: [], comment: null },
  columns: [columnDiff("ID", "same"), columnDiff("MEMO", "onlyLeft"), columnDiff("OLD", "onlyRight"), columnDiff("NAME", "changed")],
  indexes: [],
  pkChanged: true,
  commentChanged: true,
  onlyLeft: 1,
  onlyRight: 1,
  changed: 1,
  ddl: [
    { sql: "alter table NC66.BD_MATERIAL drop column OLD;", reason: "右侧多出的列", destructive: true },
    { sql: "alter table NC66.BD_MATERIAL add (MEMO VARCHAR2(40));", reason: "右侧缺少这一列", destructive: false },
  ],
};

describe("summarize", () => {
  it("数出一致/缺失/多余/不同与语句条数", () => {
    expect(summarize(DIFF)).toEqual({ same: 1, onlyLeft: 1, onlyRight: 1, changed: 1, statements: 2 });
  });

  it("还没比的时候全是 0", () => {
    expect(summarize(null)).toEqual({ same: 0, onlyLeft: 0, onlyRight: 0, changed: 0, statements: 0 });
  });
});

describe("filterColumns", () => {
  it("diff 只留不一致的，all 全给", () => {
    expect(filterColumns(DIFF.columns, "diff").map((c) => c.name)).toEqual(["MEMO", "OLD", "NAME"]);
    expect(filterColumns(DIFF.columns, "all")).toHaveLength(4);
    expect(filterColumns(DIFF.columns, "same").map((c) => c.name)).toEqual(["ID"]);
  });
});

describe("ddlScript", () => {
  it("头部写明方向，每条前面带原因，[删] 标出来", () => {
    const text = ddlScript(DIFF);
    const lines = text.split("\n");
    // 方向必须写在脚本里：脚本贴到工单后没人知道哪边是基准
    expect(lines[0]).toContain("NC66.BD_MATERIAL → NC65.BD_MATERIAL");
    expect(text).toContain("-- [删] 右侧多出的列");
    expect(text).toContain("-- 右侧缺少这一列");
    expect(text).toContain("alter table NC66.BD_MATERIAL drop column OLD;");
  });

  it("没有语句时给空串，不生成只有注释的壳", () => {
    expect(ddlScript({ ...DIFF, ddl: [] })).toBe("");
  });
});

describe("STATUS_TEXT", () => {
  it("四种状态都有中文说明（界面上不能出现英文枚举）", () => {
    for (const status of ["same", "onlyLeft", "onlyRight", "changed"] as const) {
      expect(STATUS_TEXT[status]).toBeTruthy();
    }
  });
});
