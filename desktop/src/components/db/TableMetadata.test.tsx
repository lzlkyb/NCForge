// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ patch: vi.fn(), columns:vi.fn(),indexes:vi.fn(),ddl:vi.fn(),copy:vi.fn() }));
vi.mock("../../lib/dbApi",()=>({dbApi:{indexes:mocks.indexes,objectDdl:mocks.ddl}}));
vi.mock("../../lib/utils",()=>({copyText:mocks.copy}));
vi.mock("../../lib/dbStore", () => ({ connOf:()=>({name:"测试库"}), useConnRt: () => ({ status: "connected" }), columnsOf: mocks.columns, patchTab: mocks.patch }));
vi.mock("../../lib/dbRelations", () => ({ returnRelated: vi.fn() }));
vi.mock("./DbContextBar", () => ({ DbContextBar: () => null }));
vi.mock("./ImportDialog", () => ({ ImportDialog: () => null }));
vi.mock("./StructDiffDialog", () => ({ StructDiffDialog: () => null }));
vi.mock("./SourceView", () => ({ SourceView: () => null }));
vi.mock("./TableData", () => ({ TableData: () => null }));
vi.mock("./TableMoreActions", () => ({ TableMoreActions: () => null }));
vi.mock("./InsertExportDialog", () => ({ InsertExportDialog: () => null }));
import { TablePage } from "./TablePage";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("结构支持中文搜索、主键过滤和保留类型的定义复制",async()=>{
 const cols=[{name:"ID",type:"NUMBER",full:"NUMBER(20)",pk:true,nullable:false,zh:"主键",default:"0",comment:""},{name:"NAME",type:"VARCHAR2",full:"VARCHAR2(30)",pk:false,nullable:true,zh:"名称",default:null,comment:"客户"}];
 mocks.columns.mockResolvedValue(cols);
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 try {
 await act(async()=>root.render(<TablePage tab={{id:"t",connId:"c",table:"T",sub:"struct",kind:"table"}}/>));
 const input=host.querySelector<HTMLInputElement>('[aria-label="搜索结构字段"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"客户");input.dispatchEvent(new Event("input",{bubbles:true}));});
 expect(host.querySelectorAll("tbody tr")).toHaveLength(1);expect(host.querySelector("tbody")?.textContent).toContain("name");
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"");input.dispatchEvent(new Event("input",{bubbles:true}));});
 const select=host.querySelector<HTMLSelectElement>('[aria-label="结构字段范围"]')!;
 await act(async()=>{select.value="pk";select.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="复制字段定义 ID"]')!.click());
 expect(mocks.copy.mock.calls[0][0]).toBe("ID NUMBER(20) DEFAULT 0 NOT NULL");
 }finally{await act(async()=>root.unmount());host.remove();}
});
it("索引定义按需请求INDEX类型，展示列序并能定位表结构",async()=>{
 mocks.columns.mockResolvedValue([]);mocks.indexes.mockResolvedValue({indexes:[{name:"IDX_T",columns:"ID, NAME",unique:true,status:"VALID"}]});mocks.ddl.mockResolvedValue({ddl:"CREATE INDEX IDX_T ON T (ID, NAME);"});
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 try {
 await act(async()=>root.render(<TablePage tab={{id:"t",connId:"c",table:"T",sub:"idx",kind:"table"}}/>));
 const button=(name:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===name)!;
 await act(async()=>button("idx_t").click());expect(mocks.ddl).not.toHaveBeenCalled();
 expect([...host.querySelectorAll("ol li")].map(e=>e.textContent)).toEqual(["ID","NAME"]);
 await act(async()=>button("查看索引定义").click());expect(mocks.ddl).toHaveBeenCalledWith("c","IDX_T","INDEX");expect(host.textContent).toContain("CREATE INDEX");
 await act(async()=>button("查看表结构").click());expect(mocks.patch).toHaveBeenCalledWith("t",{sub:"struct"});
 }finally{await act(async()=>root.unmount());host.remove();}
});
