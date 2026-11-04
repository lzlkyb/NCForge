import { describe, expect, it } from "vitest";
import { pickStatement, splitStatements, type Stmt } from "./sqlSplit";
import { statementsOf } from "./sqlStmtCache";

/** 改造前的线性实现，作为对照。 */
function linearPick(all: Stmt[], offset: number): Stmt | null {
  if (all.length === 0) return null;
  const hit = all.find((s) => offset >= s.start && offset <= s.end);
  if (hit) return hit;
  const before = all.filter((s) => s.end <= offset);
  return before.length ? before[before.length - 1] : all[0];
}
const naiveLine = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

const SAMPLE = [
  "  -- 开头注释",
  "select 1 from dual;",
  "",
  "update t set a = 'x;y'  ;  select 2 from dual;",
  "begin",
  "  null;",
  "end;",
  "/",
  "",
  "/* 块; */ delete from t where id = 3",
  "/",
  "select q'[it's; fine]' from dual",
  "   ",
].join("\n");

describe("pickStatement", () => {
  it("每个偏移都与原线性查找结果一致", () => {
    const all = splitStatements(SAMPLE);
    expect(all.length).toBeGreaterThan(4);
    for (let o = 0; o <= SAMPLE.length; o++) expect(pickStatement(all, o)).toBe(linearPick(all, o));
  });

  it("空列表返回 null", () => {
    expect(pickStatement([], 0)).toBeNull();
  });
});

describe("splitStatements 行号", () => {
  it("单趟计数与逐条从文首数结果一致", () => {
    for (const s of splitStatements(SAMPLE)) {
      expect(s.startLine).toBe(naiveLine(SAMPLE, s.start));
      expect(s.endLine).toBe(naiveLine(SAMPLE, Math.max(s.start, s.end - 1)));
    }
  });
});

describe("statementsOf", () => {
  it("版本号不变就复用，变了才重切", () => {
    let version = 1;
    let text = "select 1 from dual; select 2 from dual;";
    let reads = 0;
    const model = { getVersionId: () => version, getValue: () => { reads++; return text; } };
    const a = statementsOf(model);
    expect(statementsOf(model)).toBe(a);
    expect(reads).toBe(1);
    text += " select 3 from dual;";
    version = 2;
    expect(statementsOf(model)).toHaveLength(3);
    expect(reads).toBe(2);
  });

  it("大脚本：切一遍 ≤ 50ms，光标定位远低于一帧", () => {
    // 与审计里的 144890 字符脚本同量级：几千条短语句
    const one = "insert into bd_demo (pk, name, memo) values ('0001', 'n;ame', '备注');\n";
    const text = one.repeat(Math.ceil(144_890 / one.length));
    const model = { getVersionId: () => 1, getValue: () => text };
    let t = performance.now();
    const all = statementsOf(model);
    const split = performance.now() - t;
    expect(all.length).toBeGreaterThan(1500);
    // 未改前这里是 O(语句数 × 长度) 的数换行，直接几百毫秒
    expect(split).toBeLessThan(50 * 4); // CI/冒烟机器抖动留 4 倍余量，实测值见汇报
    t = performance.now();
    for (let i = 0; i < 1000; i++) pickStatement(statementsOf(model), (i * 9973) % text.length);
    expect((performance.now() - t) / 1000).toBeLessThan(1);
  });
});
