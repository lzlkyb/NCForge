import { describe, expect, it } from "vitest";
import {
  componentOptions,
  componentScopeDirs,
  fallbackNote,
  isSingleScope,
  missingNote,
  toSearchOptions,
} from "./searchScope";
import type { NcComponent } from "./ncManifest";
import type { SearchForm } from "./searchStore";

/** 只给要断言的那几个字段，其余走一份固定的默认值。 */
const form = (patch: Partial<SearchForm>): SearchForm => ({
  query: "",
  include: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  scope: "current",
  component: null,
  outcome: null,
  projectOutcome: null,
  outcomeRoot: null,
  outcomeOptions: null,
  running: false,
  collapsed: [],
  error: null,
  replacement: "",
  replacing: false,
  replaceOutcome: null,
  ...patch,
});

const c = (name: string, dispname = "", roots: string[] = []): NcComponent => ({
  name,
  dispname,
  roots,
});

describe("componentOptions", () => {
  it("按名字去重（manifest 里同一个组件能登记两次）并排序", () => {
    const opts = componentOptions([c("gl", "总账"), c("bill", "票据"), c("gl", "总账"), c("aim")]);
    expect(opts.map((o) => o.name)).toEqual(["aim", "bill", "gl"]);
  });

  it("中文名与目录名相同时不重复显示", () => {
    // dispname="" 的组件很多；dispname 恰好等于 name 时也不该显示成 `bill bill`
    const opts = componentOptions([c("bill", ""), c("gl", "gl")]);
    expect(opts).toEqual([
      { name: "bill", label: "" },
      { name: "gl", label: "" },
    ]);
  });

  it("名字大小写不同视为同一个组件，保留先到的那份", () => {
    const opts = componentOptions([c("MedPub", "医疗"), c("medpub", "重复")]);
    expect(opts).toEqual([{ name: "MedPub", label: "医疗" }]);
  });

  it("空名字被丢掉（解析残缺的 manifest 不该塞进列表）", () => {
    expect(componentOptions([c("  ", "x"), c("bill")]).map((o) => o.name)).toEqual(["bill"]);
  });

  it("没有 manifest 时是空列表", () => {
    expect(componentOptions([])).toEqual([]);
  });
});

describe("componentScopeDirs", () => {
  it("组件名就是范围目录（工作区相对）", () => {
    expect(componentScopeDirs("bill")).toEqual(["bill"]);
    expect(componentScopeDirs("  bill  ")).toEqual(["bill"]);
  });

  it("反斜杠与两侧分隔符都归一掉", () => {
    expect(componentScopeDirs("\\bill\\")).toEqual(["bill"]);
    expect(componentScopeDirs("/bill/")).toEqual(["bill"]);
  });

  it("没选组件时是空范围（= 后端按整个工作区）", () => {
    expect(componentScopeDirs(null)).toEqual([]);
    expect(componentScopeDirs("")).toEqual([]);
    expect(componentScopeDirs("   ")).toEqual([]);
  });

  it("能跳出工作区的名字一律拒绝：让后端回落并说明，而不是拼出一个越界范围", () => {
    expect(componentScopeDirs("..")).toEqual([]);
    expect(componentScopeDirs("../other")).toEqual([]);
    expect(componentScopeDirs("bill/../../x")).toEqual([]);
    expect(componentScopeDirs("C:\\Windows")).toEqual([]);
  });
});

describe("isSingleScope", () => {
  it("只有「全部工程」不是单工作区范围", () => {
    expect(isSingleScope("all")).toBe(false);
    expect(isSingleScope("current")).toBe(true);
    expect(isSingleScope("component")).toBe(true);
  });
});

describe("toSearchOptions", () => {
  it("纯文本模式 trim 搜索词，正则模式按原样传（前后空格有含义）", () => {
    expect(toSearchOptions(form({ query: "  foo  " })).text).toBe("foo");
    expect(toSearchOptions(form({ query: "  foo  ", regex: true })).text).toBe("  foo  ");
  });

  it("正则模式下「整词」不生效（与后端一致）", () => {
    expect(toSearchOptions(form({ query: "a", regex: true, wholeWord: true })).wholeWord).toBe(
      false,
    );
    expect(toSearchOptions(form({ query: "a", wholeWord: true })).wholeWord).toBe(true);
  });

  it("只有组件范围才带 dirs，别的范围一律是整个工作区", () => {
    expect(toSearchOptions(form({ scope: "all" })).dirs).toEqual([]);
    expect(toSearchOptions(form({ scope: "current" })).dirs).toEqual([]);
    expect(toSearchOptions(form({ scope: "component", component: "bill" })).dirs).toEqual(["bill"]);
  });

  it("组件范围但没选组件时范围为空（后端按整个工作区，界面另有提示）", () => {
    expect(toSearchOptions(form({ scope: "component", component: null })).dirs).toEqual([]);
  });
});

describe("范围说明文案", () => {
  it("回落时把缺失的目录列出来", () => {
    expect(fallbackNote(["bill"])).toContain("bill");
    expect(fallbackNote(["bill"])).toContain("按整个工作区搜索");
    // 目录列表为空也要说人话
    expect(fallbackNote([])).toContain("按整个工作区搜索");
  });

  it("部分缺失时说「已跳过」并给个数", () => {
    const note = missingNote(["bill/src/public", "bill/src/client"]);
    expect(note).toContain("2 个");
    expect(note).toContain("bill/src/public");
  });
});
