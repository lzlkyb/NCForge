import { describe, expect, it } from "vitest";
import { appendResultRows, fitResult, fitResults, RESULT_BYTES, RESULT_ROWS, rowsBytes } from "./dbResultBudget";
import type { ResultEntry } from "./dbStore";
const result = (rows: ResultEntry["rows"]): ResultEntry => ({id:"r", index:1,sql:"select * from t",kind:"rows",columns:[],rows,hasMore:false,updateCount:-1,ms:0});
describe("retained result budgets", () => {
  it("caps wide strings by bytes, marks partial, and preserves the response", () => {
    const rows = Array.from({length:20},()=>["x".repeat(500_000)]);
    const source = result(rows), kept = fitResult(source, RESULT_BYTES);
    expect(kept.rows.length).toBeLessThan(rows.length);
    expect(rowsBytes(kept.rows)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(kept.hasMore).toBe(true); expect(kept.moreError).toContain("内存上限");
    expect(source.rows).toBe(rows); expect(source.hasMore).toBe(false);
  });
  it("bounds row references and append allocation while preserving old snapshots", () => {
    const old = Array.from({length:RESULT_ROWS-1},()=>[1]);
    const page = [[2],[3]], next = appendResultRows(old,page,RESULT_BYTES);
    expect(next.rows).toHaveLength(RESULT_ROWS); expect(next.limited).toBe(true);
    expect(old).toHaveLength(RESULT_ROWS-1); expect(next.rows[next.rows.length-1]).toEqual([2]);
    expect(appendResultRows(next.rows,page,RESULT_BYTES).rows).toBe(next.rows);
  });
  it("applies one budget across multiple and implicit results without claiming complete data", () => {
    const a = result([["a"],["b"]]), budget = rowsBytes(a.rows);
    const kept = fitResults([a,result([["c"]])],budget);
    expect(kept[0]).toBe(a); expect(kept[1].rows).toEqual([]); expect(kept[1].hasMore).toBe(true);
    const sets = [{columns:[],rows:a.rows,rowCount:2,hasMore:false},{columns:[],rows:[["c"]],rowCount:1,hasMore:false}];
    const implicit = fitResult({...a,sets},budget);
    expect(implicit.sets?.[1].rows).toEqual([]); expect(implicit.sets?.[1].hasMore).toBe(true);
    expect(implicit.rows).toBe(implicit.sets?.[0].rows);
  });
});
