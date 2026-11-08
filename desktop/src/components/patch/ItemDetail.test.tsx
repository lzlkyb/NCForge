// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchItem } from "../../lib/patch";
import { ItemDetail } from "./ItemDetail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (patch: Partial<PatchItem> = {}): PatchItem => ({
  path: "D:/workspace/demo/private/nc/bs/Bill.java", rel: "demo/private/nc/bs/Bill.java",
  label: "Bill.java", module: "demo", section: "private", pkgRel: "nc/bs/Bill.java",
  target: "modules/demo/classes/nc/bs", layer: { hyext: false, why: "未命中 hyext jar" },
  classes: [{ name: "Bill.class", path: "D:/workspace/classes/nc/bs/Bill.class", fresh: true }],
  problems: [], blocked: false, outRootUsed: "classes", ...patch,
});
let root: Root;
let host: HTMLDivElement;
const onForce = vi.fn();
beforeEach(() => {
  onForce.mockReset();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (value = item(), override: "hy" | "std" | null = null) => {
  await act(async () => root.render(<ItemDetail item={value} override={override} onForce={onForce} />));
  return host.querySelector<HTMLDetailsElement>("details")!;
};
const toggle = async (details: HTMLDetailsElement) => act(async () => details.querySelector<HTMLElement>("summary")!.click());

describe("补丁文件详情收纳", () => {
  it("正常文件默认折叠，摘要保留身份、模块、层与配对状态，展开后完整信息仍可查", async () => {
    const details = await render();
    expect(details.open).toBe(false);
    for (const text of ["Bill.java", "demo", "标准", "1 class", "详情"]) {
      expect(details.querySelector("summary")!.textContent).toContain(text);
    }
    await toggle(details);
    expect(details.open).toBe(true);
    expect(details.querySelector(".pk-map")!.textContent).toContain("modules/demo/classes/nc/bs/");
    expect(details.querySelector(".pk-map")!.textContent).toContain("Bill.class（classes）");
    expect(details.textContent).toContain("层判定：未命中 hyext jar");
    await toggle(details);
    expect(details.open).toBe(false);
  });

  it.each([
    ["未编译", { classes: [] }],
    ["过期", { classes: [{ name: "Bill.class", path: "old/Bill.class", fresh: false }] }],
    ["阻断", { blocked: true, problems: [{ level: "error", text: "无法确定落位目录" }] }],
    ["1 项问题", { problems: [{ level: "warn", text: "编译目录存在多个候选" }] }],
  ] satisfies [string, Partial<PatchItem>][])("%s 默认展开，手动收起后摘要仍能辨认异常", async (label, patch) => {
    const details = await render(item(patch));
    expect(details.open).toBe(true);
    await toggle(details);
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain(label);
  });

  it("同一文件刷新保留手动开合，新出现的配对异常会自动展开", async () => {
    const details = await render();
    await toggle(details);
    expect(await render(item({ outRootUsed: "out/classes" }))).toBe(details);
    expect(details.open).toBe(true);
    await toggle(details);
    await render(item({ classes: [] }));
    expect(details.open).toBe(true);
  });

  it("切换文件重置默认开合并显示新文件依据，改判回调仍属于当前内容", async () => {
    const first = await render();
    await toggle(first);
    const next = await render(item({ path: "D:/workspace/other/Next.java", label: "Next.java", module: "other", target: "modules/other", layer: { hyext: true, why: "命中 other hyext jar" } }));
    expect(next).not.toBe(first);
    expect(next.open).toBe(false);
    for (const text of ["Next.java", "other", "hyext"]) expect(next.querySelector("summary")!.textContent).toContain(text);
    await toggle(next);
    expect(next.textContent).toContain("层判定：命中 other hyext jar");
    const force = [...next.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "标准层")!;
    await act(async () => force.click());
    expect(onForce).toHaveBeenCalledWith("std");
  });

  it("手动改判显式标记，自动、标准层与 hyext 操作完整保留", async () => {
    const details = await render(item(), "hy");
    expect(details.open).toBe(true);
    expect(details.querySelector("summary")!.textContent).toContain("手动改判");
    expect(details.querySelector("button[data-on]")!.textContent).toBe("hyext");
    const buttons = [...details.querySelectorAll<HTMLButtonElement>("button")];
    for (const [label, value] of [["自动", null], ["标准层", "std"], ["hyext", "hy"]] as const) {
      await act(async () => buttons.find((button) => button.textContent === label)!.click());
      expect(onForce).toHaveBeenLastCalledWith(value);
    }
  });

  it("整文件替换保留目标说明，不提供不适用的改判操作", async () => {
    const details = await render(item({ section: "hotwebs", pkgRel: "index.html", classes: [], layer: null }));
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain("整文件");
    await toggle(details);
    expect(details.querySelectorAll("button")).toHaveLength(0);
    expect(details.textContent).not.toContain("层判定：");
    expect(details.querySelector<HTMLElement>(".pk-detail-pair")!.title).toContain("网页文件整文件替换");
    expect(details.querySelector(".pk-map")!.textContent).toContain("无（整文件替换或不需编译）");
  });
});
