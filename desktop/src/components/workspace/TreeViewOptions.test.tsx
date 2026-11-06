// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TreeHeader } from "./TreeHeader";
import { setCompactPackages, setRevealOnOpen } from "../../lib/treeViewPrefs";
import { setDirectSwitch } from "../../lib/projectSwitchPref";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  setCompactPackages(true);
  setRevealOnOpen(true);
  // 第三个开关默认关：跨工程切换代价大，先确认
  setDirectSwitch(false);
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
const openOptions = () => act(async () => byLabel("资源树视图选项")!.click());
const option = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')).find(button => button.textContent === label)!;

describe("树视图开关", () => {
  it("自动定位常驻，次要视图开关在更多选项中且状态明确", async () => {
    await renderHeader();
    const reveal = byLabel("自动定位");
    expect(option("压缩中间包")).toBeUndefined();
    await openOptions();
    const compact = option("压缩中间包");
    const direct = option("跨工程直接切换");
    expect(reveal).toBeTruthy();
    expect(compact).toBeTruthy();
    expect(direct).toBeTruthy();
    expect(reveal!.getAttribute("aria-pressed")).toBe("true");
    expect(compact!.getAttribute("aria-checked")).toBe("true");
    expect(direct!.getAttribute("aria-checked")).toBe("false");
    expect(reveal!.getAttribute("title")).toContain("展开并滚到该行");
    expect(option("NC 结构视图").disabled).toBe(true);
    expect(document.body.textContent).toContain("当前工程未登记 NC 业务组件");
  });

  it("点自动定位只切它自己，并落盘", async () => {
    await renderHeader();
    await openOptions();
    const reveal = byLabel("自动定位")!;
    const compact = option("压缩中间包");
    const direct = option("跨工程直接切换");

    await act(async () => reveal.click());
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    expect(reveal.getAttribute("title")).toContain("不再自动展开");
    expect(localStorage.getItem("ncforge.tree.revealOnOpen")).toBe("0");
    // 其他开关不受牵连
    expect(compact.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("ncforge.tree.compactPackages")).toBeNull();
    expect(direct.getAttribute("aria-checked")).toBe("false");
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
});
