import{beforeEach,describe,expect,it,vi}from"vitest";
const h=vi.hoisted(()=>({diags:[]as{path:string;line:number;severity:string;message:string}[],tabs:[]as{path:string;dirty:boolean;eolChanged:boolean}[],read:vi.fn()}));
vi.mock("./diagStore",()=>({getCodeDiags:()=>h.diags}));vi.mock("./workspaceSession",()=>({getSession:()=>({tabs:h.tabs})}));vi.mock("./workspace",()=>({readFile:h.read}));vi.mock("./svn",()=>({keyOf:(p:string)=>p.replace(/\\/g,"/").toLowerCase()}));
import{checkProjectPreflight,conflictMarkerLines}from"./projectPreflight";
beforeEach(()=>{h.diags=[];h.tabs=[];h.read.mockReset();h.read.mockResolvedValue({text:"class A {}"});});
describe("selected-file submit checks",()=>{
  it("locates unresolved conflict markers without flagging strings",()=>{expect(conflictMarkerLines('String s = "<<<<<<<";\n<<<<<<< ours\n=======\n>>>>>>> theirs')).toEqual([2,3,4]);});
  it("blocks actual selected disk conflict markers",async()=>{h.read.mockResolvedValue({text:"<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs"});await expect(checkProjectPreflight(["D:/w/A.java"])).rejects.toThrow("冲突标记");});
  it("blocks known Java errors only for selected saved files",async()=>{h.diags=[{path:"D:/w/A.java",line:3,severity:"error",message:"missing type"}];await expect(checkProjectPreflight(["d:/w/a.java"])).rejects.toThrow("Java 错误");await expect(checkProjectPreflight(["D:/w/B.java"])).resolves.toBeUndefined();});
  it("uses disk markers when the user explicitly chose a dirty file's disk version",async()=>{h.tabs=[{path:"D:/w/A.java",dirty:true,eolChanged:false}];h.diags=[{path:"D:/w/A.java",line:3,severity:"error",message:"buffer-only error"}];await expect(checkProjectPreflight(["D:/w/A.java"])).resolves.toBeUndefined();expect(h.read).toHaveBeenCalledOnce();});
  it("does not decode binary artifacts",async()=>{await checkProjectPreflight(["D:/w/A.class","D:/w/lib.jar"]);expect(h.read).not.toHaveBeenCalled();});
});
