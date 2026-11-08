// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import type { ResultSnapshot } from "../../lib/dbResultTools";
import { __resetDbForTest, getDb, openCompareTab, openSqlTab, patchTab, useDbSelector } from "../../lib/dbStore";
import type { CompareTab } from "../../lib/dbCompareState";
import { applyUiDensity } from "../../lib/uiDensity";
import { downloadText } from "../../lib/resultExport";
import { copyText } from "../../lib/utils";
import { ComparisonWorkspace } from "./ComparisonWorkspace";

vi.mock("../../lib/tauri",()=>({invoke:vi.fn()}));
vi.mock("../../lib/resultExport",async original=>({...await original<typeof import("../../lib/resultExport")>(),downloadText:vi.fn()}));
vi.mock("../../lib/utils",async original=>({...await original<typeof import("../../lib/utils")>(),copyText:vi.fn()}));
vi.mock("../ui/toast",()=>({toast:vi.fn()}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=class {observe() {} unobserve() {} disconnect() {}};
HTMLElement.prototype.scrollIntoView=vi.fn();
globalThis.requestAnimationFrame=callback=>{callback(0);return 1;};
const col=(name:string):ColumnMeta=>({name,type:name==="ID" ? "NUMBER" : "VARCHAR2",precision:100,scale:0});
const columns=[col("ID"),col("VALUE"),col("NOTE")];
const snapshot=(patch:Partial<ResultSnapshot>={}):ResultSnapshot=>({source:"连接 A",schema:"SCHEMA_A",sql:"select * from T",at:1,complete:true,columns,rows:[[1,"old","same"]],...patch});
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.clearAllMocks();__resetDbForTest();applyUiDensity("standard");host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();__resetDbForTest();applyUiDensity("standard");});
function Harness({id}:{id:string}) {const tab=useDbSelector(s=>s.tabs.find(t=>t.id===id));return tab?.kind==="compare" ? <ComparisonWorkspace tab={tab} /> : null;}
function mount(before:ResultSnapshot,after:ResultSnapshot,keys:string[]=["ID"]) {
  const id=openCompareTab(before,after);patchTab<CompareTab>(id,{keys});
  act(()=>root.render(<Harness id={id} />));return id;
}
const button=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.startsWith(label))!;
const click=(label:string)=>act(()=>button(label).click());
const tab=(id:string)=>getDb().tabs.find(t=>t.id===id) as CompareTab;
const key=(name:string)=>[...host.querySelectorAll<HTMLLabelElement>(".dbx-compare-key-options label")].find(label=>label.textContent===name)!.querySelector<HTMLInputElement>("input")!;
const cell=(r:number,c:number)=>host.querySelector<HTMLDivElement>(`[data-record="${r}"][data-column="${c}"]`)!;
const grid=()=>host.querySelector<HTMLDivElement>('[role="grid"]')!;
const press=(element:Element,key:string,ctrlKey=false)=>act(()=>element.dispatchEvent(new KeyboardEvent("keydown",{key,ctrlKey,bubbles:true,cancelable:true})));
function search(value:string) {act(()=>{const input=host.querySelector<HTMLInputElement>('[aria-label="按键查找"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});}

it("首屏保留 A/B 来源和部分范围，手动选键后筛选与字段显隐不缩小全部 TSV",()=>{
  const before=snapshot({rows:[[1,"old","same"],[2,"removed","same"]],complete:false});
  const after=snapshot({source:"连接 B",schema:"SCHEMA_B",columns:[columns[2],columns[0],columns[1]],rows:[["same",1,"new"],["same",3,"added"]],at:2});
  const id=mount(before,after,[]);
  expect(host.textContent).toContain("先选择能唯一标识记录的字段");expect(host.querySelectorAll("input:checked")).toHaveLength(0);
  expect(host.querySelectorAll(".dbx-compare-source")).toHaveLength(2);
  expect(host.textContent).toContain("SCHEMA_A");expect(host.textContent).toContain("SCHEMA_B");
  expect(host.querySelector(".dbx-compare-scope")?.textContent).toContain("仅比较已加载数据，不能代表全表差异");
  act(()=>key("ID").click());expect(tab(id).keys).toEqual(["ID"]);
  expect(button("导出全部差异").textContent).toContain("3");click("修改");
  expect(button("修改").getAttribute("aria-pressed")).toBe("true");
  expect([...host.querySelectorAll('[role="columnheader"]')].map(c=>c.textContent)).toEqual(["变化差异类型","ID唯一键 · 冻结","VALUEA · 对照值","VALUEB · 当前值"]);
  search("not-found");expect(host.textContent).toContain("没有符合筛选条件的差异");
  click("导出全部差异");const output=vi.mocked(downloadText).mock.calls[0][1];
  expect(output).toContain("old");expect(output).toContain("new");expect(output).toContain("removed");expect(output).toContain("added");
  expect(output).toContain("NOTE");expect(output).toContain("仅比较已加载数据，不能代表全表差异");expect(output.split(/\r?\n/)).toHaveLength(5);
  expect(host.querySelector(".dbx-compare-scope")?.textContent).toContain("不能代表全表差异");
  click("清除筛选");expect(grid().getAttribute("aria-rowcount")).toBe("4");
});

it("重复键原位报错，可手动追加复合键；未使用行号替代唯一键",()=>{
  const cols=[col("ID"),col("TENANT"),col("VALUE")];
  const before=snapshot({columns:cols,rows:[[1,"a","old"],[1,"b","same"]]});
  mount(before,snapshot({columns:cols,rows:[[1,"b","same"],[1,"a","new"]]}),[]);
  act(()=>key("ID").click());expect(host.querySelector('[role="alert"]')?.textContent).toContain("重复值");
  expect(button("导出全部差异").disabled).toBe(true);
  act(()=>key("TENANT").click());expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(grid().getAttribute("aria-rowcount")).toBe("2");
  expect(host.querySelectorAll('.dbx-compare-heading[data-frozen="true"]')).toHaveLength(3);
  expect(cell(0,3).textContent).toBe("old");expect(cell(0,4).textContent).toBe("new");
});

it("双轴虚拟化保持绝对索引，键盘能到末行末列，切密度和返回文档恢复视图",()=>{
  const cols=[col("ID"),...Array.from({length:30},(_,i)=>col(`F${i}`))];
  const rows:Cell[][]=Array.from({length:1500},(_,i)=>[i,...cols.slice(1).map(()=>"old")]);
  const id=mount(snapshot({columns:cols,rows}),snapshot({columns:cols,rows:rows.map(row=>row.map((value,c)=>c===0 ? value : "new"))}));
  const element=grid();Object.defineProperty(element,"clientHeight",{value:220});Object.defineProperty(element,"clientWidth",{value:620});
  act(()=>{element.scrollTop=500*26;element.scrollLeft=2000;element.dispatchEvent(new Event("scroll",{bubbles:true}));});
  expect(host.querySelectorAll(".dbx-compare-row").length).toBeLessThan(40);
  expect(host.querySelectorAll('[role="columnheader"]').length).toBeLessThan(12);
  expect(host.querySelector('.dbx-compare-heading[data-frozen="true"]')).not.toBeNull();
  act(()=>cell(500,12).click());expect(tab(id).activeCell).toEqual({r:500,c:12});
  const beforeTop=element.scrollTop;
  act(()=>applyUiDensity("comfortable"));expect(element.scrollTop).toBeCloseTo(beforeTop/26*30);
  expect(element.style.getPropertyValue("--cmp-row-h")).toBe("30px");
  press(element,"End",true);expect(tab(id).activeCell).toEqual({r:1499,c:61});
  const activeId=element.getAttribute("aria-activedescendant")!;
  expect(document.getElementById(activeId)).toBe(cell(1499,61));expect(document.activeElement).toBe(element);
  const saved={top:tab(id).scrollTop,left:tab(id).scrollLeft};
  act(()=>root.render(null));act(()=>root.render(<Harness id={id} />));
  expect(grid().scrollTop).toBe(saved.top);expect(grid().scrollLeft).toBe(saved.left);
  expect(cell(1499,61).getAttribute("aria-selected")).toBe("true");
  expect(host.querySelectorAll(".dbx-compare-row").length).toBeLessThan(40);
});

it("长值详情保持原值复制，Esc 关闭后恢复原单元格焦点",()=>{
  const value=` {"raw":"${"x".repeat(20000)}", "n":1}\n`;
  mount(snapshot(),snapshot({rows:[[1,value,"same"]]}));
  act(()=>cell(0,3).click());press(grid(),"Enter");
  const detail=host.querySelector<HTMLPreElement>('[aria-label="单元格完整值"]')!;
  expect(detail.textContent).toBe(value);expect(document.activeElement).toBe(detail);
  click("JSON 格式化");expect(detail.textContent).toBe(JSON.stringify(JSON.parse(value),null,2));
  click("复制原值");expect(vi.mocked(copyText).mock.calls[0][0]).toBe(value);
  press(detail,"Escape");expect(host.querySelector('[aria-label="单元格详情"]')).toBeNull();
  expect(document.activeElement).toBe(grid());expect(document.getElementById(grid().getAttribute("aria-activedescendant")!)).toBe(cell(0,3));
});

it("缺失记录、NULL、空串和波浪号语义分开，缺失侧不可伪造原值复制",()=>{
  const cols=[col("ID"),col("VALUE")];
  mount(snapshot({columns:cols,rows:[[1,null],[2,"~"],[3,"removed"]]}),snapshot({columns:cols,rows:[[1,""],[2,null],[4,"~"]]}));
  expect(cell(0,2).dataset.valueKind).toBe("null");expect(cell(0,3).dataset.valueKind).toBe("empty");
  expect(cell(1,2).textContent).toBe("~");expect(cell(2,2).dataset.valueKind).toBe("missing");expect(cell(3,3).dataset.valueKind).toBe("missing");
  expect(cell(2,2).getAttribute("aria-label")).toContain("无此记录");
  act(()=>cell(2,2).click());press(grid(),"c",true);press(grid(),"Enter");
  expect(copyText).not.toHaveBeenCalled();expect(host.querySelector('[aria-label="单元格详情"]')).toBeNull();
  act(()=>cell(0,3).click());press(grid(),"c",true);expect(vi.mocked(copyText).mock.calls[0][0]).toBe("");
  act(()=>cell(1,2).click());press(grid(),"c",true);expect(vi.mocked(copyText).mock.calls[1][0]).toBe("~");
});

it("返回查询优先使用 B 来源文档并保留比对状态",()=>{
  const a=openSqlTab(null,"select A"),b=openSqlTab(null,"select B");
  const id=mount(snapshot({originTabId:a}),snapshot({originTabId:b,rows:[[1,"new","same"]]}));
  click("返回查询");expect(getDb().active).toBe(b);expect(tab(id).keys).toEqual(["ID"]);
});
