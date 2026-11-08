// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getCompareBaseline, clearCompareBaseline, setCompareBaseline } from "../../lib/dbCompareState";
import { RESULT_ROWS } from "../../lib/dbResultBudget";
import type { ResultSnapshot } from "../../lib/dbResultTools";
import { ResultBaselineSummary, ResultCompare } from "./ResultCompare";

const mocks=vi.hoisted(()=>({open:vi.fn(),toast:vi.fn()}));
vi.mock("../../lib/dbStore",()=>({openCompareTab:mocks.open}));
vi.mock("../ui/toast",()=>({toast:mocks.toast}));
vi.mock("../ui/Modal",()=>({Modal:({open,children,ariaLabel}:{open:boolean;children:ReactNode;ariaLabel:string})=>open ? <div role="dialog" aria-label={ariaLabel}>{children}</div> : null}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const snapshot=(source:string,patch:Partial<ResultSnapshot>={}):ResultSnapshot=>({source,schema:`${source}_SCHEMA`,sql:`select * from ${source}`,at:1,complete:true,columns:[{name:"ID",type:"NUMBER",precision:10,scale:0}],rows:[[1],[2]],...patch});
let root:Root,host:HTMLDivElement;
beforeEach(()=>{vi.clearAllMocks();mocks.open.mockReset();clearCompareBaseline();host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();clearCompareBaseline();});
const named=(label:string)=>host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const menuItem=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button=>button.textContent===label)!;
const openMenu=(index=0)=>act(()=>{const button=host.querySelectorAll<HTMLButtonElement>('[aria-label="比对选项"]')[index];button.focus();button.click();});

it("无 A 时直接固定，全标签即时订阅同一摘要；随后比对传入完整快照",()=>{
  const a=snapshot("A"),b=snapshot("B");
  act(()=>root.render(<><ResultBaselineSummary /><ResultCompare snapshot={a} /><ResultBaselineSummary /><ResultCompare snapshot={b} /></>));
  expect(host.querySelectorAll('[aria-label="查看对照 A 来源"]')).toHaveLength(0);
  act(()=>named("固定当前结果为对照 A").click());
  const summaries=host.querySelectorAll('[aria-label="查看对照 A 来源"]');expect(summaries).toHaveLength(2);
  for(const summary of summaries) {expect(summary.textContent).toContain("A_SCHEMA");expect(summary.textContent).toContain("2 行");}
  expect(host.querySelector("pre")).toBeNull();expect(mocks.open).not.toHaveBeenCalled();
  act(()=>host.querySelectorAll<HTMLButtonElement>('[aria-label="比对当前结果与对照 A"]')[1].click());
  expect(mocks.open).toHaveBeenCalledWith(getCompareBaseline(),b);
  expect(mocks.open.mock.calls[0][1]).toBe(b);
  openMenu(1);act(()=>menuItem("更新对照 A").click());
  for(const summary of host.querySelectorAll('[aria-label="查看对照 A 来源"]')) expect(summary.textContent).toContain("B_SCHEMA");
  expect(getCompareBaseline()?.rows).toEqual(b.rows);
});

it("来源按钮在弹窗查看冻结 SQL 与完整范围，关联记录仍在分体菜单",()=>{
  const related=vi.fn(),a=snapshot("A",{complete:false,sql:"select\n * from A"});setCompareBaseline(a);
  act(()=>root.render(<><ResultBaselineSummary /><ResultCompare snapshot={snapshot("B")} related={{label:"关联记录",icon:"external",onSelect:related}} /></>));
  expect(named("查看对照 A 来源").textContent).toContain("部分");
  act(()=>named("查看对照 A 来源").click());
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("全部已加载数据，包含隐藏列");
  expect(host.querySelector('pre[aria-label="A 来源 SQL"]')?.textContent).toBe(a.sql);
  act(()=>named("关闭来源").click());openMenu();act(()=>menuItem("关联记录").click());expect(related).toHaveBeenCalledTimes(1);
  openMenu();act(()=>menuItem("查看来源").click());expect(host.querySelectorAll(".dbx-compare-source")).toHaveLength(2);
});

it("超限固定和打开失败都明确报错，原有 A 不被替换",()=>{
  const original=setCompareBaseline(snapshot("old"));
  act(()=>root.render(<><ResultBaselineSummary /><ResultCompare snapshot={snapshot("large",{rows:Array.from({length:RESULT_ROWS+1},()=>[1])})} /></>));
  openMenu();act(()=>menuItem("更新对照 A").click());
  expect(getCompareBaseline()).toBe(original);expect(mocks.toast.mock.calls.some(([text,tone])=>String(text).includes("未截断") && tone==="error")).toBe(true);
  mocks.open.mockImplementation(()=>{throw new Error("结果工作台内存不足");});
  act(()=>named("比对当前结果与对照 A").click());expect(mocks.toast).toHaveBeenLastCalledWith("结果工作台内存不足","error");expect(getCompareBaseline()).toBe(original);
});
