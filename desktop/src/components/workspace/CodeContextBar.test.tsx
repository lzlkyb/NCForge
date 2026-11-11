// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CodeContextBar } from "./CodeContextBar";
const session = vi.hoisted(() => ({ activePath: "D:/供应链/ic/src/private/A.java", tabs: [{ dirty: true }] }));
vi.mock("../../lib/workspaceSession", () => ({ useWorkspaceSelector: (selector: (s: typeof session) => unknown) => selector(session) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("工程、保存状态和模块来自真实路径，关联工程不能误编当前工程", async () => {
  const host = document.createElement("div"), root = createRoot(host), compile = vi.fn(); document.body.append(host);
  const render = () => act(async () => root.render(<CodeContextBar root="D:/供应链" compiling={false} canCompile onCompile={compile} />));
  try {
    await render(); expect(host.textContent).toContain("供应链"); expect(host.textContent).toContain("有未保存修改");
    const button = [...host.querySelectorAll("button")].find(b => b.textContent === "编译 ic 模块")!;
    await act(async () => button.click()); expect(compile).toHaveBeenCalledOnce();
    session.activePath = "D:/关联工程/gl/src/A.java"; await render();
    expect(host.querySelector<HTMLButtonElement>(".ux-primary")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".ux-primary")?.title).toBe("当前文件不属于工作区模块");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
