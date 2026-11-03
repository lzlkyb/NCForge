import { describe, expect, it } from "vitest";
import { buildResultView, groupByProject, type ResultFileGroup } from "./searchResults";
import type { SearchForm } from "./searchStore";
import type { ProjectsSearchOutcome, SearchHit, SearchOutcome } from "./search";

const hit = (path: string, line: number, text = "billSave"): SearchHit => ({
  path,
  line,
  text,
  ranges: [{ start: 0, end: 8 }],
});

const outcome = (hits: SearchHit[], extra: Partial<SearchOutcome> = {}): SearchOutcome => ({
  hits,
  filesScanned: 100,
  filesMatched: 1,
  truncated: false,
  elapsedMs: 50,
  ...extra,
});

const form = (patch: Partial<SearchForm>): SearchForm => ({
  query: "billSave",
  include: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  scope: "all",
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

const projectOutcome = (): ProjectsSearchOutcome => ({
  projects: [
    {
      project: "newar",
      root: "C:\\w\\newar",
      outcome: outcome([hit("modules/ic/A.java", 12), hit("modules/ic/A.java", 30)]),
    },
    {
      project: "lib",
      root: "C:\\w\\lib",
      outcome: outcome([hit("modules/ic/A.java", 7)]),
    },
  ],
  errors: ["old: 读取失败"],
  truncated: false,
  elapsedMs: 620,
});

describe("buildResultView", () => {
  it("全部工程：同名路径按工程分开，汇总各工程计数并保留错误", () => {
    const view = buildResultView(
      form({ scope: "all", projectOutcome: projectOutcome(), outcomeRoot: "C:\\w\\newar" }),
    )!;
    expect(view.groups).toHaveLength(2);
    const [first, second] = view.groups;
    // 两个工程里都有 modules/ic/A.java，键必须带工程根，不能互相折叠
    expect(first.key).not.toBe(second.key);
    expect(first).toMatchObject({ project: "newar", projectRoot: "C:\\w\\newar", path: "modules/ic/A.java" });
    expect(first.hits).toHaveLength(2);
    expect(second).toMatchObject({ project: "lib", projectRoot: "C:\\w\\lib" });
    expect(view.summary).toMatchObject({
      hits: 3,
      filesMatched: 2,
      filesScanned: 200,
      elapsedMs: 620,
      projects: 2,
      truncated: false,
    });
    expect(view.errors).toEqual(["old: 读取失败"]);
    expect(view.outcomeRoot).toBe("C:\\w\\newar");
  });

  it("任一工程截断都按截断处理（不能报成「全都搜完了」）", () => {
    const po = projectOutcome();
    po.projects[1].outcome.truncated = true;
    const view = buildResultView(form({ scope: "all", projectOutcome: po }))!;
    expect(view.summary.truncated).toBe(true);
  });

  it("当前工程：只看 outcome，不拿全部工程的旧结果充数", () => {
    const view = buildResultView(
      form({
        scope: "current",
        projectOutcome: projectOutcome(),
        outcome: outcome([hit("A.java", 1)]),
        outcomeRoot: "C:\\w\\newar",
      }),
    )!;
    expect(view.groups).toHaveLength(1);
    expect(view.summary.projects).toBe(1);
    expect(view.errors).toEqual([]);
    expect(view.groups[0].projectRoot).toBeUndefined();
  });

  it("没有对应范围的结果时返回 null（空状态，不是空表格）", () => {
    expect(buildResultView(form({ scope: "all" }))).toBeNull();
    expect(buildResultView(form({ scope: "current", projectOutcome: projectOutcome() }))).toBeNull();
  });
});

describe("groupByProject", () => {
  const group = (key: string, project: string, root: string, n: number): ResultFileGroup => ({
    key,
    project,
    projectRoot: root,
    path: "A.java",
    hits: Array.from({ length: n }, (_, i) => hit("A.java", i + 1)),
  });

  it("按连续段分组并累计命中数，保留后端工程顺序", () => {
    const sections = groupByProject([
      group("a", "newar", "C:\\w\\newar", 2),
      group("b", "newar", "C:\\w\\newar", 1),
      group("c", "lib", "C:\\w\\lib", 3),
    ]);
    expect(sections.map((s) => [s.project, s.groups.length, s.hits])).toEqual([
      ["newar", 2, 3],
      ["lib", 1, 3],
    ]);
  });

  it("没有工程归属的组（当前范围）不产生工程段", () => {
    expect(groupByProject([{ key: "A.java", path: "A.java", hits: [hit("A.java", 1)] }])).toEqual(
      [],
    );
  });
});
