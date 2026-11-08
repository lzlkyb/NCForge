// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useResultTransferDialog } from "./useResultTransferDialog";
import { __resetDbForTest, changeSchema, setConns } from "../lib/dbStore";
import { connectionKey } from "../lib/dbResultContext";
import type { DbConn } from "../lib/dbApi";
import { startTransferJob } from "../lib/resultTransferJobs";
import type { TransferFrame } from "../lib/resultTransferContext";

vi.mock("../lib/tauri",()=>({invoke:vi.fn(async(command:string,args:{schema?:string})=>command==="db_set_schema" ? {schema:args.schema} : {tables:[],names:{},schema:{}})}));
vi.mock("../lib/resultTransferJobs",()=>({startTransferJob:vi.fn()}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
const conn={id:"c",name:"测试",env:"test",source:"manual",url:"jdbc:test",user:"NC",engine:"java",propDs:null} as DbConn;
const frame:TransferFrame={data:{columns:[{name:"ID",type:"NUMBER",precision:8,scale:0}],rows:[[1]]},order:[0],visible:[0],labels:["ID"],selection:null,
  source:{connId:"c",resultId:"r",sql:"select ID from T",source:"执行时测试库",schema:"A",connectionKey:connectionKey(conn),complete:false}};
const host=document.createElement("div"),root=createRoot(host);
let controller:ReturnType<typeof useResultTransferDialog>;
function Harness(){controller=useResultTransferDialog(frame,"file");return null;}
beforeEach(()=>{__resetDbForTest();localStorage.clear();vi.clearAllMocks();setConns([conn]);});
afterEach(()=>{act(()=>root.render(null));__resetDbForTest();});
it("重查请求始终携带冻结 schema 和连接身份，即使当前 schema 已改",async()=>{
  act(()=>root.render(<Harness/>));
  await act(async()=>changeSchema("c","B"));
  act(()=>controller.scope("query"));
  await act(async()=>controller.run());
  expect(startTransferJob).toHaveBeenCalledWith(frame.source,expect.objectContaining({sourceSchema:"A",sourceConnectionKey:frame.source.connectionKey,data:undefined}),expect.any(String),expect.any(Object));
  act(()=>controller.opt("nc",true));
  expect(controller.error).toContain("schema A");
  await act(async()=>controller.run());expect(controller.state.ncOpen).toBe(false);
});
it("修改数据库目标后不能重查旧来源，但本地已加载范围仍能输出",async()=>{
  act(()=>root.render(<Harness/>));act(()=>setConns([{...conn,user:"OTHER"}]));
  expect(controller.sourceError).toContain("连接目标已变化");expect(controller.canRequery).toBe(false);
  act(()=>controller.scope("query"));await act(async()=>controller.run());expect(startTransferJob).not.toHaveBeenCalled();
  act(()=>controller.scope("loaded"));await act(async()=>controller.run());
  expect(startTransferJob).toHaveBeenCalledWith(frame.source,expect.objectContaining({sourceSchema:undefined,sourceConnectionKey:undefined,data:expect.objectContaining({rows:[[1]]})}),expect.any(String),expect.any(Object));
});
