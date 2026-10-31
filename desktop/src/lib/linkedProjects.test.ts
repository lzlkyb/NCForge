import { describe, expect, it } from "vitest";
import {
  actionLabel,
  hasOverride,
  normalizeOverride,
  originLabel,
  overrideHits,
  overrideKey,
  removeOverride,
  sameOverrides,
  toDraft,
  upsertOverride,
  type LinkedOverride,
  type LinkedProject,
} from "./linkedProjects";

const project = (over: Partial<LinkedProject> = {}): LinkedProject => ({
  name: "pm",
  root: "C:\\work\\aier\\pm",
  origin: "classpath",
  depth: 1,
  exported: true,
  classDirs: ["C:\\work\\aier\\pm\\bin"],
  disabled: false,
  hasClasspath: true,
  ...over,
});

describe("标签", () => {
  it("originLabel 覆盖四种来路", () => {
    expect(originLabel("primary")).toBe("主工程");
    expect(originLabel("classpath")).toBe("依赖");
    expect(originLabel("legacy")).toBe("无 .classpath");
    expect(originLabel("front")).toBe("已提前");
  });

  it("actionLabel 覆盖三种动作", () => {
    expect(actionLabel("disable")).toBe("停用");
    expect(actionLabel("front")).toBe("排前");
    expect(actionLabel("add")).toBe("追加目录");
  });
});

describe("overrideHits 三路匹配（与后端一致）", () => {
  it("工程名命中（忽略大小写与首尾空白）", () => {
    expect(overrideHits({ action: "disable", target: " PM " }, project())).toBe(true);
  });

  it("绝对路径命中（分隔符与大小写不敏感）", () => {
    expect(
      overrideHits({ action: "front", target: "c:/WORK/aier/pm" }, project()),
    ).toBe(true);
  });

  it("目录名命中（用户从资源管理器里抄来的是最后一段）", () => {
    expect(overrideHits({ action: "disable", target: "pm" }, project({ name: "ar" }))).toBe(true);
  });

  it("target 为空不命中", () => {
    expect(overrideHits({ action: "disable", target: "   " }, project())).toBe(false);
  });

  it("root 为 null 时只剩工程名一路，不会误命中", () => {
    const p = project({ name: "newar", root: null });
    expect(overrideHits({ action: "disable", target: "newar" }, p)).toBe(true);
    expect(overrideHits({ action: "disable", target: "C:\\work\\newar" }, p)).toBe(false);
  });
});

describe("覆盖表草稿", () => {
  it("normalizeOverride 去空白，非 add 的 dir 一律丢掉", () => {
    expect(normalizeOverride({ action: "disable", target: " pm ", dir: "x" })).toEqual({
      action: "disable",
      target: "pm",
      dir: null,
    });
    expect(normalizeOverride({ action: "add", target: "", dir: " C:\\extra " })).toEqual({
      action: "add",
      target: "",
      dir: "C:\\extra",
    });
  });

  it("upsert 同动作同目标原位替换，不叠两条", () => {
    const one = upsertOverride([], { action: "disable", target: "pm" });
    const two = upsertOverride(one, { action: "disable", target: "PM" });
    expect(two).toHaveLength(1);
    expect(two[0]).toEqual({ action: "disable", target: "PM", dir: null });
  });

  it("add 按目录区分：追加两个目录就是两条", () => {
    const a = upsertOverride([], { action: "add", target: "", dir: "C:\\a" });
    const b = upsertOverride(a, { action: "add", target: "", dir: "C:\\b" });
    expect(b).toHaveLength(2);
    // 同一个目录再加一次仍是两条里的同一条
    expect(upsertOverride(b, { action: "add", target: "", dir: " c:\\A " })).toHaveLength(2);
  });

  it("remove / has 用同一个身份键", () => {
    const list: LinkedOverride[] = [{ action: "front", target: "pm", dir: null }];
    expect(hasOverride(list, { action: "front", target: " PM " })).toBe(true);
    expect(removeOverride(list, { action: "front", target: "pm" })).toHaveLength(0);
  });

  it("overrideKey 对非 add 忽略 dir（后端也不看它）", () => {
    expect(overrideKey({ action: "front", target: "pm", dir: "C:\\x" })).toBe(
      overrideKey({ action: "front", target: "pm" }),
    );
  });

  it("sameOverrides 认顺序差异为改动（顺序即类路径优先级）", () => {
    const a: LinkedOverride[] = [
      { action: "front", target: "pm" },
      { action: "disable", target: "newar" },
    ];
    const b: LinkedOverride[] = [
      { action: "disable", target: "newar" },
      { action: "front", target: "pm" },
    ];
    expect(sameOverrides(a, a)).toBe(true);
    expect(sameOverrides(a, b)).toBe(false);
  });

  it("toDraft 把 null / undefined 归一成同一种形态", () => {
    expect(toDraft(null)).toEqual([]);
    expect(toDraft([{ action: "disable", target: "pm", dir: undefined }])).toEqual([
      { action: "disable", target: "pm", dir: null },
    ]);
  });
});
