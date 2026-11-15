// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from "vitest";
import type {FilePlan,WorkbenchPlan} from "./refactorWorkbench";
interface FakeModel{text:string;version:number;getValue():string;getVersionId():number;isDisposed():boolean;pushEditOperations(_cursor:unknown,edits:{text:string}[]):void;getFullModelRange():object;}
const h=vi.hoisted(()=>({epoch:1,models:new Map<string,FakeModel>(),disk:new Map<string,string>(),session:{tabs:[]as{path:string;name:string;dirty:boolean;mtimeMs:number;eolChanged:boolean}[],activePath:"D:\\w\\A.java"as string|null,splitPath:"D:\\w\\A.java"as string|null,editorGroups:{left:["D:\\w\\A.java"],right:["D:\\w\\A.java"],leftActive:"D:\\w\\A.java",rightActive:"D:\\w\\A.java",recent:["D:\\w\\A.java"],focused:"left",ratio:.5}},invoke:vi.fn(),history:vi.fn(),markSaved:vi.fn(),toast:vi.fn()}));
vi.mock("./editorActions",()=>({currentSelection:vi.fn()}));
vi.mock("./editorStore",()=>({findModel:(p:string)=>h.models.get(p),pathOfModel:vi.fn(),markSaved:h.markSaved,renameModel:(from:string,to:string)=>{const m=h.models.get(from);if(m){h.models.delete(from);h.models.set(to,m);}},closeModel:(p:string)=>h.models.delete(p)}));
vi.mock("./lang",()=>({flushDoc:vi.fn(),langRequest:vi.fn(),langReady:()=>true}));
vi.mock("./workspaceEpoch",()=>({workspaceEpoch:()=>h.epoch}));
vi.mock("./workspaceSession",()=>({getSession:()=>h.session,setSession:(patch:Record<string,unknown>)=>{for(const[k,v]of Object.entries(patch))Object.assign(h.session,{[k]:typeof v==="function"?v((h.session as Record<string,unknown>)[k]):v});}}));
vi.mock("./workspace",()=>({readFile:async(p:string)=>({text:h.disk.get(p)??"",mtimeMs:2,encoding:"GBK",hasBom:false,eol:"CRLF",lossless:true,size:10}),baseName:(p:string)=>p.split(/[/\\]/).pop()}));
vi.mock("./tauri",()=>({invoke:h.invoke}));vi.mock("./localHistory",()=>({captureLocalHistory:h.history}));vi.mock("../components/ui/toast",()=>({toast:h.toast}));
import {applyWorkbenchPlan,prepareWorkbenchPlan} from "./refactorWorkbench";
const oldPath="D:\\w\\A.java",newPath="D:\\w\\pkg\\B.java";
function model(text="class A {}",version=1):FakeModel{return{text,version,getValue(){return this.text;},getVersionId(){return this.version;},isDisposed(){return false;},getFullModelRange(){return{};},pushEditOperations(_cursor,edits){this.text=edits[0].text;this.version++;}};}
function plan(destination?:string):WorkbenchPlan{const file:FilePlan={path:oldPath,beforeText:"class A {}",expectedText:"class A {}",expectedMtimeMs:1,text:"class B {}",destination,delete:false,encoding:"GBK",hasBom:false,eol:"CRLF",modelVersion:1};return{files:[file],warnings:[],epoch:1,label:"重命名"};}
beforeEach(()=>{h.epoch=1;h.models.clear();h.models.set(oldPath,model());h.disk.clear();h.disk.set(oldPath,"class B {}");h.disk.set(newPath,"class B {}");h.session.tabs=[{path:oldPath,name:"A.java",dirty:true,mtimeMs:1,eolChanged:false}];Object.assign(h.session,{activePath:oldPath,splitPath:oldPath,editorGroups:{left:[oldPath],right:[oldPath],leftActive:oldPath,rightActive:oldPath,recent:[oldPath],focused:"left",ratio:.5}});h.invoke.mockReset();h.history.mockReset();h.markSaved.mockReset();h.toast.mockReset();h.history.mockResolvedValue(undefined);h.invoke.mockResolvedValue({written:[newPath],renamed:[[oldPath,newPath]],deleted:[]});});
describe("refactor transaction buffer protection",()=>{
  it("rejects external disk changes even when the server snapshot matches the dirty buffer",async()=>{
    h.models.get(oldPath)!.text="class A { int local; }";h.disk.set(oldPath,"class A { int external; }");
    const context={path:oldPath,line:0,character:0,length:0,epoch:1,modelVersion:1};
    await expect(prepareWorkbenchPlan(context,{edit:{changes:{"file:///D:/w/A.java":[]}},before:[{uri:"file:///D:/w/A.java",text:"class A { int local; }"}]},"test")).rejects.toThrow("外部修改");
    expect(h.invoke).not.toHaveBeenCalled();expect(h.models.get(oldPath)!.text).toContain("local");expect(h.disk.get(oldPath)).toContain("external");
  });
  it("allows unsaved edits when disk still matches the opened file baseline",async()=>{
    h.session.tabs[0].mtimeMs=2;h.disk.set(oldPath,"class A {}");h.models.get(oldPath)!.text="class A { int local; }";
    const context={path:oldPath,line:0,character:0,length:0,epoch:1,modelVersion:1};
    const result=await prepareWorkbenchPlan(context,{edit:{changes:{"file:///D:/w/A.java":[]}},before:[{uri:"file:///D:/w/A.java",text:"class A { int local; }"}]},"test");
    expect(result.files[0]).toMatchObject({beforeText:"class A { int local; }",expectedText:"class A {}",expectedMtimeMs:2});
  });
  it("does not accept a dirty model without a known disk baseline",async()=>{
    h.session.tabs=[];h.disk.set(oldPath,"class A { int external; }");
    const context={path:oldPath,line:0,character:0,length:0,epoch:1,modelVersion:1};
    await expect(prepareWorkbenchPlan(context,{edit:{changes:{"file:///D:/w/A.java":[]}},before:[{uri:"file:///D:/w/A.java",text:"class A {}"}]},"test")).rejects.toThrow("外部修改");
  });
  it("checks models again after asynchronous local-history capture",async()=>{h.history.mockImplementation(async()=>{h.models.get(oldPath)!.version++;});await expect(applyWorkbenchPlan(plan())).rejects.toThrow("编辑器内容已改变");expect(h.invoke).not.toHaveBeenCalled();});
  it("updates both editor groups when a file moves",async()=>{await applyWorkbenchPlan(plan(newPath));expect(h.models.get(newPath)?.text).toBe("class B {}");expect(h.session.editorGroups.left).toEqual([newPath]);expect(h.session.editorGroups.right).toEqual([newPath]);expect(h.session.tabs[0].dirty).toBe(false);expect(h.markSaved).toHaveBeenCalledWith(newPath);});
  it("moves a newer buffer while keeping its edits dirty",async()=>{h.invoke.mockImplementation(async()=>{h.models.get(oldPath)!.text="class A { void newer() {} }";h.models.get(oldPath)!.version++;return{written:[newPath],renamed:[[oldPath,newPath]],deleted:[]};});await applyWorkbenchPlan(plan(newPath));expect(h.models.get(newPath)?.text).toContain("newer");expect(h.session.tabs[0]).toMatchObject({path:newPath,dirty:true});expect(h.markSaved).not.toHaveBeenCalled();});
  it("refuses a cross-file edit whose server input differs from disk",async()=>{h.disk.set("D:\\w\\Other.java","class External {}");const context={path:oldPath,line:0,character:0,length:0,epoch:1,modelVersion:1};await expect(prepareWorkbenchPlan(context,{edit:{changes:{"file:///D:/w/Other.java":[]}},before:[{uri:"file:///D:/w/Other.java",text:"class Other {}"}]},"test")).rejects.toThrow("预览期间文件已改变");});
  it("leaves a recoverable buffer when disk diverges after the transaction",async()=>{h.disk.set(newPath,"class External {}");await applyWorkbenchPlan(plan(newPath));expect(h.models.get(newPath)?.text).toBe("class A {}");expect(h.session.tabs[0]).toMatchObject({dirty:true,mtimeMs:1});expect(h.markSaved).not.toHaveBeenCalled();});
});
