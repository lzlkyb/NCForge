// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileSession } from "./useFileSession";
import { getSession, setSession } from "../lib/workspaceSession";
import { clearCompletedOperations } from "../lib/operations";
import { setCursor } from "../lib/cursorStore";
import { resetNav } from "../lib/navHistory";
import { invalidateWorkspaceRequests } from "../lib/workspaceEpoch";
import { emptyEditorGroups, selectGroupFile } from "../lib/editorGroups";
import { tabMetaFromDisk } from "../lib/tabSession";
import { EditorGroupsPane } from "../components/workspace/EditorGroupsPane";
import { useTabSessionKeys } from "./useTabSession";
vi.mock("../components/workspace/EditorPane", () => ({ EditorPane: () => null }));
vi.mock("../components/workspace/EmptyEditor", () => ({ EmptyEditor: () => null }));
// 阅读组件另有测试；会话并发测试不应初始化真实 Monaco 或剪贴板贡献。
vi.mock("../components/workspace/Breadcrumb", () => ({ Breadcrumb: () => null }));
vi.mock("../components/workspace/EditorNavRow", () => ({ EditorNavRow: () => null }));
vi.mock("../components/workspace/TabStrip", () => ({ TabStrip: ({ tabs, groupId, onSelect }: { tabs: { path: string }[]; groupId: string; onSelect: (path: string) => void }) => <div data-tab-group={groupId}>{tabs.map(tab => <button key={tab.path} data-path={tab.path} onClick={() => onSelect(tab.path)}>{tab.path}</button>)}</div> }));
const h=vi.hoisted(()=>({readFile:vi.fn(),openModel:vi.fn(),closeModel:vi.fn()}));
vi.mock("../lib/editorStore",()=>({openModel:h.openModel,closeModel:h.closeModel,renameModel:vi.fn(),getModel:()=>undefined}));
vi.mock("../lib/symbols",()=>({chainAt:()=>[]}));
vi.mock("../lib/tauri",()=>({invoke:vi.fn(async()=>[])}));
vi.mock("./useFileSave",()=>({useFileSave:()=>({saving:false,saveFile:vi.fn(),saveAsUtf8:vi.fn(),reloadFile:vi.fn()})}));
vi.mock("./useJdtOpen",()=>({useJdtOpen:()=>vi.fn(async()=>true)}));
vi.mock("./useSplitView",()=>({useSplitView:()=>({splitPath:null,setSplitPath:vi.fn(),openSplit:vi.fn(),closeSplit:vi.fn()})}));
vi.mock("../components/ui/toast",()=>({toast:vi.fn()}));
vi.mock("../lib/workspace",async()=>{const orig=await vi.importActual<typeof import("../lib/workspace")>("../lib/workspace");return {...orig,readFile:h.readFile,encodingMarks:async()=>[]};});
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const a="C:\\w\\A.java",b="C:\\w\\B.java",content={text:"class A {}",lossless:true,encoding:"UTF-8",hasBom:false,eol:"LF",mtimeMs:1,size:10};
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
let api:ReturnType<typeof useFileSession>,root:Root,host:HTMLDivElement;
function Harness({ groups = false }: { groups?: boolean }){api=useFileSession();useTabSessionKeys(getSession().tabs, getSession().activePath, api);return groups ? <EditorGroupsPane root="C:\\w" tabs={getSession().tabs} session={api} reveal={api.reveal} /> : null;}
beforeEach(()=>{vi.clearAllMocks();resetNav();clearCompletedOperations();setSession({root:"C:\\w",tabs:[],activePath:null});host=document.createElement("div");document.body.append(host);root=createRoot(host);act(()=>root.render(<Harness/>));});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe("文件读取并发",()=>{
  it("问题跳转的正斜杠路径复用树中反斜杠标签及未保存模型", async () => {
    h.readFile.mockResolvedValue(content); await act(async () => api.openFile(b));
    act(() => setSession({ tabs: tabs => tabs.map(tab => ({ ...tab, dirty: true })) }));
    await act(async () => api.openAt("c:/w/B.java", 4));
    expect(getSession().tabs).toHaveLength(1); expect(getSession().activePath).toBe(b);
    expect(getSession().tabs[0].dirty).toBe(true); expect(h.openModel).toHaveBeenCalledOnce(); expect(h.readFile).toHaveBeenCalledOnce();
    expect(api.reveal).toMatchObject({ line: 4 });
  });
  it("关闭当前文件命令只关焦点组共享视图，未保存模型仍留在另一组", async () => {
    h.readFile.mockResolvedValue(content); await act(async () => api.openFile(a)); await act(async () => api.openFile(b));
    act(() => setSession({ tabs: tabs => tabs.map(tab => tab.path === a ? { ...tab, dirty: true } : tab), editorGroups: old => selectGroupFile(old!, "right", a) }));
    act(() => api.closeTab(a));
    expect(getSession().editorGroups?.right).toEqual([]); expect(getSession().tabs).toHaveLength(2);
    expect(getSession().closingPath).toBeNull(); expect(h.closeModel).not.toHaveBeenCalledWith(a);
  });
  it("慢文件读取时点击同组已有标签，旧回包不能抢回活动文件或定位", async () => {
    h.readFile.mockResolvedValue(content); await act(async () => api.openFile(b));
    act(() => root.render(<Harness groups />));
    const wait = deferred<typeof content>(); h.readFile.mockReturnValue(wait.promise); let pending!: Promise<boolean>;
    act(() => { pending = api.openAt(a, 22); });
    act(() => host.querySelector<HTMLButtonElement>('[data-tab-group="left"] button')!.click());
    await act(async () => { wait.resolve(content); await pending; });
    expect(getSession().activePath).toBe(b); expect(getSession().editorGroups?.left).toContain(a); expect(api.reveal).toBeNull();
  });
  it("慢文件读取期间通过 Ctrl+Tab 切到同组最近文件，旧响应不能抢焦点", async () => {
    h.readFile.mockResolvedValue(content); await act(async () => api.openFile(b)); await act(async () => api.openFile("C:\\w\\C.java"));
    const wait = deferred<typeof content>(); h.readFile.mockReturnValue(wait.promise); let pending!: Promise<boolean>;
    act(() => { pending = api.openAt(a, 22); });
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true, cancelable: true })));
    await act(async () => { wait.resolve(content); await pending; });
    expect(getSession().activePath).toBe(b); expect(api.reveal).toBeNull();
  });
  it("左组慢读取回包仍归左组，不抢走右组焦点或定位", async () => {
    h.readFile.mockResolvedValue(content); await act(async () => api.openFile(b));
    const wait = deferred<typeof content>(); h.readFile.mockReturnValue(wait.promise); let pending!: Promise<boolean>;
    act(() => { pending = api.openAt(a, 12); });
    act(() => setSession({ editorGroups: old => selectGroupFile(old ?? emptyEditorGroups(), "right", b) }));
    await act(async () => { wait.resolve(content); await pending; });
    expect(getSession()).toMatchObject({ activePath: b, editorGroups: { focused: "right", right: [b] } });
    expect(getSession().editorGroups?.left).toContain(a); expect(api.reveal).toBeNull();
  });
  it("另一组再次预览打开已有预览文件时保留共享模型，不被后续预览替换", async () => {
    h.readFile.mockResolvedValue(content); await act(async () => api.openFile(a, { preview: true }));
    act(() => setSession({ tabs: tabs => [...tabs, tabMetaFromDisk(b, { ...content, encoding: "UTF-8", eol: "LF" })], editorGroups: old => selectGroupFile(old!, "right", b) }));
    await act(async () => api.openFile(a, { preview: true }));
    await act(async () => api.openFile("C:\\w\\C.java", { preview: true }));
    expect(getSession().tabs.find(tab => tab.path === a)?.preview).toBe(false);
    expect(getSession().editorGroups?.left).toContain(a); expect(h.closeModel).not.toHaveBeenCalledWith(a);
  });
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


it("跨文件跳转先记录原光标，从列表返回后仍可前进", async () => {
  h.readFile.mockResolvedValue(content);
  await act(async () => api.openAt(a, 10));
  setCursor(14, 4);
  await act(async () => api.openAt(b, 20));
  await act(async () => api.goToHistory(1));
  expect(getSession().activePath).toBe(a);
  expect(api.reveal).toMatchObject({ line: 14, column: 4 });
  await act(async () => api.goForward());
  expect(getSession().activePath).toBe(b);
  expect(api.reveal?.line).toBe(20);
});
