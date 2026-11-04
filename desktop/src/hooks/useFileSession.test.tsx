// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileSession } from "./useFileSession";
import { getSession, setSession } from "../lib/workspaceSession";
import { clearCompletedOperations } from "../lib/operations";
import { invalidateWorkspaceRequests } from "../lib/workspaceEpoch";
const h=vi.hoisted(()=>({readFile:vi.fn(),openModel:vi.fn(),closeModel:vi.fn()}));
vi.mock("../lib/editorStore",()=>({openModel:h.openModel,closeModel:h.closeModel,renameModel:vi.fn()}));
vi.mock("../lib/tauri",()=>({invoke:vi.fn(async()=>[])}));
vi.mock("./useFileSave",()=>({useFileSave:()=>({saving:false,saveFile:vi.fn(),saveAsUtf8:vi.fn(),reloadFile:vi.fn()})}));
vi.mock("./useJdtOpen",()=>({useJdtOpen:()=>vi.fn(async()=>true)}));
vi.mock("./useSplitView",()=>({useSplitView:()=>({splitPath:null,setSplitPath:vi.fn(),openSplit:vi.fn(),closeSplit:vi.fn()})}));
vi.mock("../components/ui/toast",()=>({toast:vi.fn()}));
vi.mock("../lib/workspace",async()=>{const orig=await vi.importActual<typeof import("../lib/workspace")>("../lib/workspace");return {...orig,readFile:h.readFile,encodingMarks:async()=>[]};});
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const a="C:\\w\\A.java",b="C:\\w\\B.java",content={text:"class A {}",lossless:true,encoding:"UTF-8",hasBom:false,eol:"LF",mtimeMs:1};
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
let api:ReturnType<typeof useFileSession>,root:Root,host:HTMLDivElement;
function Harness(){api=useFileSession();return null;}
beforeEach(()=>{vi.clearAllMocks();clearCompletedOperations();setSession({root:"C:\\w",tabs:[],activePath:null});host=document.createElement("div");document.body.append(host);root=createRoot(host);act(()=>root.render(<Harness/>));});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe("文件读取并发",()=>{
  it("同文件连点大小写路径共用读取，只建一个标签",async()=>{
    const wait=deferred<typeof content>();h.readFile.mockReturnValue(wait.promise);let first!:Promise<boolean>,second!:Promise<boolean>;
    act(()=>{first=api.openFile(a);second=api.openFile(a.toLowerCase());});await act(async()=>{wait.resolve(content);await Promise.all([first,second]);});
    expect(h.readFile).toHaveBeenCalledOnce();expect(getSession().tabs).toHaveLength(1);expect(getSession().activePath).toBe(getSession().tabs[0].path);
  });
  it("慢旧预览不能覆盖最后点击的预览",async()=>{
    const wait=deferred<typeof content>();h.readFile.mockImplementation((p:string)=>p===a?wait.promise:Promise.resolve(content));let first!:Promise<boolean>;
    act(()=>{first=api.openFile(a,{preview:true});});await act(async()=>{await api.openFile(b,{preview:true});wait.resolve(content);await first;});
    expect(getSession().tabs.map(t=>t.path)).toEqual([b]);expect(getSession().activePath).toBe(b);expect(h.openModel).toHaveBeenCalledOnce();
  });
  it("旧工程慢结果不落模型，即使又回到同一个目录",async()=>{
    const wait=deferred<typeof content>();h.readFile.mockReturnValue(wait.promise);let first!:Promise<boolean>;
    act(()=>{first=api.openFile(a);});await act(async()=>{invalidateWorkspaceRequests();wait.resolve(content);await first;});expect(h.openModel).not.toHaveBeenCalled();expect(getSession().tabs).toHaveLength(0);
  });
});
