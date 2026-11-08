// @vitest-environment jsdom
/**
 * 结构对比结果的渲染：只喂 props，不碰 IPC。
 *
 * 盯两件会真出事的事：
 * ① 一致的列默认不展开——两张同源表几十列里只有两三列不同，全列出来等于让人自己找；
 * ② 会丢数据的语句必须**看得见标红**，不能和普通 add 混在一起（有人会整段粘去跑）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructDiffResult } from "./StructDiffResult";
import type { StructDiff } from "../../lib/dbStructDiff";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const col = (name: string, ty: string) => ({ name, ty, nullable: true, defaultText: null, comment: null });

const DIFF: StructDiff = {
  left: { label: "NC65.BD_MATERIAL", columns: [], pk: ["ID"], pkName: "PK_A", indexes: [], comment: null },
  right: { label: "NC66.BD_MATERIAL", columns: [], pk: [], pkName: null, indexes: [], comment: null },
  columns: [
    { name: "ID", status: "same", left: col("ID", "NUMBER(12)"), right: col("ID", "NUMBER(12)"), changes: [] },
    { name: "MEMO", status: "onlyLeft", left: col("MEMO", "VARCHAR2(400)"), right: null, changes: [] },
    { name: "OLD", status: "onlyRight", left: null, right: col("OLD", "DATE"), changes: [] },
  ],
  indexes: [],
  pkChanged: true,
  commentChanged: false,
  onlyLeft: 1,
  onlyRight: 1,
  changed: 0,
  ddl: [
    { sql: "alter table NC66.BD_MATERIAL drop column OLD;", reason: "右侧多出的列", destructive: true },
    { sql: "alter table NC66.BD_MATERIAL add (MEMO VARCHAR2(400));", reason: "右侧缺少这一列", destructive: false },
  ],
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("StructDiffResult", () => {
  it("默认只列不一致的列，主键差异有单独提示", () => {
    act(() => root.render(<StructDiffResult diff={DIFF} />));
    const text = host.textContent ?? "";
    expect(text).toContain("MEMO");
    expect(text).toContain("OLD");
    expect(text).not.toContain("NUMBER(12)");
    expect(text).toContain("主键不同");
  });

  it("会丢数据的语句标「会丢数据」，脚本可整段取用", () => {
    act(() => root.render(<StructDiffResult diff={DIFF} />));
    const text = host.textContent ?? "";
    expect(text).toContain("会丢数据");
    // 每条语句都要带原因：脱离界面（贴工单）后只看 SQL 不知道为什么要改
    expect(text).toContain("右侧多出的列");
    expect(text).toContain("同步脚本（2 条");
  });
});
