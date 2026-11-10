// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("./tauri",()=>({invoke:mocks.invoke}));
import { __resetDbForTest, claimCursor, execOne, loadMore, openSqlTab, patchTab, setConns, sqlTabOf, type ResultEntry, type SqlTab } from "./dbStore";
import type { DbConn } from "./dbApi";

beforeEach(()=>{mocks.invoke.mockReset();__resetDbForTest();});
it("返回结果使用请求开始时的来源，不使用等待期间被改动的连接",async()=>{
  const conn={id:"c",name:"原连接",env:"test",source:"manual",url:"jdbc:test",user:"NC",engine:"java",propDs:null} as DbConn;
  setConns([conn]);
  const id=openSqlTab("c","select 1 from dual");
  let resolve!:(value:unknown)=>void,started!:()=>void;
  const ready=new Promise<void>(r=>{started=r;}),response=new Promise(r=>{resolve=r;});
  mocks.invoke.mockImplementation((command:string)=>command==="db_slot_acquire" ? Promise.resolve({slot:"1"}) : command==="db_exec" ? (started(),response) : Promise.resolve(null));
  const pending=execOne(id,"select 1 from dual",1);
  await ready;setConns([{...conn,name:"新连接",user:"OTHER"}]);
  resolve({kind:"rows",columns:[],rows:[],hasMore:false,ms:1,output:[],tx:{autoCommit:true,statements:0,rows:0,since:0}});
  const result=await pending;
  expect(result.context?.source).toContain("原连接");expect(result.context?.source).not.toContain("新连接");
  expect(result.context?.connectionKey).toContain('"NC"');
});
function loaded() {
  const id=openSqlTab("c","select 1 from dual");
  const entry:ResultEntry={id:"result",index:1,sql:"select 1",kind:"rows",columns:[],rows:[[1]],hasMore:true,ms:1,updateCount:-1};
  patchTab<SqlTab>(id,{slot:"1",results:[entry]});claimCursor("c","1",entry.id);
  return {id,result:()=>sqlTabOf(id)!.results[0]};
}
it("续取暂时失败原位保留错误，并允许重试成功后清除",async()=>{
  const {id,result}=loaded();
  mocks.invoke.mockRejectedValueOnce(new Error("读取暂时失败")).mockResolvedValueOnce({rows:[[2]],hasMore:false});
  await loadMore(id,"result");
  expect(result().rows).toEqual([[1]]);expect(result().moreError).toContain("读取暂时失败");expect(result().moreRetryable).toBe(true);
  await loadMore(id,"result");
  expect(result().rows).toEqual([[1],[2]]);expect(result().moreError).toBeUndefined();expect(result().hasMore).toBe(false);
});
it("会话丢失保留已加载数据，并停止对失效游标的重试",async()=>{
  const {id,result}=loaded();mocks.invoke.mockRejectedValue("slot-gone|会话已回收");
  await loadMore(id,"result");await loadMore(id,"result");
  expect(result().moreRetryable).toBe(false);expect(result().moreError).toContain("游标已失效");
  expect(result().rows).toEqual([[1]]);expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
it("游标被别的查询接管时明确说原因，且不再给重试",async()=>{
  const {id,result}=loaded();
  // 另一条结果把同一会话的游标占了
  claimCursor("c","1","other-result");
  await loadMore(id,"result");
  expect(result().moreError).toContain("游标已被其他查询占用");
  expect(result().moreRetryable).toBe(false);
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it("Rust 引擎续取时游标已关闭：说清楚要重新执行，不引导重试",async()=>{
  const {id,result}=loaded();
  mocks.invoke.mockRejectedValue("cursor-closed|没有可以继续读取的结果（游标已关闭，重新执行一次）");
  await loadMore(id,"result");await loadMore(id,"result");
  expect(result().moreError).toContain("游标已关闭");
  expect(result().moreRetryable).toBe(false);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
