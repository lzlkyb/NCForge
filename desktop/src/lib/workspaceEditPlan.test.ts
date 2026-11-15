import {describe,expect,it} from "vitest";
import {parseWorkspaceEdit,plannedText} from "./workspaceEditPlan";
const range={start:{line:0,character:6},end:{line:0,character:7}};
describe("semantic workspace edit plans",()=>{
  it("preserves a class file rename and coalesces old/new URI edits",()=>{
    const plan=parseWorkspaceEdit({edit:{documentChanges:[{kind:"rename",oldUri:"file:///D:/w/A.java",newUri:"file:///D:/w/B.java"},{textDocument:{uri:"file:///D:/w/B.java"},edits:[{range,newText:"B"}]}]},before:[{uri:"file:///D:/w/A.java",text:"class A {}\r\n"}]});
    expect(plan.groups).toHaveLength(1);expect(plan.groups[0].path).toBe("D:\\w\\A.java");expect(plan.resources[0].destination).toBe("D:\\w\\B.java");
    expect(plannedText("class A {}\r\n",plan.groups[0])).toBe("class B {}\n");
    expect(plan.before.get("d:/w/a.java")).toBe("class A {}\n");
  });
  it("does not discard file creation or deletion without text edits",()=>{
    const plan=parseWorkspaceEdit({edit:{documentChanges:[{kind:"create",uri:"file:///D:/w/New.java"},{kind:"delete",uri:"file:///D:/w/Old.java"}]}});
    expect(plan.groups.map(g=>g.edits)).toEqual([[],[]]);expect(plan.resources.map(r=>r.kind)).toEqual(["create","delete"]);
  });
  it("rejects binary or unknown resource operations instead of applying a subset",()=>{
    expect(()=>parseWorkspaceEdit({edit:{changes:{"jdt://contents/Lib.class":[]}}})).toThrow("不可写目标");
    expect(()=>parseWorkspaceEdit({edit:{documentChanges:[{kind:"copy",uri:"file:///D:/w/A.java"}]}})).toThrow("不支持的文件操作");
  });
  it("rejects overlapping and stale coordinates",()=>{
    expect(()=>plannedText("class A {}",{path:"A",edits:[{range,newText:"B"},{range,newText:"C"}]})).toThrow("重叠");
    expect(()=>plannedText("short",{path:"A",edits:[{range,newText:"B"}]})).toThrow("越界");
  });
});
