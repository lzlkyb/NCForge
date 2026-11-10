// @vitest-environment jsdom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
const h=vi.hoisted(()=>({clear:vi.fn(),copy:vi.fn(),map:{a:[{at:1,sql:"select 1",ms:1,summary:"ok",ok:true}],b:[{at:2,sql:"delete from B",ms:2,summary:"ok",ok:true}]}}));
vi.mock("../../lib/dbStore",()=>({useDbConns:()=>[{id:"a",name:"开发库"},{id:"b",name:"生产库"}]}));
vi.mock("../../lib/dbHistory",()=>({subscribeHistory:()=>()=>{},getHistoryMap:()=>h.map,historyHits:()=>[{connId:"a",entry:h.map.a[0]},{connId:"b",entry:h.map.b[0]}],filterHits:(v:unknown)=>v,historyTime:()=>"刚刚",clearHistory:h.clear}));
vi.mock("../../lib/utils",()=>({copyText:h.copy}));
import { HistoryDrawer } from "./HistoryDrawer";
import { CodePreview } from "./CodePreview";
import { JsonInspector } from "./JsonInspector";
import { PlanView } from "./PlanView";
import type { PlanRow } from "../../lib/dbApi";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.clearAllMocks();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text || b.getAttribute("aria-label")===text)!;
const type=async(input:HTMLInputElement,value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
it("历史跨连接只填入，清空必须经过显示目标和数量的确认",async()=>{
 const pick=vi.fn();await act(async()=>root.render(<HistoryDrawer connId="a" onPick={pick} onClose={()=>{}}/>));
 await act(async()=>button("填入（不执行）").click());expect(pick).toHaveBeenCalledWith("delete from B",false);
 await act(async()=>button("填入并执行").click());expect(pick).toHaveBeenLastCalledWith("select 1",true);
 await act(async()=>button("清空当前连接历史").click());expect(h.clear).not.toHaveBeenCalled();expect(host.textContent).toContain("开发库");expect(host.textContent).toContain("1 条执行历史");
 await act(async()=>button("取消清空").click());expect(h.clear).not.toHaveBeenCalled();
 await act(async()=>button("清空当前连接历史").click());await act(async()=>button("确认清空").click());expect(h.clear).toHaveBeenCalledExactlyOnceWith("a");
});
it("代码高亮不执行HTML，多词查找跨token命中，复制保留全文",async()=>{
 const text="select * from T where X='<img src=x>'";
 await act(async()=>root.render(<CodePreview text={text} label="测试SQL"/>));
 expect(host.querySelector("pre")?.textContent).toBe(text);expect(host.querySelector("img")).toBeNull();
 await act(async()=>button("查找测试SQL").click());await type(host.querySelector("input")!,"select * from");
 expect([...host.querySelectorAll("mark")].map(e=>e.textContent).join("")).toBe("select * from");
 await act(async()=>button("复制测试SQL").click());expect(h.copy.mock.calls[0][0]).toBe(text);
});
it("JSON树按需展开，展示复制与原文无关且不创建Monaco",async()=>{
 await act(async()=>root.render(<JsonInspector text={JSON.stringify({a:{b:1}})}/>));
 await act(async()=>button("树形查看").click());
 expect(host.querySelector('[aria-label="JSON 树"]')).not.toBeNull();expect(host.textContent).toContain("a");expect(host.querySelector(".monaco-editor")).toBeNull();
});
it("执行计划收起节点隐藏后代，搜索子节点时保留上级",async()=>{
 const rows=[{depth:0,operation:"SELECT",object:"",cost:2,rows:2,access:"",filter:""},{depth:1,operation:"TABLE ACCESS",object:"CHILD",cost:1,rows:1,access:"",filter:""}] as PlanRow[];
 await act(async()=>root.render(<PlanView plan={{sql:"select * from CHILD",rows}}/>));
 await act(async()=>button("收起 SELECT").click());expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
 await type(host.querySelector('[aria-label="搜索执行计划"]')!,"CHILD");expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
 expect(host.textContent).toContain("不代表实际耗时");
});
