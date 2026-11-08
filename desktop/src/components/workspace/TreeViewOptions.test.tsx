// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeHeader } from "./TreeHeader";
import { setCompactPackages, setRevealOnOpen, setNcStructure, setPackageView } from "../../lib/treeViewPrefs";
import { setDirectSwitch } from "../../lib/projectSwitchPref";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ ncReady: false }));
vi.mock("../../hooks/useNcComponents", () => ({ useNcComponents: () => ({ bcNames: new Set(h.ncReady ? ["test"] : []) }) }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setCompactPackages(true);
  setRevealOnOpen(true);
  // 第三个开关默认关：跨工程切换代价大，先确认
  setDirectSwitch(false);
  setPackageView(false);
  setNcStructure(false);
  localStorage.clear();
  h.ncReady = false;
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
        recents={[]}
        onOpen={noop}
        onOpenRecent={noop}
        onCreateFile={noop}
        onCreateDir={noop}
        onSearch={noop}
      />,
    ),
  );

const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const openOptions = () => act(async () => byLabel("更多资源操作")!.click());
const option = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')).find(button => button.textContent === label)!;

describe("树视图开关", () => {
  it("自动定位常驻顶部，低频视图设置在菜单且没有重复定位入口", async () => {
    await renderHeader();
    const reveal = byLabel("自动定位");
    expect(reveal).toBeTruthy();
    expect(reveal!.closest(".wb-pane-title")).toBeTruthy();
    expect(reveal!.getAttribute("aria-pressed")).toBe("true");
    expect(reveal!.title).toContain("展开并定位");
    expect(reveal!.querySelector("svg")?.getAttribute("width")).toBe("16");
    expect(byLabel("资源树视图选项")).toBeNull();
    expect(option("压缩中间包")).toBeUndefined();
    await openOptions();
    expect(option("自动定位")).toBeUndefined();
    expect(document.querySelectorAll('[aria-label="自动定位"]')).toHaveLength(1);
    const compact = option("压缩中间包");
    const direct = option("跨工程直接切换");
    expect(compact).toBeTruthy();
    expect(direct).toBeTruthy();
    expect(compact!.getAttribute("aria-checked")).toBe("true");
    expect(direct!.getAttribute("aria-checked")).toBe("false");
    expect(option("NC 结构视图").disabled).toBe(true);
    expect(document.body.textContent).toContain("当前工程未登记 NC 业务组件");
  });

  it("顶部自动定位可直接双向切换，保留焦点并独立落盘", async () => {
    await renderHeader();
    const reveal = byLabel("自动定位")!;

    await act(async () => { reveal.focus(); reveal.click(); });
    expect(document.activeElement).toBe(reveal);
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    expect(reveal.title).toContain("已关闭");
    expect(byLabel("更多资源操作")!.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("ncforge.tree.revealOnOpen")).toBe("0");
    // 其他开关不受牵连
    await openOptions();
    expect(option("压缩中间包").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("ncforge.tree.compactPackages")).toBeNull();
    expect(option("跨工程直接切换").getAttribute("aria-checked")).toBe("false");
    await openOptions();
    await act(async () => reveal.click());
    expect(reveal.getAttribute("aria-pressed")).toBe("true");
    expect(reveal.title).toContain("已开启");
    expect(localStorage.getItem("ncforge.tree.revealOnOpen")).toBe("1");
  });

  it("点压缩中间包切成逐层并落盘", async () => {
    await renderHeader();
    await openOptions();
    const compact = option("压缩中间包");

    await act(async () => compact.click());
    await openOptions();
    expect(option("压缩中间包").getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("ncforge.tree.compactPackages")).toBe("0");
    expect(byLabel("自动定位")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("跨工程直接切换默认关，点开后才落盘", async () => {
    await renderHeader();
    await openOptions();
    const direct = option("跨工程直接切换");

    await act(async () => direct.click());
    await openOptions();
    expect(option("跨工程直接切换").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("ncforge.tree.directSwitch")).toBe("1");
    // 另外两个开关不受影响
    expect(byLabel("自动定位")!.getAttribute("aria-pressed")).toBe("true");
    expect(option("压缩中间包").getAttribute("aria-checked")).toBe("true");
  });

  it("有业务组件的文件视图可切 NC 结构，改成包视图后保留设置并说明限制", async () => {
    h.ncReady = true;
    await renderHeader();
    await openOptions();
    expect(option("NC 结构视图").disabled).toBe(false);
    await act(async () => option("NC 结构视图").click());
    await openOptions();
    expect(option("NC 结构视图").getAttribute("aria-checked")).toBe("true");
    await act(async () => setPackageView(true));
    expect(option("NC 结构视图").disabled).toBe(true);
    expect(option("NC 结构视图").getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("切换文件视图后可使用 NC 结构");
  });
});
