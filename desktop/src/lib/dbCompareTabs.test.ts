// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { __resetDbForTest, closeTab, getDb, openCompareTab, openSqlTab, type CompareTab } from "./dbStore";
import { persistentTab, persistentTabsChanged } from "./dbTabPersistence";
import { rowsBytes, retainedResultBytes } from "./dbResultBudget";
import type { ResultSnapshot } from "./dbResultTools";

vi.mock("./tauri",()=>({invoke:vi.fn()}));
const snapshot=(source:string,originTabId?:string):ResultSnapshot=>({source,originTabId,schema:"NC",sql:"select ID from T",at:1,complete:false,columns:[{name:"ID",type:"NUMBER",precision:8,scale:0}],rows:[[1]]});
beforeEach(()=>__resetDbForTest());
it("比较文档固定两边且只保留一个，关闭后回到 B 查询",()=>{
  const source=openSqlTab("c","select ID from T"),a=snapshot("A"),b=snapshot("B",source);
  const id=openCompareTab(a,b),tab=getDb().tabs.find(t=>t.id===id) as CompareTab;
  b.rows[0][0]=99;b.columns[0].name="OTHER";b.source="later";
  expect(tab.after.rows).toEqual([[1]]);expect(tab.after.source).toBe("B");expect(tab.after.columns[0].name).toBe("ID");
  expect(Object.isFrozen(tab.after.rows[0])).toBe(true);
  expect(openCompareTab(snapshot("new A"),snapshot("new B",source))).toBe(id);
  expect(getDb().tabs.filter(t=>t.kind==="compare")).toHaveLength(1);
  closeTab(id);expect(getDb().active).toBe(source);expect(getDb().tabs.some(t=>t.id===source)).toBe(true);
});
it("比较数据不进入草稿持久化投影，预算包括两份快照",()=>{
  const sql=openSqlTab("c"),before=getDb().tabs;
  const id=openCompareTab(snapshot("A"),snapshot("B",sql)),after=getDb().tabs;
  const tab=after.find(t=>t.id===id) as CompareTab;
  expect(persistentTab(tab)).toBeNull();expect(persistentTabsChanged(before,after)).toBe(false);
  expect(retainedResultBytes(after)).toBe(rowsBytes(tab.before.rows)+rowsBytes(tab.after.rows));
  expect(retainedResultBytes(after,id)).toBe(0);
});
