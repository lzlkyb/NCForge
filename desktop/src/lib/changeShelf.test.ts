import{beforeEach,describe,expect,it,vi}from"vitest";
const h=vi.hoisted(()=>({epoch:1,read:vi.fn(),diff:vi.fn(),invoke:vi.fn(),apply:vi.fn(),model:{getValue:()=>"class Current {}",getVersionId:()=>4}}));
vi.mock("./tauri",()=>({invoke:h.invoke}));vi.mock("./editorStore",()=>({findModel:()=>h.model}));vi.mock("./workspaceSession",()=>({getSession:()=>({tabs:[]})}));vi.mock("./workspace",()=>({readFile:h.read}));vi.mock("./workspaceEpoch",()=>({workspaceEpoch:()=>h.epoch}));vi.mock("./refactorWorkbench",()=>({applyWorkbenchPlan:h.apply}));vi.mock("./svn",()=>({svnDiff:h.diff}));
import{prepareShelve,shelveChanges,saveChangeShelf,prepareShelfRestore,restoreChangeShelf}from"./changeShelf";
beforeEach(()=>{h.epoch=1;h.read.mockReset();h.diff.mockReset();h.invoke.mockReset();h.apply.mockReset();h.read.mockResolvedValue({text:"class Disk {}",mtimeMs:8,lossless:true,encoding:"GBK",eol:"CRLF",hasBom:false});h.diff.mockResolvedValue({baseEmpty:false,editable:true,workingText:"class Disk {}",baseText:"class Base {}"});h.invoke.mockResolvedValue({id:"copy",name:"需求",files:1});h.apply.mockResolvedValue(undefined);});
describe("durable shelving of tracked file changes",()=>{
  it("backs up the unsaved buffer of a missing file before restoring its older copy",async()=>{
    h.invoke.mockImplementation(async(command:string)=>command==="change_shelf_plan"?[{path:"D:/w/A.java",beforeText:"",expectedText:"",expectedMtimeMs:null,text:"class Older {}",delete:false,encoding:"UTF-8",hasBom:false,eol:"LF"}]:{id:"recovery",name:"恢复前",files:1});
    const shelf={id:"older",name:"旧副本",created:1,files:1},plan=await prepareShelfRestore(shelf);const calls:string[]=[];
    h.invoke.mockImplementation(async()=>{calls.push("backup");return{id:"recovery"};});h.apply.mockImplementation(async()=>{calls.push("apply");});
    await restoreChangeShelf(shelf,plan);
    expect(calls).toEqual(["backup","apply"]);expect(h.invoke.mock.calls[h.invoke.mock.calls.length-1]).toEqual(["change_shelf_create",{name:"恢复前：旧副本",files:[expect.objectContaining({path:"D:/w/A.java",expectedMtimeMs:null,expectedText:"",text:"class Current {}",delete:false})]}]);
    expect(h.read).not.toHaveBeenCalled();
  });
  it("keeps the newer missing-file buffer when its recovery copy cannot be saved",async()=>{
    h.invoke.mockResolvedValue([{path:"D:/w/A.java",beforeText:"",expectedText:"",expectedMtimeMs:null,text:"class Older {}",delete:false,encoding:"UTF-8",hasBom:false,eol:"LF"}]);
    const shelf={id:"older",name:"旧副本",created:1,files:1},plan=await prepareShelfRestore(shelf);
    h.invoke.mockRejectedValue(new Error("副本预算已满"));await expect(restoreChangeShelf(shelf,plan)).rejects.toThrow("副本预算");expect(h.apply).not.toHaveBeenCalled();
  });
  it("previews current editor content against SVN BASE while keeping disk guards",async()=>{const plan=await prepareShelve(["D:/w/A.java"]);expect(plan.files[0]).toMatchObject({beforeText:"class Current {}",expectedText:"class Disk {}",expectedMtimeMs:8,text:"class Base {}",modelVersion:4,encoding:"GBK",eol:"CRLF"});});
  it("saves the named content copy before removing working changes",async()=>{const calls:string[]=[];h.invoke.mockImplementation(async()=>{calls.push("copy");return{id:"copy"};});h.apply.mockImplementation(async()=>{calls.push("apply");});await shelveChanges("需求",await prepareShelve(["D:/w/A.java"]));expect(calls).toEqual(["copy","apply"]);expect(h.invoke.mock.calls[0][1].files[0].text).toBe("class Current {}");});
  it("does not remove changes when durable copy creation fails",async()=>{h.invoke.mockRejectedValue(new Error("budget"));await expect(shelveChanges("需求",await prepareShelve(["D:/w/A.java"]))).rejects.toThrow("budget");expect(h.apply).not.toHaveBeenCalled();});
  it("rejects missing BASE and stale disk input",async()=>{h.diff.mockResolvedValue({baseEmpty:true,editable:true});await expect(prepareShelve(["D:/w/A.java"])).rejects.toThrow("SVN 基线");h.diff.mockResolvedValue({baseEmpty:false,editable:true,workingText:"class External {}"});await expect(prepareShelve(["D:/w/A.java"])).rejects.toThrow("内容或格式已变化");});
  it("rejects a workspace switch before creating the copy",async()=>{h.read.mockImplementation(async()=>{h.epoch++;return{text:"x",lossless:true,eol:"LF"};});await expect(saveChangeShelf("需求",["D:/w/A.java"])).rejects.toThrow("工程已切换");expect(h.invoke).not.toHaveBeenCalled();});
});
