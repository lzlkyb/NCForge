import { afterEach, expect, it, vi } from "vitest";
import type { ResultSnapshot } from "./dbResultTools";
import { RESULT_BYTES, RESULT_ROWS } from "./dbResultBudget";
import { buildComparison, clearCompareBaseline, cloneCompareSnapshot, comparisonColumns, comparisonTsv, filterComparisonRows, getCompareBaseline, setCompareBaseline, subscribeCompareBaseline } from "./dbCompareState";

const columns=[{name:"ID",type:"NUMBER",precision:10,scale:0},{name:"VALUE",type:"VARCHAR2",precision:100,scale:0},{name:"NOTE",type:"VARCHAR2",precision:100,scale:0}];
const snapshot=(patch:Partial<ResultSnapshot>={}):ResultSnapshot=>({source:"测试库 A",schema:"SCHEMA_A",sql:"select * from T",at:1,complete:true,columns,rows:[[1,"a","same"]],...patch});
afterEach(()=>clearCompareBaseline());

it("固定 A 深拷贝全部已加载行与列，并持续通知订阅者，超预算不替换原基线",()=>{
  const listener=vi.fn(),unsubscribe=subscribeCompareBaseline(listener);
  const original=snapshot({columns:columns.map(c=>({...c})),rows:[[1,"a","hidden"],[2,"b",null]]});
  const fixed=setCompareBaseline(original);
  original.rows[0][1]="changed";original.columns[2].name="renamed";original.source="changed source";
  expect(fixed.rows).toEqual([[1,"a","hidden"],[2,"b",null]]);
  expect(fixed.columns[2].name).toBe("NOTE");expect(fixed.source).toBe("测试库 A");
  expect(Object.isFrozen(fixed.rows[0])).toBe(true);expect(listener).toHaveBeenCalledTimes(1);
  expect(()=>setCompareBaseline(snapshot({rows:Array.from({length:RESULT_ROWS+1},()=>[1])}))).toThrow(/超过/);
  expect(getCompareBaseline()).toBe(fixed);expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();clearCompareBaseline();expect(listener).toHaveBeenCalledTimes(1);
});

it("按内存预算拒绝整个快照，不为比较静默截断行或长值",()=>{
  const large=snapshot({rows:[[1,"x".repeat(RESULT_BYTES/2),null]]});
  expect(()=>cloneCompareSnapshot(large)).toThrow(/内存/);
  const source=snapshot();const cloned=cloneCompareSnapshot(source);
  expect(cloned).not.toBe(source);expect(cloned.rows).not.toBe(source.rows);expect(cloned.rows[0]).not.toBe(source.rows[0]);
});

it("复用唯一键校验，按列名对齐 A/B，NULL、空串和字面量波浪号保持差别",()=>{
  const before=snapshot({rows:[[1,null,"same"],[2,"remove","~"]],complete:false});
  const after=snapshot({source:"库 B",schema:"SCHEMA_B",columns:[columns[2],columns[0],columns[1]],rows:[["same",1,""],["new",3,"~"]]});
  const model=buildComparison(before,after,["ID"]);
  expect(model.counts).toEqual({changed:1,added:1,removed:1});
  expect(model.records[0]).toMatchObject({kind:"changed",before:[1,null,"same"],after:[1,"","same"]});
  expect(model.records[1].after).toEqual([3,"~","new"]);
  expect(()=>buildComparison(before,after,[])).toThrow(/请选择/);
  expect(()=>buildComparison(snapshot({rows:[[1,"a",null],[1,"b",null]]}),after,["ID"])).toThrow(/重复/);
  expect(()=>buildComparison(snapshot({rows:[[null,"a",null]]}),after,["ID"])).toThrow(/NULL/);
});

it("字段与记录筛选只影响视图，TSV 总是包含全部差异与部分范围说明",()=>{
  const before=snapshot({rows:[[1,"old","same"],[2,"removed","same"]],complete:false});
  const after=snapshot({rows:[[1,"new","same"],[3,"added","same"]],source:"库 B"});
  const model=buildComparison(before,after,["ID"]);
  const visible=filterComparisonRows(model,"changed","1");
  expect(visible).toEqual([0]);
  const fields=comparisonColumns(model,visible,true);
  expect(fields.filter(c=>c.kind==="value").map(c=>[c.name,c.side])).toEqual([["VALUE","A"],["VALUE","B"]]);
  expect(fields.filter(c=>c.kind==="key").map(c=>c.name)).toEqual(["ID"]);
  const output=comparisonTsv(before,after,model);
  expect(output).toContain("仅比较已加载数据，不能代表全表差异");
  expect(output).toContain("removed");expect(output).toContain("added");expect(output).toContain("old");expect(output).toContain("new");
  expect(output).toContain("SCHEMA_A");expect(output.split(/\r?\n/)).toHaveLength(5);
});
