// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileStatusMenu } from "./FileStatusMenu";
import { ShellStatusBar } from "./ShellStatusBar";
import type { TabMeta } from "../../lib/workspaceSession";
vi.mock("../../lib/editorStore", () => ({ getModel: () => ({ getLanguageId: () => "java" }) }));
vi.mock("../../lib/cursorStore", () => ({ useCursor: () => ({ line: 23, column: 4 }) }));
vi.mock("./LangBadge", () => ({ LangBadge: () => null }));
vi.mock("./ServiceStatusButton", () => ({ ServiceStatusButton: () => null }));
vi.mock("./HotswapStatusChip", () => ({ HotswapStatusChip: () => null }));
vi.mock("./StatusContributions", () => ({ StatusContributions: () => null }));
vi.mock("../ui/OperationStatus", () => ({ OperationStatus: () => null }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const active: TabMeta = { path: "D:/工程/Current.java", name: "Current.java", dirty: true, readOnly: false, readOnlyReason: null, encoding: "GBK", eol: "CRLF", eolChanged: false, hasBom: false, lines: 100, mtimeMs: 1 };
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe("当前文件状态菜单", () => {
  it("编码、行尾、光标和未保存状态在收敛后仍可直接查看", () => {
    act(() => root.render(<FileStatusMenu active={active} />));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="当前文件状态"]')!;
    expect(trigger.title).toContain("GBK · CRLF · 第 23 行，第 4 列");
    act(() => trigger.click());
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("未保存"); expect(menu.textContent).toContain("CRLF");
    act(() => root.render(<FileStatusMenu active={{ ...active, dirty: false, readOnly: true, virtual: "decompiled" }} />));
    expect(menu.textContent).toContain("只读"); expect(menu.textContent).not.toContain("未保存");
  });
  it("仅统一行尾尚未写盘也常驻未保存，文件详情保持相同状态", () => {
    const changed = { ...active, dirty: false, eolChanged: true };
    const renderStatus = (file: TabMeta) => root.render(<ShellStatusBar root="D:/工程" active={file} mark={undefined} saving={false} panelOpen={true} onTogglePanel={vi.fn()} activeTool="files" />);
    act(() => renderStatus(changed));
    expect(host.querySelector(".wb-status-unsaved")?.textContent).toBe("未保存");
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="当前文件状态"]')!.click());
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("未保存");
    act(() => renderStatus({ ...changed, eolChanged: false }));
    expect(host.querySelector(".wb-status-unsaved")).toBeNull();
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("已保存");
  });
});
