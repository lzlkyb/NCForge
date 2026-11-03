// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabStrip } from "./TabStrip";
import type { TabMeta } from "../../lib/workspaceSession";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./WorkbenchDock", () => ({ useWorkbenchDock: () => null }));
vi.mock("./TaskMenu", () => ({ TaskMenu: () => null }));
vi.mock("../../lib/workspaceSession", () => ({ setSession: vi.fn() }));

const tab = (path: string, dirty = false): TabMeta => ({
  path,
  name: path.split("\\").pop() ?? path,
  encoding: "UTF-8",
  hasBom: false,
  eol: "LF",
  mtimeMs: 0,
  dirty,
  eolChanged: false,
  readOnly: false,
  readOnlyReason: null,
  lines: 1,
  preview: false,
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(tabs: TabMeta[], activePath: string) {
  act(() =>
    root.render(
      <TabStrip
        root="C:\\w"
        tabs={tabs}
        activePath={activePath}
        splitPath={null}
        compiling={false}
        canCompile
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onCloseMany={() => 0}
        onPin={vi.fn()}
        onOpenSplit={vi.fn()}
        onCloseSplit={vi.fn()}
        onCompile={vi.fn()}
      />,
    ),
  );
}

describe("TabStrip 未保存标签", () => {
  it("平时留状态点，关闭按钮仍然可点并说明会先确认", () => {
    render([tab("C:\\w\\A.java", true)], "C:\\w\\A.java");
    const x = container.querySelector<HTMLButtonElement>(".wb-tab-x");
    expect(x?.getAttribute("aria-label")).toBe("关闭 A.java");
    expect(x?.title).toContain("未保存");
    expect(x?.querySelector(".wb-dirty-dot")).not.toBeNull();
    expect(x?.querySelector(".wb-tab-close")).not.toBeNull();
  });

  it("已保存标签只显示叉", () => {
    render([tab("C:\\w\\B.java")], "C:\\w\\B.java");
    const x = container.querySelector<HTMLButtonElement>(".wb-tab-x");
    expect(x?.querySelector(".wb-dirty-dot")).toBeNull();
    expect(x?.querySelector(".wb-tab-close")).toBeNull();
  });
});
