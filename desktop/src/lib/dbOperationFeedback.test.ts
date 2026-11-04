import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({tab:{id:"t",kind:"sql",title:"SQL 1",connId:"c",slot:"7",running:false,results:[] as unknown[]},ensure:vi.fn(),exec:vi.fn(),cancel:vi.fn(),activate:vi.fn(),patch:vi.fn()}));
vi.mock("./dbApi",()=>({dbApi:{cancel:mocks.cancel}}));
vi.mock("./dbStore",()=>({tabOf:()=>mocks.tab,activateTab:mocks.activate,sqlTabOf:()=>mocks.tab,connOf:()=>({name:"测试连接"}),patchTab:(_id:string,patch:Record<string,unknown>)=>{Object.assign(mocks.tab,patch);mocks.patch(patch);},execOne:mocks.exec,appendOutput:vi.fn(),loadMeta:vi.fn()}));
vi.mock("./dbConfirm",()=>({ensureConnected:mocks.ensure,confirmProdWrite:vi.fn(async()=>true)}));
vi.mock("./sqlModels",()=>({disposeSqlModel:vi.fn()}));
vi.mock("../components/ui/toast",()=>({toast:vi.fn()}));
import { runStatements } from "./dbActions";
import { cancelOperation, clearCompletedOperations, getOperations, revealOperation } from "./operations";
const latest=()=>getOperations().slice(-1)[0];
const success={id:"r",kind:"rows",rows:[],columns:[],hasMore:false,ms:1,updateCount:-1,index:1,sql:"sensitive SQL"};
beforeEach(()=>{Object.assign(mocks.tab,{running:false,connId:"c",slot:"7",results:[]});mocks.ensure.mockReset().mockResolvedValue(true);mocks.exec.mockReset();mocks.cancel.mockReset().mockResolvedValue(undefined);mocks.patch.mockClear();clearCompletedOperations();});
afterEach(()=>{expect(getOperations().filter(o=>!o.endedAt)).toHaveLength(0);});
describe("数据库用户任务反馈",()=>{
  it("连接等待期间重复执行只处理一次，失败以数量汇总且不复制 SQL",async()=>{
    let ready!:(v:boolean)=>void;mocks.ensure.mockReturnValue(new Promise<boolean>(r=>{ready=r;}));
    mocks.exec.mockResolvedValueOnce({...success}).mockResolvedValueOnce({...success,id:"r2",kind:"error",error:"secret password : bind-value"});
    const stmts=[{text:"select secret",startLine:1},{text:"select password",startLine:2}];
    const first=runStatements("t",stmts);await runStatements("t",stmts);expect(mocks.ensure).toHaveBeenCalledTimes(1);
    ready(true);const out=await first;expect(mocks.exec).toHaveBeenCalledTimes(2);expect(out.failures).toHaveLength(1);
    expect(latest().state).toBe("failed");expect(latest().progress).toEqual({done:2,total:2});
    expect(JSON.stringify(latest())).not.toMatch(/secret|password|bind-value/);expect(latest().scope).toContain("独立会话 7");
    revealOperation(latest().id);expect(mocks.activate).toHaveBeenCalledWith("t");
  });
  it("取消请求不提前结束，真实取消返回后即使忽略错误也不执行下一条",async()=>{
    let finish!:(r:typeof success & {cancelled:boolean;error:string})=>void;
    mocks.exec.mockReturnValue(new Promise(r=>{finish=r;}));
    const run=runStatements("t",[{text:"select 1",startLine:1},{text:"select 2",startLine:2}],{ignoreErrors:true});
    await Promise.resolve();await cancelOperation(latest().id);
    expect(mocks.cancel).toHaveBeenCalledWith("c","7");expect(latest().state).toBe("cancelling");expect(mocks.tab.running).toBe(true);
    finish({...success,kind:"error",cancelled:true,error:"ORA-01013"});await run;
    expect(latest().state).toBe("cancelled");expect(mocks.exec).toHaveBeenCalledTimes(1);expect(mocks.tab.running).toBe(false);
  });
  it("连接选择已经改变时旧执行请求不运行新连接上的 SQL",async()=>{
    let ready!:(v:boolean)=>void;mocks.ensure.mockReturnValue(new Promise<boolean>(r=>{ready=r;}));
    const run=runStatements("t",[{text:"select 1",startLine:1}]);mocks.tab.connId="other";ready(true);await run;
    expect(mocks.exec).not.toHaveBeenCalled();expect(latest().state).toBe("cancelled");
  });
  it("连接尚在等待时请求停止，连接完成后不再发送 SQL",async()=>{
    let ready!:(v:boolean)=>void;mocks.ensure.mockReturnValue(new Promise<boolean>(r=>{ready=r;}));
    const run=runStatements("t",[{text:"select 1",startLine:1}]);await cancelOperation(latest().id);
    expect(latest().state).toBe("cancelling");expect(mocks.cancel).not.toHaveBeenCalled();
    ready(true);const out=await run;expect(out.stoppedByUser).toBe(true);expect(mocks.exec).not.toHaveBeenCalled();expect(latest().state).toBe("cancelled");
  });
  it("意外失败也释放运行态并保持安全摘要",async()=>{
    mocks.exec.mockRejectedValue(new Error("secret SQL"));
    await expect(runStatements("t",[{text:"select 1",startLine:1}])).rejects.toThrow("secret SQL");
    expect(mocks.tab.running).toBe(false);expect(latest().state).toBe("failed");expect(JSON.stringify(latest())).not.toContain("secret");
  });
});
