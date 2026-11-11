// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(()=>({create:vi.fn(),model:vi.fn(),open:vi.fn(),copy:vi.fn(),find:vi.fn(),focus:vi.fn(),options:vi.fn(),dispose:vi.fn(),setModel:vi.fn(),setLanguage:vi.fn(),models:[] as {text:string;dispose:ReturnType<typeof vi.fn>}[]}));
vi.mock("../../hooks/useSqlDialect",()=>({useSqlDialect:()=>"plsql"}));
vi.mock("../../lib/dbActions",()=>({newConsole:h.open}));
vi.mock("../../lib/utils",()=>({copyText:h.copy}));
vi.mock("../ui/toast",()=>({toast:vi.fn()}));
vi.mock("../../lib/monacoSetup",()=>({initMonaco:()=>({editor:{create:h.create,createModel:h.model,setModelLanguage:h.setLanguage}})}));
import { SqlCodeViewer } from "./SqlCodeViewer";
import SqlCodeViewerEditor from "./SqlCodeViewerEditor";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement;
beforeEach(()=>{
 vi.clearAllMocks();h.models=[];
 h.model.mockImplementation((text:string)=>{const model={text,dispose:vi.fn()};h.models.push(model);return model;});
 h.create.mockImplementation(()=>({focus:h.focus,getAction:()=>({run:h.find}),updateOptions:h.options,setModel:h.setModel,getModel:()=>h.models[h.models.length-1],dispose:h.dispose}));
 host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const button=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(item=>item.getAttribute("aria-label")===label || item.textContent===label)!;
it("使用SQL模型与只读设置，切内容释放旧模型，关闭释放编辑器",async()=>{
 const api={current:null};
 await act(async()=>root.render(<SqlCodeViewerEditor text="CREATE TABLE T (ID NUMBER);" label="DDL" wrap={false} apiRef={api}/>));
 expect(h.model).toHaveBeenCalledWith("CREATE TABLE T (ID NUMBER);","sql");
 expect(h.create.mock.calls[0][1]).toMatchObject({readOnly:true,domReadOnly:true,lineNumbers:"on",folding:true,theme:"nc-forge"});
 await act(async()=>root.render(<SqlCodeViewerEditor text="CREATE TABLE U (N VARCHAR2(20));" label="DDL" wrap apiRef={api}/>));
 expect(h.models[0].dispose).toHaveBeenCalledOnce();
 expect(h.options).toHaveBeenLastCalledWith({wordWrap:"on"});
 await act(async()=>root.unmount());root=createRoot(host);
 expect(h.models[1].dispose).toHaveBeenCalledOnce();expect(h.dispose).toHaveBeenCalledTimes(2);expect(api.current).toBeNull();
});
it("切换方言仅更新语言，不重建查看器与模型",async()=>{
 const api={current:null},text="select q'[it's]' from dual";
 await act(async()=>root.render(<SqlCodeViewerEditor text={text} label="SQL" wrap={false} apiRef={api} dialect="plsql"/>));
 await act(async()=>root.render(<SqlCodeViewerEditor text={text} label="SQL" wrap={false} apiRef={api} dialect="postgresql"/>));
 expect(h.create).toHaveBeenCalledOnce();expect(h.model).toHaveBeenCalledOnce();
 expect(h.setLanguage).toHaveBeenLastCalledWith(h.models[0],"ncforge-sql-postgresql");
});
it("查找与换行作用于查看器，复制和打开控制台保持DDL原文",async()=>{
 const text="CREATE TABLE \"T\" (ID NUMBER DEFAULT 0);\n-- 原文";
 await act(async()=>root.render(<SqlCodeViewer text={text} connId="c1" label="对象定义"/>));
 // 等待React.lazy的模块promise；后续交互不能在加载占位上执行。
 await act(async()=>{await import("./SqlCodeViewerEditor");});
 await act(async()=>button("查找代码").click());expect(h.find).toHaveBeenCalledOnce();
 await act(async()=>button("自动换行").click());expect(h.options).toHaveBeenLastCalledWith({wordWrap:"on"});
 await act(async()=>button("复制").click());expect(h.copy.mock.calls[0][0]).toBe(text);
 await act(async()=>button("打开到 SQL 控制台").click());expect(h.open).toHaveBeenCalledWith("c1",text);
});
it("包规范和包体切换不混行，复制全文仍包含原始的所有段",async()=>{
 const spec="PACKAGE P AS\nEND;\n",body="PACKAGE BODY P AS\nEND;\n";
 await act(async()=>root.render(<SqlCodeViewer text={spec+body} connId="c" label="源码" sections={[{label:"PACKAGE",text:spec},{label:"PACKAGE BODY",text:body}]}/>));
 const select=host.querySelector("select")!;
 await act(async()=>{select.value="1";select.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(h.models[h.models.length - 1]?.text).toBe(body);
 await act(async()=>button("复制全文").click());expect(h.copy.mock.calls[0][0]).toBe(spec+body);
 await act(async()=>button("打开到 SQL 控制台").click());expect(h.open).toHaveBeenCalledWith("c",body);
});
