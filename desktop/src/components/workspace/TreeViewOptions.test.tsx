// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TreeHeader } from "./TreeHeader";
import { setCompactPackages, setRevealOnOpen } from "../../lib/treeViewPrefs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  setCompactPackages(true);
  setRevealOnOpen(true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const renderHeader = () =>
  act(async () =>
    root.render(
      <TreeHeader
        root={"C:\\w\\newar"}
        editing={false}
        draft={"C:\\w\\newar"}
        unsaved={false}
        recents={[]}
        onDraftChange={noop}
        onOpen={noop}
        onOpenRecent={noop}
        onToggleEditing={noop}
        onCreateFile={noop}
        onCreateDir={noop}
        onSearch={noop}
      />,
    ),
  );

const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe("树视图开关", () => {
  it("两个开关都挂在资源管理器标题栏，默认按下", async () => {
    await renderHeader();
    const reveal = byLabel("自动定位");
    const compact = byLabel("压缩中间包");
    expect(reveal).toBeTruthy();
    expect(compact).toBeTruthy();
    expect(reveal!.getAttribute("aria-pressed")).toBe("true");
    expect(compact!.getAttribute("aria-pressed")).toBe("true");
    expect(reveal!.getAttribute("title")).toContain("展开并滚到该行");
    expect(compact!.getAttribute("title")).toContain("单链目录合成一行");
  });

  it("点自动定位只切它自己，并落盘", async () => {
    await renderHeader();
    const reveal = byLabel("自动定位")!;
    const compact = byLabel("压缩中间包")!;

    await act(async () => reveal.click());
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    expect(reveal.getAttribute("title")).toContain("不再自动展开");
    expect(localStorage.getItem("ncforge.tree.revealOnOpen")).toBe("0");
    // 另一个开关不受牵连
    expect(compact.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("ncforge.tree.compactPackages")).toBeNull();
  });

  it("点压缩中间包切成逐层并落盘", async () => {
    await renderHeader();
    const compact = byLabel("压缩中间包")!;

    await act(async () => compact.click());
    expect(compact.getAttribute("aria-pressed")).toBe("false");
    expect(compact.getAttribute("title")).toContain("逐层显示");
    expect(localStorage.getItem("ncforge.tree.compactPackages")).toBe("0");
    expect(byLabel("自动定位")!.getAttribute("aria-pressed")).toBe("true");
  });
});
