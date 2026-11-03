// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedProjectsDialog } from "./LinkedProjectsDialog";
import { clearLinkedGraphCache } from "../../hooks/useLinkedGraph";
import { openLinkedDialog, closeLinkedDialog, useLinkedDialog } from "../../lib/linkedDialog";
import { setSession } from "../../lib/workspaceSession";
import type { LinkedGraph, LinkedOverride } from "../../lib/linkedProjects";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));

const dirs = (n: number) => Array.from({ length: n }, (_, i) => `C:\\x\\d${i}`);

const graph = (): LinkedGraph => ({
  primary: "EyePortal",
  primaryRoot: "C:\\work\\aier\\EyePortal",
  workspace: "C:\\work\\aier",
  projects: [
    {
      name: "EyePortal",
      root: "C:\\work\\aier\\EyePortal",
      origin: "primary",
      depth: 0,
      exported: false,
      classDirs: dirs(9),
      disabled: false,
      hasClasspath: true,
    },
    {
      name: "pm",
      root: "C:\\work\\aier\\pm",
      origin: "classpath",
      depth: 1,
      exported: true,
      classDirs: dirs(8),
      disabled: false,
      hasClasspath: true,
    },
  ],
  extraDirs: [],
  projectDirCount: 17,
  ncHomeDirCount: 0,
  totalDirCount: 17,
  notes: [],
});

let stored: LinkedOverride[] = [];

const invokeImpl = async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "linked_projects") return graph();
  if (cmd === "get_config") return { linked_overrides: stored };
  if (cmd === "set_linked_overrides") {
    stored = (args?.overrides ?? []) as LinkedOverride[];
    return stored;
  }
  throw new Error(`unexpected command: ${cmd}`);
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function OpenProbe() {
  const { open } = useLinkedDialog();
  return <span data-testid="open">{open ? "open" : "closed"}</span>;
}

const flush = async (times = 3) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

/** 等确认框的退场动画（MOTION.exit = 140ms）真正走完。 */
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });
  await flush();
};

const elapsed = () => container.querySelector('[data-testid="open"]')?.textContent;

const buttonIn = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;

const closeButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!;

const open = async () => {
  await act(async () => openLinkedDialog("chain"));
  await flush();
};

const makeDirty = async () => {
  const row = [...document.querySelectorAll<HTMLElement>(".lnk-item")].find((li) =>
    li.querySelector(".lnk-name")?.textContent?.includes("pm"),
  )!;
  await act(async () => buttonIn(row, "停用")!.click());
};

beforeEach(() => {
  vi.clearAllMocks();
  closeLinkedDialog();
  clearLinkedGraphCache();
  setSession({ root: "C:\\work\\aier\\EyePortal" });
  stored = [];
  mocks.invoke.mockImplementation(invokeImpl);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <>
        <OpenProbe />
        <LinkedProjectsDialog />
      </>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setSession({ root: null });
});

describe("工程关联弹框", () => {
  it("没有改动时关闭直接生效，不再多问一句", async () => {
    await open();
    expect(document.body.textContent).toContain("工程关联");

    await act(async () => closeButton().click());
    expect(elapsed()).toBe("closed");
    expect(document.body.textContent).not.toContain("覆盖表还有未保存的改动");
  });

  it("有未保存草稿：关闭被拦下；继续编辑留下，放弃改动才关", async () => {
    await open();
    await makeDirty();

    await act(async () => closeButton().click());
    expect(document.body.textContent).toContain("覆盖表还有未保存的改动");
    expect(elapsed()).toBe("open");
    // 放弃之前不能落盘
    expect(mocks.invoke).not.toHaveBeenCalledWith("set_linked_overrides", expect.anything());

    await act(async () => buttonIn(document.body, "继续编辑")!.click());
    await settle();
    expect(elapsed()).toBe("open");
    expect(document.body.textContent).not.toContain("覆盖表还有未保存的改动");

    await act(async () => closeButton().click());
    await act(async () => buttonIn(document.body, "放弃改动并关闭")!.click());
    expect(elapsed()).toBe("closed");
    expect(mocks.invoke).not.toHaveBeenCalledWith("set_linked_overrides", expect.anything());
  });

  it("保存并关闭：整表落盘成功后才关", async () => {
    await open();
    await makeDirty();

    await act(async () => closeButton().click());
    await act(async () => buttonIn(document.body, "保存并关闭")!.click());
    await settle();

    expect(mocks.invoke).toHaveBeenCalledWith("set_linked_overrides", {
      overrides: [{ action: "disable", target: "pm", dir: null }],
    });
    expect(elapsed()).toBe("closed");
  });

  it("保存失败时留在弹框里，不把用户的手写草稿扔掉", async () => {
    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "set_linked_overrides") throw new Error("磁盘只读");
      return invokeImpl(cmd, args);
    });
    await open();
    await makeDirty();

    await act(async () => closeButton().click());
    await act(async () => buttonIn(document.body, "保存并关闭")!.click());
    await settle();

    expect(elapsed()).toBe("open");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("保存覆盖表失败"), "error");
    expect(document.querySelector(".lnk-dirty")).toBeTruthy();
  });
});
