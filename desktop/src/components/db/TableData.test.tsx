// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GridEdit } from "./ResultGrid";
import type { Cell, ColumnInfo, TableInfo } from "../../lib/dbApi";
const mocks=vi.hoisted(()=>({invoke:vi.fn(),confirm:vi.fn(),ask:vi.fn()}));
vi.mock("../../lib/tauri",()=>({invoke:mocks.invoke}));
vi.mock("../../lib/dbConfirm",()=>({confirmProdWrite:mocks.confirm,ask:mocks.ask}));
vi.mock("./ResultTable",()=>({ResultTable:({edit,rows,tools,foot}:{edit?:GridEdit;rows:Cell[][];tools:ReactNode;foot:ReactNode})=><><output>{JSON.stringify(rows)}</output><output data-can-edit-memo="1">{String(edit?.canEdit?.(2,0))}</output><button onClick={()=>edit?.onEdit(0,1,"new-A")}>edit A</button><button onClick={()=>edit?.onEdit(1,1,"new-B")}>edit B</button><button onClick={()=>edit?.onEdit(2,0,"900")}>fill draft id</button><button onClick={()=>edit?.onEdit(2,1,"new-row")}>fill draft code</button><button onClick={()=>edit?.onDeleteRow?.(0)}>delete row 0</button><button onClick={()=>edit?.onEdit(0,2,"new-memo")}>edit memo</button>{tools}{foot}</>}));
import { TableData } from "./TableData";
import { __resetDbForTest, connect, setConns, type TableTab } from "../../lib/dbStore";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const cols:ColumnInfo[]=[{name:"ID",type:"NUMBER",size:0,zh:null,full:"NUMBER",pk:true,nullable:false,default:null,comment:null},{name:"CODE",type:"VARCHAR2",size:0,zh:null,full:"VARCHAR2",pk:false,nullable:true,default:null,comment:null}];
const tab:TableTab={kind:"table",id:"t",connId:"c",table:"TEST",sub:"data"};
const tx={autoCommit:false,statements:0,rows:0,since:0};
let root:Root, host:HTMLDivElement;
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes(text))!;
beforeEach(async()=>{
 localStorage.clear();sessionStorage.clear();mocks.invoke.mockReset();mocks.confirm.mockResolvedValue(true);mocks.ask.mockResolvedValue(true);__resetDbForTest();
 mocks.invoke.mockImplementation((cmd:string,args:Record<string,unknown>)=>{
  if(cmd==="db_connect") return Promise.resolve({url:"jdbc:oracle:thin:@host:1521/test",user:"u",autoCommit:false});
  if(cmd==="db_read_only") return Promise.resolve({readOnly:false,tx});
  if(cmd==="db_meta") return Promise.resolve(args.kind==="tables"?{tables:[] as TableInfo[]}:{names:{}});
  if(cmd==="db_exec_bound") {
   const sql=String(args.sql);if(sql.startsWith("update")||sql.startsWith("insert")||sql.startsWith("delete")) {const params=args.params as Cell[];return Promise.resolve({kind:"update",updateCount:sql.startsWith("update")&&params[0]!=="new-A"?0:1,tx:{...tx,statements:1,rows:1},ms:1});}
   return Promise.resolve({kind:"rows",columns:cols,rows:sql.startsWith("select * from TEST where")?[[2,"changed-by-other"]]:[[1,"old-A"],[2,"old-B"]],hasMore:false,tx,ms:1});
  }
  return Promise.resolve(null);
 });
 setConns([{id:"c",name:"Test",env:"test",source:"manual",url:"jdbc:oracle:thin:@host:1521/test",user:"u",propDs:null,autoCommit:false,note:"",hasPassword:false,engine:"rust"}]);
 await connect("c");host=document.createElement("div");document.body.append(host);root=createRoot(host);await act(async()=>root.render(<TableData tab={tab} cols={cols} isView={false} zh={{}}/>));
});
afterEach(()=>{act(()=>root.unmount());host.remove();});
it("stops on concurrent changes, shows current values and never retries already written rows",async()=>{
 act(()=>button("edit A").click());act(()=>button("edit B").click());act(()=>button("复核修改").click());
 expect(button("写回 2 行").disabled).toBe(false);
 await act(async()=>button("写回 2 行").click());
 expect(host.textContent).toContain("原值校验未通过");expect(host.textContent).toContain("changed-by-other");expect(host.textContent).toContain("new-A");
 const updates=()=>mocks.invoke.mock.calls.filter(([cmd,args])=>cmd==="db_exec_bound" && String(args.sql).startsWith("update"));
 expect(updates()).toHaveLength(2);expect((updates()[0][1].params as unknown[])).toEqual(["new-A",{number:"1"},"old-A"]);
 await act(async()=>button("写回 1 行").click());expect(updates()).toHaveLength(3);expect(updates()[2][1].params[0]).toBe("new-B");
});
it("does not edit or write when the backend reports query-only mode",async()=>{
 await act(async()=>window.dispatchEvent(new CustomEvent("ncforge-db-readonly",{detail:{id:"c",readOnly:true}})));
 act(()=>button("edit A").click());expect(button("写回")).toBeUndefined();expect(mocks.invoke.mock.calls.filter(([cmd,args])=>cmd==="db_exec_bound" && String(args.sql).startsWith("update"))).toHaveLength(0);
});
it("restores saved bound conditions on reopening and issues real refresh for identical criteria",async()=>{
 localStorage.setItem("ncforge-db-filter:c:test",JSON.stringify({conditions:[{column:"CODE",op:"eq",value:"O'Brien",end:""}],join:"and",sort:"",descending:false}));
 await act(async()=>root.unmount());root=createRoot(host);await act(async()=>root.render(<TableData tab={tab} cols={cols} isView={false} zh={{}}/>));
 const queryCalls=()=>mocks.invoke.mock.calls.filter(([cmd,args])=>cmd==="db_exec_bound" && String(args.sql).startsWith("select"));
 expect(queryCalls()[queryCalls().length-1][1].params).toEqual(["O'Brien"]);expect(queryCalls()[queryCalls().length-1][1].sql).not.toContain("O'Brien");
 const count=queryCalls().length;await act(async()=>button("查询").click());expect(queryCalls().length).toBe(count+1);
});
it("uses bound primary-key seeks for next and previous pages and restores ascending display",async()=>{
 const base=mocks.invoke.getMockImplementation()!;
 mocks.invoke.mockImplementation((cmd:string,args:Record<string,unknown>)=>{
  if(cmd!=="db_exec_bound") return base(cmd,args);
  const sql=String(args.sql).toLowerCase(), descending=sql.includes("id desc");
  const start=sql.includes("id > ?")?201:1;
  const rows=Array.from({length:201},(_,i)=>[descending?200-i:start+i,"value"]);
  return Promise.resolve({kind:"rows",columns:cols,rows,hasMore:true,tx,ms:1});
 });
 await act(async()=>button("查询").click());
 await act(async()=>button("下一页").click());
 const calls=()=>mocks.invoke.mock.calls.filter(([cmd])=>cmd==="db_exec_bound");
 expect(calls()[calls().length-1][1].sql.toLowerCase()).toContain("id > ?");
 expect(calls()[calls().length-1][1].params).toEqual([{number:"200"}]);
 await act(async()=>button("上一页").click());
 expect(calls()[calls().length-1][1].sql.toLowerCase()).toContain("id < ?");
 expect(JSON.parse(host.querySelector("output")!.textContent!)[0]).toEqual([1,"value"]);
});
it("keeps loaded counts visible and never calls the final page a complete table result",async()=>{
 expect(host.querySelector(".dbx-rfoot")?.textContent).toContain("已加载 2 行");
 expect(host.querySelector(".dbx-completeness")?.textContent).toBe("完整结果");
 const base=mocks.invoke.getMockImplementation()!;
 mocks.invoke.mockImplementation((cmd:string,args:Record<string,unknown>)=>{
  if(cmd!=="db_exec_bound") return base(cmd,args);
  const next=String(args.sql).toLowerCase().includes("id > ?");
  return Promise.resolve({kind:"rows",columns:cols,rows:next ? [[201,"last"]] : Array.from({length:201},(_,i)=>[i+1,"value"]),hasMore:!next,tx,ms:1});
 });
 await act(async()=>button("查询").click());
 expect(host.querySelector(".dbx-rfoot")?.textContent).toContain("已加载 200 行");
 expect(host.querySelector(".dbx-completeness")?.hasAttribute("data-partial")).toBe(true);
 await act(async()=>button("下一页").click());
 expect(host.querySelector(".dbx-rfoot")?.textContent).toContain("已加载 1 行");
 expect(host.querySelector(".dbx-rfoot")?.textContent).toContain("第 2 页");
 expect(host.querySelector(".dbx-completeness")?.textContent).toBe("当前页数据");
 expect(button("下一页").disabled).toBe(true);
});
it("shows changed source identity beside retained table rows and blocks writing them to another account",async()=>{
 act(()=>button("edit A").click());act(()=>button("复核修改").click());
 await act(async()=>setConns([{id:"c",name:"Test",env:"test",source:"manual",url:"jdbc:oracle:thin:@host:1521/test",user:"other",propDs:null,autoCommit:false,note:"",hasPassword:false,engine:"rust"}]));
 expect(host.querySelector(".dbx-result-context-note")?.textContent).toContain("连接目标已变化");
 expect(host.querySelector("output")?.textContent).toContain("old-A");
 await act(async()=>button("写回 1 行").click());
 expect(mocks.invoke.mock.calls.filter(([cmd,args])=>cmd==="db_exec_bound" && String(args.sql).startsWith("update"))).toHaveLength(0);
});
it("adds rows as insert and deletes rows as delete, running delete before insert",async()=>{
 act(()=>button("delete row 0").click());
 act(()=>button("+ 新增行").click());
 act(()=>button("fill draft id").click());act(()=>button("fill draft code").click());
 act(()=>button("复核修改").click());
 expect(host.textContent).toContain("待写回");
 expect(button("写回 2 行").disabled).toBe(false);
 await act(async()=>button("写回 2 行").click());
 const writes=mocks.invoke.mock.calls.map(([,args])=>String(args?.sql ?? "")).filter(sql=>/^(delete|insert)/.test(sql));
 expect(writes[0]).toBe("delete from TEST where ID = :1");
 expect(writes[1]).toBe("insert into TEST (ID, CODE) values (:1, :2)");
});

it("blocks writing a new row when a non-null column without default is empty",async()=>{
 act(()=>button("+ 新增行").click());
 act(()=>button("fill draft code").click());
 act(()=>button("复核修改").click());
 await act(async()=>button("写回 1 行").click());
 expect(mocks.invoke.mock.calls.filter(([,args])=>String(args?.sql ?? "").startsWith("insert"))).toHaveLength(0);
 // 被本地必填校验拦下：一条 insert 都没发，待写回清单保持原样。
 expect(button("写回 1 行")).toBeTruthy();
});

it("treats truncated CLOB cells as uneditable and never writes the preview back",async()=>{
 const preview=`{"k":"${"x".repeat(10)}"} …（共 20000 个字符，只显示前 8192，点「加载完整值」查看）`;
 const memoCols:ColumnInfo[]=[...cols,{name:"MEMO",type:"CLOB",size:0,zh:null,full:"CLOB",pk:false,nullable:true,default:null,comment:null}];
 const memoMeta=[{name:"ID",type:"NUMBER",precision:0,scale:0},{name:"CODE",type:"VARCHAR2",precision:0,scale:0},{name:"MEMO",type:"CLOB",precision:0,scale:0}];
 const base=mocks.invoke.getMockImplementation()!;
 mocks.invoke.mockImplementation((cmd:string,args:Record<string,unknown>)=>{
  if(cmd!=="db_exec_bound" || !String(args.sql).startsWith("select")) return base(cmd,args);
  return Promise.resolve({kind:"rows",columns:memoMeta,rows:[[1,"old-A",preview]],hasMore:false,tx,ms:1});
 });
 await act(async()=>root.unmount());root=createRoot(host);await act(async()=>root.render(<TableData tab={tab} cols={memoCols} isView={false} zh={{}}/>));
 // 真实网格先问 canEdit：预览格（只有前 8K）不能编辑。
 expect(host.querySelector("[data-can-edit-memo]")?.textContent).toBe("false");
 expect(host.textContent).toContain("old-A");
 // 即使漏进一条预览格改动，也只显示原因并跳过它，绝不能把截断内容当新值写回。
 act(()=>button("edit memo").click());
 expect(host.querySelector("[role=alert]")?.textContent).toContain("大文本预览");
 const save=button("写回 1 行"); if(save) await act(async()=>save.click());
 expect(mocks.invoke.mock.calls.filter(([cmd,args])=>cmd==="db_exec_bound" && String(args.sql).startsWith("update"))).toHaveLength(0);
});
