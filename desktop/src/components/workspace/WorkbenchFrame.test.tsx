// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchFrame } from "./WorkbenchFrame";
import { DockRegion, useWorkbenchDock } from "./WorkbenchDock";
import { ToolTab } from "./ToolTab";
import { ActivityPanel } from "../ui/ActivityPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
/** 模拟底部面板：把自己登记成「bottom」停靠区的宿主（真实场景由 BottomPanel 做）。 */
function FakePanel() {
  const dock = useWorkbenchDock();
  return <div className="svc-host" ref={dock?.bindHost("bottom")}>Compiler</div>;
}
afterEach(() => dispose());

describe("workbench docking", () => {
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
      tree={<div>File tree</div>} tabs={<><span>Source tabs</span><ToolTab /></>} editor={<textarea aria-label="Source" defaultValue="draft" />}
      output={<FakePanel />} status={<div>Status</div>}
      tool={<><DockRegion region="toolbar"><h1>Tool header</h1></DockRegion><DockRegion region="sidebar"><div>Changes</div></DockRegion><DockRegion region="document"><div>Diff</div></DockRegion><DockRegion region="bottom"><div>Logs</div></DockRegion></>} />));
    await render("svn");
    const editor = host.querySelector("textarea");
    expect(host.querySelector(".wb-sidebar-host")?.textContent).toBe("Changes");
    expect(host.querySelector(".wb-toolbar-host")?.textContent).toBe("Tool header");
    await act(async () => (host.querySelector(".wb-tool-tab") as HTMLElement).click());
    expect((host.querySelector(".wb-code-surface") as HTMLElement).hidden).toBe(true);
    expect(host.querySelector("textarea")).toBe(editor);
    await render("services");
    expect((host.querySelector(".wb-code-surface") as HTMLElement).hidden).toBe(false);
    expect(host.querySelector(".svc-host")?.textContent).toContain("Logs");
    expect(host.querySelector("textarea")).toBe(editor);
    expect(editor?.value).toBe("draft");
  });
});
