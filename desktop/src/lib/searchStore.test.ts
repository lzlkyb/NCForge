import { beforeEach, describe, expect, it } from "vitest";
import {
  applySearchScope,
  currentSearchSeq,
  getSearchForm,
  resetSearchForm,
  setSearchForm,
} from "./searchStore";

/**
 * 只测「换工作区」这一步的清理契约：搜索页被保活、不会重挂载，
 * 仓库里的残留就是屏幕上的一切。
 */
describe("resetSearchForm（切工作区）", () => {
  beforeEach(() => {
    resetSearchForm();
    setSearchForm({
      query: "billSave",
      include: "*.java",
      scope: "all",
      component: null,
      outcome: null,
      projectOutcome: null,
      outcomeRoot: null,
      outcomeOptions: null,
    });
  });

  it("查询词与过滤保留（换工程后多半是想用同样的词再搜一遍）", () => {
    resetSearchForm();
    expect(getSearchForm().query).toBe("billSave");
    expect(getSearchForm().include).toBe("*.java");
  });

  it("组件选择清掉：旧工程的组件名对新工程没有意义", () => {
    setSearchForm({ scope: "component", component: "bill" });
    resetSearchForm();
    expect(getSearchForm().component).toBeNull();
  });

  it("「组件」范围退回「当前工程」，不留一个没有组件的空范围", () => {
    setSearchForm({ scope: "component", component: "bill" });
    resetSearchForm();
    // 留着 component 范围又没有组件的话，芯片是灰的、实际却在搜整个工作区
    expect(getSearchForm().scope).toBe("current");
  });

  it("别的范围不动（「当前工程」是用户的长期偏好）", () => {
    setSearchForm({ scope: "current" });
    resetSearchForm();
    expect(getSearchForm().scope).toBe("current");
  });
});

describe("applySearchScope（换范围 / 换组件）", () => {
  it("旧结果全清，查询词与过滤保留", () => {
    setSearchForm({
      query: "billSave",
      include: "*.java",
      outcome: { hits: [], filesScanned: 1, filesMatched: 0, truncated: false, elapsedMs: 1, scopeDirs: [], missingDirs: [], scopeFallback: false },
      outcomeRoot: "C:\\w\\newar",
      outcomeOptions: { text: "billSave" },
      collapsed: ["A.java"],
      error: "旧错误",
      replaceOutcome: { filesChanged: 1, replacements: 1, filesScanned: 1, skippedUnsafe: 0, errors: [], truncated: false, elapsedMs: 1 },
    });

    applySearchScope("component", "bill");

    const f = getSearchForm();
    expect(f.scope).toBe("component");
    expect(f.component).toBe("bill");
    expect(f.outcome).toBeNull();
    expect(f.outcomeRoot).toBeNull();
    expect(f.outcomeOptions).toBeNull();
    expect(f.collapsed).toEqual([]);
    expect(f.error).toBeNull();
    expect(f.replaceOutcome).toBeNull();
    // 换范围往往就是想用同样的词再搜一遍
    expect(f.query).toBe("billSave");
    expect(f.include).toBe("*.java");
  });

  it("顶掉在飞的请求：上一轮结果回来时序号已经不对", () => {
    const before = currentSearchSeq();
    applySearchScope("current", null);
    expect(currentSearchSeq()).toBeGreaterThan(before);
  });
});
