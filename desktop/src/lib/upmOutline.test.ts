/**
 * upm 装配清单 → 大纲符号（P2-6）。
 *
 * 解析真源在 Rust `nc_upm::parse`，这里钉住**定位**口径：组件块与解析结果
 * 按文档顺序配对、注释中和不漂移偏移、脏数据不丢条目。反例与 Rust 侧
 * `strip_comments`/Builder 的行为一一对应。
 */
import { describe, expect, it } from "vitest";
import { blankComments, upmSymbols } from "./upmOutline";
import type { UpmComponent, UpmFile } from "./upm";

const comp = (iface: string, impl: string, visibility = "public"): UpmComponent => ({
  interface: iface, implementation: impl, visibility,
  remote: false, singleton: false, tx: "", alias: false, priority: null,
});
const file = (components: UpmComponent[]): UpmFile => ({
  declaredModule: "arap", module: "arap", path: "C:/w/arap/META-INF/a.upm", origin: "project", components,
});

const text = [
  '<?xml version="1.0" encoding="gb2312"?>',
  '<module name="arap">',
  '  <public>',
  '    <component remote="true" tx="CMT">',
  '      <interface>nc.itf.arap.IA</interface>',
  '      <implementation>nc.impl.arap.AImpl</implementation>',
  '    </component>',
  '    <component>',
  '      <interface>nc.itf.arap.IB</interface>',
  '      <implementation>nc.impl.arap.BImpl</implementation>',
  '    </component>',
  '  </public>',
  '  <private>',
  '    <component>',
  '      <interface>nc.itf.arap.IC</interface>',
  '      <implementation>nc.impl.arap.CImpl</implementation>',
  '    </component>',
  '  </private>',
  '</module>',
].join("\n");
const comps = [comp("nc.itf.arap.IA", "nc.impl.arap.AImpl"), comp("nc.itf.arap.IB", "nc.impl.arap.BImpl"), comp("nc.itf.arap.IC", "nc.impl.arap.CImpl", "private")];

describe("upm 大纲符号", () => {
  it("接口短名 + 实现短名 + 行列落在接口文本上，块起止覆盖整个 component", () => {
    const syms = upmSymbols(file(comps), text);
    expect(syms.map(s => s.name)).toEqual(["IA", "IB", "IC"]);
    expect(syms.map(s => s.container)).toEqual(["AImpl", "BImpl", "CImpl"]);
    expect(syms.map(s => s.line)).toEqual([5, 9, 15]);
    expect(syms.every(s => s.column === 18)).toBe(true);
    expect(syms.map(s => [s.startLine, s.endLine])).toEqual([[4, 7], [8, 11], [14, 17]]);
    expect(syms.map(s => s.kind)).toEqual([202, 202, 204]);
    expect(syms.every(s => s.depth === 1)).toBe(true);
  });

  it("注释里的假组件不产生条目，也不漂移后续行号（等长中和）", () => {
    const commented = text.replace('<module name="arap">',
      '<module name="arap">\n<!--\n<component><interface>nc.itf.Fake</interface><implementation>x.Y</implementation></component>\n-->');
    expect(blankComments(commented).length).toBe(commented.length);
    const syms = upmSymbols(file(comps), commented);
    expect(syms.map(s => s.name)).toEqual(["IA", "IB", "IC"]);
    expect(syms.map(s => s.line)).toEqual([8, 12, 18]);
  });

  it("未闭合注释之后全作废（与 strip_comments 截断同口径）", () => {
    const cut = text.replace("  <private>", "  <!-- 没闭合\n  <private>");
    const syms = upmSymbols(file(comps.slice(0, 2)), cut);
    expect(syms.map(s => s.name)).toEqual(["IA", "IB"]);
    expect(syms.map(s => s.line)).toEqual([5, 9]);
    // 注释后的真实标签不再被定位到
    expect(blankComments(cut).slice(cut.indexOf("<!--"))).toMatch(/^\s*$/);
  });

  it("同接口多条装配（覆盖链）各定位到各自的出现处", () => {
    const dup = [
      '<module name="m">',
      '<component><interface>nc.itf.I</interface><implementation>nc.impl.First</implementation></component>',
      '<component><interface>nc.itf.I</interface><implementation>nc.impl.Second</implementation></component>',
      '</module>',
    ].join("\n");
    const syms = upmSymbols(file([comp("nc.itf.I", "nc.impl.First"), comp("nc.itf.I", "nc.impl.Second")]), dup);
    expect(syms.map(s => s.line)).toEqual([2, 3]);
    expect(syms.map(s => s.container)).toEqual(["First", "Second"]);
  });

  it("只有实现没有接口的脏数据：名字取实现，container 不重复", () => {
    const t = '<module name="m">\n<component><implementation>nc.impl.Only</implementation></component>\n</module>';
    const syms = upmSymbols(file([comp("", "nc.impl.Only")]), t);
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe("Only");
    expect(syms[0].container).toBe("");
    expect(syms[0].line).toBe(2);
  });

  it("未闭合组件后紧跟新组件：两条都在（Builder 在下一个开标签处收前一条）", () => {
    const t = '<module name="m">\n<component><interface>nc.itf.I1</interface><implementation>nc.impl.C1</implementation>\n<component><interface>nc.itf.I2</interface><implementation>nc.impl.C2</implementation></component>\n</module>';
    const syms = upmSymbols(file([comp("nc.itf.I1", "nc.impl.C1"), comp("nc.itf.I2", "nc.impl.C2")]), t);
    expect(syms.map(s => s.name)).toEqual(["I1", "I2"]);
    expect(syms.map(s => s.line)).toEqual([2, 3]);
    expect(syms[0].endLine).toBe(2);
  });

  it("标签大小写不敏感；接口文本前导空白不计入列号", () => {
    const t = '<MODULE name="m">\n<COMPONENT>\n  <INTERFACE>\n    nc.itf.I\n  </INTERFACE>\n  <IMPLEMENTATION>nc.impl.C</IMPLEMENTATION>\n</COMPONENT>\n</MODULE>';
    const syms = upmSymbols(file([comp("nc.itf.I", "nc.impl.C")]), t);
    expect(syms[0].name).toBe("I");
    expect(syms[0].line).toBe(4);
    expect(syms[0].column).toBe(5);
  });

  it("配对不上的组件兜底第 1 行，不丢条目", () => {
    const syms = upmSymbols(file([...comps, comp("nc.itf.Ghost", "nc.impl.Ghost")]), text);
    expect(syms).toHaveLength(4);
    expect(syms[3].name).toBe("Ghost");
    expect(syms[3].line).toBe(1);
  });

  it("空文件 / 空清单", () => {
    expect(upmSymbols(file([]), "")).toEqual([]);
    expect(upmSymbols(file([]), text)).toEqual([]);
  });
});