// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchFrame } from "./WorkbenchFrame";
import { DockRegion, useWorkbenchDock } from "./WorkbenchDock";
import { ActivityPanel } from "../ui/ActivityPanel";
import { getSideOpen, setSideOpen } from "../../lib/layoutStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
/** 模拟底部面板：把自己登记成「bottom」停靠区的宿主（真实场景由 BottomPanel 做）。 */
function FakePanel() {
  const dock = useWorkbenchDock();
  return <div className="svc-host" ref={dock?.bindHost("bottom")}>Compiler</div>;
}
afterEach(() => { dispose(); vi.unstubAllGlobals(); });

describe("workbench docking", () => {
  it("窄窗口侧栏可以通过关闭按钮、正文遮罩和 Escape 收起，关闭后归还焦点", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const wasOpen = getSideOpen();
    setSideOpen(true);
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    dispose = () => { act(() => root.unmount()); host.remove(); setSideOpen(wasOpen); };
    await act(async () => root.render(<><button aria-label="工作台布局">Layout</button>
      <WorkbenchFrame activeTool="settings" tree={null} tabs={null} editor={null} output={null} status={null} /></>));
    const close = host.querySelector<HTMLButtonElement>('[aria-label="关闭设置分类"]')!;
    await act(async () => { close.focus(); close.click(); });
    expect(getSideOpen()).toBe(false);
    expect(document.activeElement).toBe(host.querySelector('[aria-label="工作台布局"]'));
    await act(async () => setSideOpen(true));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="收起侧栏"]')!.click());
    expect(getSideOpen()).toBe(false);
    await act(async () => setSideOpen(true));
    await act(async () => close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(getSideOpen()).toBe(false);
  });
  it("关闭按需日志标签回到代码，保留编辑节点和草稿", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => { callback(0); return 0; };
    let requested: string | null = null;
    const render = (active: string) => root.render(<WorkbenchFrame activeTool={active} tree={null}
      tabs={<div role="tab" tabIndex={0} aria-selected={active === "files"}>Source.java</div>}
      editor={<textarea defaultValue="code draft" />} output={null} status={null} />);
    const navigate = (event: Event) => { requested = (event as CustomEvent<string>).detail; render(requested); };
    window.addEventListener("ncforge-navigate", navigate);
    dispose = () => { act(() => root.unmount()); host.remove(); window.removeEventListener("ncforge-navigate", navigate); globalThis.requestAnimationFrame = originalRaf; };
    await act(async () => render("files"));
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.value = "unsaved source";
    await act(async () => render("logs"));
    expect(host.querySelector<HTMLElement>(".wb-code-surface")?.hidden).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭日志排查"]')!.click());
    expect(requested).toBe("files");
    expect(host.querySelector('[aria-label="关闭日志排查"]')).toBeNull();
    expect(host.querySelector<HTMLElement>(".wb-code-surface")?.hidden).toBe(false);
    expect(host.querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("unsaved source");
  });
  it("keeps visited tool inputs but hides their portals when another tool is active", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    dispose = () => { act(() => root.unmount()); host.remove(); };
    const render = (active: string) => act(async () => root.render(<WorkbenchFrame activeTool={active} tree={null} tabs={null} editor={<div>Code</div>} output={null} status={null}
      tool={<><ActivityPanel active={active === "db"}><DockRegion region="document"><input aria-label="SQL draft" defaultValue="SELECT 1" /></DockRegion></ActivityPanel><ActivityPanel active={active === "patch"}><DockRegion region="document"><div>Package</div></DockRegion></ActivityPanel></>} />));
    await render("db");
    const input = host.querySelector("input")!;
    input.value = "SELECT 2";
    await render("patch");
    expect(input.closest<HTMLElement>(".wb-dock-region")?.hidden).toBe(true);
    await render("db");
    expect(host.querySelector("input")).toBe(input);
    expect(input.value).toBe("SELECT 2");
    expect(input.closest<HTMLElement>(".wb-dock-region")?.hidden).toBe(false);
  });
  it("places tools into dedicated regions and preserves the editor DOM when switching", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    dispose = () => { act(() => root.unmount()); host.remove(); };
    const render = (activeTool: string) => act(async () => root.render(<WorkbenchFrame activeTool={activeTool}
      tree={<div>File tree</div>} tabs={<span>Source tabs</span>} editor={<textarea aria-label="Source" defaultValue="draft" />}
      output={<FakePanel />} status={<div>Status</div>}
      tool={<><DockRegion region="toolbar"><h1>Tool header</h1></DockRegion><DockRegion region="sidebar"><div>Changes</div></DockRegion><DockRegion region="document"><div>Diff</div></DockRegion><DockRegion region="bottom"><div>Logs</div></DockRegion></>} />));
    await render("svn");
    const editor = host.querySelector("textarea");
    expect(host.querySelector(".wb-sidebar-host")?.textContent).toBe("Changes");
    expect(host.querySelector(".wb-toolbar-host")?.textContent).toBe("Tool header");
    // 文件标签条属于代码面（宿主类名 `.wb-code-tools`）：切到工具页后它随代码面一起收起，
    // 工具标签独占文档面的标签条，两套标签在 DOM 上就不在同一个容器里。
    expect(host.querySelector<HTMLElement>(".wb-code-tools")?.closest<HTMLElement>(".wb-code-surface")?.hidden).toBe(true);
    expect(host.querySelector(".wb-doc-tabs .wb-tabs")?.textContent).toBe("版本控制");
    await act(async () => (host.querySelector(".wb-tool-tab") as HTMLElement).click());
    expect((host.querySelector(".wb-code-surface") as HTMLElement).hidden).toBe(true);
    expect(host.querySelector("textarea")).toBe(editor);
    // 返回代码页，文档槽让位，编辑器回到主位。
    await render("files");
    expect((host.querySelector(".wb-code-surface") as HTMLElement).hidden).toBe(false);
    expect(host.querySelector(".svc-host")?.textContent).toContain("Logs");
    expect(host.querySelector("textarea")).toBe(editor);
    expect(editor?.value).toBe("draft");
  });
  it("数据库标签停在文档面标签条里，与代码面的文件标签不同容器", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    dispose = () => { act(() => root.unmount()); host.remove(); };
    const render = (active: string) => act(async () => root.render(<WorkbenchFrame activeTool={active}
      tree={null} tabs={<div role="tab">Source.java</div>} editor={<div>Code</div>} output={null} status={null}
      tool={<ActivityPanel active={active === "db"}>
        <DockRegion region="doctabs"><div role="tab" className="db-tab">查询 1</div></DockRegion>
        <DockRegion region="document"><div>SELECT 1</div></DockRegion>
      </ActivityPanel>} />));
    await render("db");
    const dbTab = host.querySelector(".db-tab")!;
    const dbStrip = host.querySelector(".wb-doc-tabs")!;
    const fileStrip = host.querySelector(".wb-code-tools")!;
    // 数据库标签只出现在文档面自己的标签条里；文件标签条随代码面一起收起。
    expect(dbTab.closest(".wb-doc-tabs")).toBe(dbStrip);
    expect(dbStrip.textContent).toContain("查询 1");
    expect(fileStrip.textContent).toContain("Source.java");
    expect(dbStrip.contains(fileStrip)).toBe(false);
    expect(host.querySelector<HTMLElement>(".wb-code-surface")?.hidden).toBe(true);
    // 回到代码页：文件标签条回到主位，数据库标签条随文档面一起收起。
    await render("files");
    expect(host.querySelector<HTMLElement>(".wb-code-surface")?.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>(".wb-document-surface")?.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>(".db-tab")?.closest<HTMLElement>(".wb-dock-region")?.hidden).toBe(true);
  });
  it("每个工具页在文档面标签条里渲染自己的标签，数据库由自己的多文档标签条接管", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    dispose = () => { act(() => root.unmount()); host.remove(); };
    const render = (active: string) => act(async () => root.render(<WorkbenchFrame activeTool={active}
      tree={null} tabs={<div role="tab">Source.java</div>} editor={<div>Code</div>} output={null} status={null} />));
    for (const [tool, label] of [["svn", "版本控制"], ["meta", "元数据"], ["logs", "日志排查"], ["settings", "设置"]] as const) {
      await render(tool);
      const strip = host.querySelector(".wb-doc-tabs")!;
      // 一条标签条里只有这个工具自己的一枚标签，名字与页名一致
      expect(strip.querySelectorAll(".wb-tool-tab")).toHaveLength(1);
      expect(strip.querySelector(".wb-tool-tab .wb-tab-name")?.textContent).toBe(label);
      // 文件标签条随代码面一起收起，不与工具标签同屏
      expect(host.querySelector<HTMLElement>(".wb-code-surface")?.hidden).toBe(true);
    }
    // 数据库是多文档工具：ToolTab 让位，不额外塞一个「数据库」标签，
    // 标签条由 DbDocTabs 停靠进同一个 doctabs 区（见 DbDocTabs.test）。
    await render("db");
    expect(host.querySelector(".wb-doc-tabs .wb-tool-tab")).toBeNull();
    expect(host.querySelector<HTMLElement>(".wb-code-surface")?.hidden).toBe(true);
  });
  it("导航到日志时直接停靠文档，隐藏资源树但保留代码和日志状态", async () => {
    const wasOpen = getSideOpen();
    setSideOpen(true);
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    dispose = () => { act(() => root.unmount()); host.remove(); setSideOpen(wasOpen); };
    const render = (activeTool: string) => act(async () => root.render(<WorkbenchFrame activeTool={activeTool}
      tree={<div>File tree</div>} tabs={null} editor={<textarea aria-label="Code draft" defaultValue="edited code" />}
      output={null} status={<div>Status</div>}
      tool={<ActivityPanel active={activeTool === "logs"}><DockRegion region="document"><input aria-label="Log filter" defaultValue="callid" /></DockRegion></ActivityPanel>} />));
    await render("files");
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.value = "unsaved source";
    await render("logs");
    const filter = host.querySelector<HTMLInputElement>('[aria-label="Log filter"]')!;
    filter.value = "SQL exception";
    expect(filter.closest(".wb-document-surface")).not.toBeNull();
    expect(host.querySelectorAll("[data-page-panel]")).toHaveLength(1);
    expect(host.querySelector("[data-page-panel]")?.classList.contains("wb-content-frame")).toBe(true);
    expect(host.querySelector<HTMLElement>(".wb-code-surface")?.hidden).toBe(true);
    expect(host.querySelector(".wb-layout")?.getAttribute("data-side-open")).toBe("false");
    expect(host.querySelector<HTMLElement>(".wb-resize-x")?.tabIndex).toBe(-1);
    expect(getSideOpen()).toBe(true);
    await render("files");
    expect(host.querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("unsaved source");
    expect(host.querySelector(".wb-layout")?.getAttribute("data-side-open")).toBe("true");
    await render("logs");
    expect(host.querySelector('[aria-label="Log filter"]')).toBe(filter);
    expect(filter.value).toBe("SQL exception");
  });
});
