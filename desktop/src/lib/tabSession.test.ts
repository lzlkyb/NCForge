import { describe, expect, it } from "vitest";
import { addTab, pickClosable, pinTab } from "./tabSession";
import type { TabMeta } from "./workspaceSession";

const tab = (path: string, extra: Partial<TabMeta> = {}): TabMeta =>
  ({ path, dirty: false, eolChanged: false, ...extra }) as TabMeta;

describe("addTab", () => {
  it("非预览直接追加", () => {
    const r = addTab([tab("a")], tab("b"), false);
    expect(r.tabs.map((t) => t.path)).toEqual(["a", "b"]);
    expect(r.dropped).toBeNull();
  });

  it("预览标签顶替已有预览标签并返回被顶替路径", () => {
    const r = addTab([tab("a"), tab("p", { preview: true })], tab("q"), true);
    expect(r.tabs.map((t) => t.path)).toEqual(["a", "q"]);
    expect(r.tabs[1].preview).toBe(true);
    expect(r.dropped).toBe("p");
  });

  it("已有预览标签有未保存改动时不顶替", () => {
    const r = addTab([tab("p", { preview: true, dirty: true })], tab("q"), true);
    expect(r.tabs.map((t) => t.path)).toEqual(["p", "q"]);
    expect(r.dropped).toBeNull();
  });
});

describe("pinTab", () => {
  it("只固定指定路径的预览标签", () => {
    const r = pinTab([tab("a", { preview: true }), tab("b", { preview: true })], "a");
    expect(r[0].preview).toBe(false);
    expect(r[1].preview).toBe(true);
  });
});

describe("pickClosable", () => {
  it("跳过有未保存改动的标签并计数", () => {
    const tabs = [tab("a"), tab("b", { dirty: true }), tab("c"), tab("d", { eolChanged: true })];
    const r = pickClosable(tabs, (t) => t.path !== "a");
    expect(r.close).toEqual(["c"]);
    expect(r.kept).toBe(2);
  });

  it("按下标选右侧", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    const r = pickClosable(tabs, (_t, i) => i > 0);
    expect(r.close).toEqual(["b", "c"]);
    expect(r.kept).toBe(0);
  });
});
