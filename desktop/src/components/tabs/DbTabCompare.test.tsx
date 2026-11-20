// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DbTab } from "./DbTab";
import { __resetDbForTest, activateTab, getDb, openCompareTab, openSqlTab, openTableFollowup, openTableTab, tabOf, type TableTab } from "../../lib/dbStore";
const counters=vi.hoisted(()=>({mounts:0}));
vi.mock("../../lib/tauri",()=>({invoke:vi.fn(async()=>[])}));
vi.mock("../../lib/dbActions",()=>({newConsole:vi.fn()}));
vi.mock("../workspace/WorkbenchDock",()=>({DockRegion:({children}:{children:React.ReactNode})=>children}));
vi.mock("../db/SqlConsole",()=>({SqlConsole:()=>{
  const [filter,setFilter]=useState("");useEffect(()=>{counters.mounts++;},[]);
  return <div><input aria-label="测试筛选" value={filter} onChange={e=>setFilter(e.target.value)}/><div role="grid" tabIndex={0}>selected row</div></div>;
}}));
vi.mock("../db/ComparisonWorkspace",()=>({ComparisonWorkspace:()=> <div>独立比对</div>}));
vi.mock("../db/ConnTree",()=>({ConnTree:()=>null}));
vi.mock("../db/ConnDialog",()=>({ConnDialog:()=>null}));
vi.mock("../db/DbDocTabs",()=>({DbDocTabs:()=>null}));
vi.mock("../db/DbObjectFinder",()=>({DbObjectFinder:()=>null}));
vi.mock("../db/TablePage",()=>({TablePage:({tab}:{tab:TableTab})=><div data-test-table={tab.id}>
  <input aria-label="表筛选" /><div role="grid">table rows</div>
</div>}));
vi.mock("../md/DictWorkspace",()=>({DictWorkspace:()=>null}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
const host=document.createElement("div"),root=createRoot(host);
afterEach(()=>{act(()=>root.render(null));__resetDbForTest();});
it("返回来源查询时复用同一 DOM，保留筛选和滚动并避免重新挂载查询",async()=>{
  __resetDbForTest();counters.mounts=0;
  const id=openSqlTab("c","select ID from T");
  await act(async()=>root.render(<DbTab/>));
  const input=host.querySelector<HTMLInputElement>('[aria-label="测试筛选"]')!,grid=host.querySelector<HTMLElement>('[role="grid"]')!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"keep-filter");input.dispatchEvent(new Event("input",{bubbles:true}));});
  grid.scrollTop=156;
  const snapshot={source:"TEST",originTabId:id,sql:"select ID from T",at:1,complete:true,columns:[{name:"ID",type:"NUMBER",precision:8,scale:0}],rows:[[1]]};
  act(()=>openCompareTab(snapshot,snapshot));
  expect(host.querySelector('.dbx-document-host')?.hasAttribute("hidden")).toBe(true);
  act(()=>activateTab(id));
  expect(host.querySelector('[aria-label="测试筛选"]')).toBe(input);expect(input.value).toBe("keep-filter");
  expect(host.querySelector('[role="grid"]')).toBe(grid);expect(grid.scrollTop).toBe(156);expect(counters.mounts).toBe(1);
});

it("同表重查保持来源表页，返回后恢复原筛选与滚动", async () => {
  const source = openTableTab("c", "PO_ORDER", "data", undefined, "NC");
  await act(async () => root.render(<DbTab />));
  const origin = host.querySelector<HTMLElement>(`[data-test-table="${source}"]`)!;
  const input = origin.querySelector("input")!, grid = origin.querySelector<HTMLElement>('[role="grid"]')!;
  input.value = "原筛选";
  grid.scrollTop = 220;
  act(() => { openTableFollowup(tabOf(source) as TableTab, "PO_ORDER", { where: "PK_ID = :1", params: ["PO-1"], order: "" }); });
  const child = tabOf(getDb().active) as TableTab;
  expect(child.id).not.toBe(source);
  expect(child.schema).toBe("NC");
  expect(child.query?.params).toEqual(["PO-1"]);
  expect(origin.parentElement?.hasAttribute("hidden")).toBe(true);
  act(() => activateTab(source));
  expect(origin.parentElement?.hasAttribute("hidden")).toBe(false);
  expect(origin.querySelector("input")).toBe(input);
  expect(input.value).toBe("原筛选");
  expect(grid.scrollTop).toBe(220);
});
