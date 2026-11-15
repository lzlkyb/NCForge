import{describe,expect,it,vi}from"vitest";
import type { TabMeta } from "./workspaceSession";
import type { FilePlan } from "./refactorWorkbench";
const mocks=vi.hoisted(()=>({tabs:[] as TabMeta[],invoke:vi.fn(),openVirtualModel:vi.fn(),setSession:vi.fn(),apply:vi.fn()}));
vi.mock("./tauri",()=>({invoke:mocks.invoke,listen:vi.fn()}));vi.mock("./workspaceSession",()=>({getSession:()=>({tabs:mocks.tabs}),setSession:mocks.setSession}));vi.mock("./lang",()=>({langRequest:vi.fn(),flushDoc:vi.fn(),langReady:()=>false,inLangModule:()=>false}));vi.mock("./editorStore",()=>({findModel:vi.fn(),openVirtualModel:mocks.openVirtualModel}));vi.mock("./refactorWorkbench",()=>({applyWorkbenchPlan:mocks.apply}));
import{applySourceAttachment,dependencyVersionConflicts,type ClasspathEntry}from"./projectWorkbench";
import { libraryUri, libraryTabMeta } from "./libraryFiles";
import { workspaceEpoch } from "./workspaceEpoch";
const entry=(path:string):ClasspathEntry=>({path,kind:1,exported:false,source:"",javadoc:""});
describe("dependency version candidates",()=>{
  it("reports multiple versions of the same library and does not infer unrelated names",()=>{expect(dependencyVersionConflicts([entry("D:/lib/spring-core-4.3.12.jar"),entry("D:/lib/spring-core-5.1.6.jar"),entry("D:/lib/spring-context-5.1.6.jar")])).toHaveLength(1);});
  it("ignores repeated exact versions and class directories",()=>{expect(dependencyVersionConflicts([entry("a-1.0.jar"),entry("b/a-1.0.jar"),{...entry("a-2.0.jar"),kind:3}])).toEqual([]);});
});
describe("source attachment refresh",()=>{
  it("refreshes the exact already-open library even when language services are unavailable",async()=>{
    const target={source:"D:/NC/one/a.jar",entry:"p/Outer.class",archive:true};
    const other={...target,source:"D:/NC/two/a.jar"};
    const opened={...libraryTabMeta(libraryUri(target),target,{text:"old decompiled",decompiled:true}),preview:true,pinned:true};
    const untouched=libraryTabMeta(libraryUri(other),other,{text:"other library",decompiled:true});
    mocks.tabs=[opened,untouched];mocks.invoke.mockReset();mocks.openVirtualModel.mockReset();mocks.setSession.mockReset();
    mocks.invoke.mockResolvedValue({text:"class Outer {}",decompiled:false,sourceOrigin:"D:/NC/source.jar ! p/Outer.java"});
    await applySourceAttachment({} as FilePlan,workspaceEpoch(),target.source,"D:/NC/source.jar","");
    expect(mocks.apply).toHaveBeenCalled();expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("read_library_file",target);
    expect(mocks.openVirtualModel).toHaveBeenCalledExactlyOnceWith(opened.path,"class Outer {}",{language:"java",replace:true});
    const next=mocks.setSession.mock.calls[0][0].tabs(mocks.tabs);
    expect(next[0]).toMatchObject({virtual:"source",sourceOrigin:"D:/NC/source.jar ! p/Outer.java",preview:true,pinned:true});
    expect(next[1]).toBe(untouched);
  });
});
