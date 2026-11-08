import { expect, it } from "vitest";
import { persistentTabsChanged, persistentTab } from "./dbTabPersistence";
import type { SqlTab, TableTab } from "./dbStore";
const sql = {kind:"sql",id:"s",title:"SQL",connId:"c",sql:"select 1",maxRows:500,timeoutSec:30,results:[],running:false} as unknown as SqlTab;
it("runtime results, transaction and progress never dirty the persisted projection", () => {
  expect(persistentTabsChanged([sql],[{...sql,running:true,results:[{} as never],view:"r",slot:"1"}])).toBe(false);
  expect(persistentTab(sql)).not.toHaveProperty("results");
});
it("draft/settings and ordering changes are persisted", () => {
  expect(persistentTabsChanged([sql],[{...sql,sql:"select 2"}])).toBe(true);
  expect(persistentTabsChanged([sql],[{...sql,maxRows:200}])).toBe(true);
  expect(persistentTabsChanged([sql],[{...sql,id:"other"},sql])).toBe(true);
});
it("table query/trail are transient, subview is retained", () => {
  const table = {kind:"table",id:"t",connId:"c",table:"T",sub:"data"} as TableTab;
  expect(persistentTabsChanged([table],[{...table,query:{where:"x=1",order:"",params:[]}}])).toBe(false);
  expect(persistentTabsChanged([table],[{...table,sub:"struct"}])).toBe(true);
});
