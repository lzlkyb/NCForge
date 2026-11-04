// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileSave } from "./useFileSave";
import { getSession, setSession } from "../lib/workspaceSession";
import { clearCompletedOperations, getOperations } from "../lib/operations";
import { invalidateWorkspaceRequests } from "../lib/workspaceEpoch";
import type { TabMeta } from "../lib/workspaceSession";
const h=vi.hoisted(()=>({saveOne:vi.fn(),readFile:vi.fn(),replaceContent:vi.fn(),toast:vi.fn(),model:{getAlternativeVersionId:vi.fn(()=>1)}}));
vi.mock("../lib/editorStore",()=>({getModel:()=>h.model,replaceContent:h.replaceContent}));
vi.mock("../lib/fileSave",()=>({saveOne:h.saveOne}));
vi.mock("../lib/autoCompileQueue",()=>({queueAutoCompile:()=>false}));
vi.mock("../lib/appConfig",()=>({autoCompileCached:()=>false}));
vi.mock("../components/ui/toast",()=>({toast:h.toast}));
vi.mock("../lib/workspace",()=>({readFile:h.readFile,baseName:(p:string)=>p.split("\\").pop(),countLines:()=>1,cleanError:String,isConflictError:()=>false,isUnencodableError:()=>false}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const path="C:\\w\\A.java";
const tab={path,name:"A.java",encoding:"UTF-8",hasBom:false,eol:"LF",mtimeMs:1,dirty:true,eolChanged:false,readOnly:false,readOnlyReason:null,lines:1} as TabMeta;
const content={text:"disk",lossless:true,encoding:"UTF-8",hasBom:false,eol:"LF",mtimeMs:5,lines:1,readOnly:false,readOnlyReason:null};
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
let api:ReturnType<typeof useFileSave>,root:Root,host:HTMLDivElement;
function Harness(){api=useFileSave(path);return <span>{api.saving?"保存中":"空闲"}</span>;}
beforeEach(()=>{vi.clearAllMocks();h.model.getAlternativeVersionId.mockReturnValue(1);clearCompletedOperations();setSession({root:"C:\\w",tabs:[{...tab}]});h.saveOne.mockResolvedValue({mtimeMs:2,encoding:"UTF-8",hasBom:false,converted:false});h.readFile.mockResolvedValue(content);host=document.createElement("div");document.body.append(host);root=createRoot(host);act(()=>root.render(<Harness/>));});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe("保存与重新加载并发",()=>{
  it("格式化阶段即加锁，只保存一次并读取格式化后的最新元数据",async()=>{
    const wait=deferred<void>(),prepare=vi.fn(()=>wait.promise);let job!:Promise<void>;
    act(()=>{job=api.saveFile(path,false,undefined,prepare);void api.saveFile(path,false,undefined,prepare);});
    await act(async()=>{await Promise.resolve();});expect(prepare).toHaveBeenCalledOnce();expect(host.textContent).toBe("保存中");expect(h.saveOne).not.toHaveBeenCalled();
    await act(async()=>{setSession({tabs:[{...tab,mtimeMs:7}]});wait.resolve();await job;});expect(h.saveOne).toHaveBeenCalledOnce();expect(h.saveOne.mock.calls[0][0].mtimeMs).toBe(7);expect(host.textContent).toBe("空闲");
  });
  it("格式化未完成仍保存，结果说明原因",async()=>{
    await act(async()=>{await api.saveFile(path,false,undefined,async()=>"failed");});expect(h.saveOne).toHaveBeenCalledOnce();expect(getOperations()[0].detail).toContain("格式化未完成");
  });
  it("格式化期间切走再切回同一工程也不能旧请求写入",async()=>{
    const wait=deferred<void>();let job!:Promise<void>;act(()=>{job=api.saveFile(path,false,undefined,()=>wait.promise);});
    await act(async()=>{invalidateWorkspaceRequests();wait.resolve();await job;});expect(h.saveOne).not.toHaveBeenCalled();expect(getOperations()[0].state).toBe("cancelled");
  });
  it("同路径重新加载只执行一次，期间新增编辑保留并报错",async()=>{
    const wait=deferred<typeof content>();h.readFile.mockReturnValue(wait.promise);let job!:Promise<void>;
    act(()=>{job=api.reloadFile(path);void api.reloadFile(path);});await act(async()=>{await Promise.resolve();});expect(h.readFile).toHaveBeenCalledOnce();
    await act(async()=>{h.model.getAlternativeVersionId.mockReturnValue(2);wait.resolve(content);await job;});expect(h.replaceContent).not.toHaveBeenCalled();expect(getOperations()[0].state).toBe("failed");expect(h.toast.mock.calls[0][0]).toContain("新编辑");
  });
  it("重载期间不能覆盖保存；成功重载更新全部元数据",async()=>{
    const wait=deferred<typeof content>();h.readFile.mockReturnValue(wait.promise);let job!:Promise<void>;
    act(()=>{job=api.reloadFile(path);void api.saveFile(path);});await act(async()=>{wait.resolve(content);await job;});expect(h.saveOne).not.toHaveBeenCalled();expect(h.replaceContent).toHaveBeenCalledOnce();expect(getSession().tabs[0].mtimeMs).toBe(5);
  });
});
