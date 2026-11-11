import { beforeEach, describe, expect, it, vi } from "vitest";

// 时间线的三个事件源都连着 Tauri / toast，单测只关心「合并成轮」的纯逻辑。
vi.mock("./externalJavaChanges", () => ({ onExternalJavaChanged: () => () => {} }));
vi.mock("./localSaves", () => ({ onLocalSave: () => () => {} }));
vi.mock("./localHistory", () => ({ onLocalHistoryCaptured: () => () => {} }));

import { clearTimeline, getTimeline, pushTimelineEvent } from "./changeTimeline";

describe("pushTimelineEvent", () => {
  beforeEach(() => clearTimeline());

  it("同一类事件在 1.5 秒窗口内合并成一轮，文件去重", () => {
    pushTimelineEvent({ kind: "external", paths: ["a.java"], at: 1000 });
    pushTimelineEvent({ kind: "external", paths: ["a.java", "b.java"], at: 1800 });
    expect(getTimeline()).toHaveLength(1);
    expect(getTimeline()[0].paths).toEqual(["a.java", "b.java"]);
  });

  it("超过窗口或换了类型就另起一轮，最新在前", () => {
    pushTimelineEvent({ kind: "me", paths: ["a.java"], at: 1000 });
    pushTimelineEvent({ kind: "external", paths: ["b.java"], at: 1001 });
    pushTimelineEvent({ kind: "me", paths: ["c.java"], at: 5000 });
    expect(getTimeline().map((e) => e.kind)).toEqual(["me", "external", "me"]);
  });

  it("归档点合并时保留各文件的版本 id", () => {
    pushTimelineEvent({ kind: "history", paths: ["a.java"], versions: { "a.java": "v1" }, at: 1000 });
    pushTimelineEvent({ kind: "history", paths: ["b.java"], versions: { "b.java": "v2" }, at: 1200 });
    expect(getTimeline()[0].versions).toEqual({ "a.java": "v1", "b.java": "v2" });
  });

  it("最多留 200 条", () => {
    for (let i = 0; i < 210; i++) {
      pushTimelineEvent({ kind: "me", paths: [`f${i}.java`], at: i * 2000 });
    }
    expect(getTimeline()).toHaveLength(200);
  });

  it("P2 回归：窗口锚定轮起点，AI 每 0.8 秒写一次不会滚成无限大的一轮", () => {
    pushTimelineEvent({ kind: "external", paths: ["a.java"], at: 1000 });
    pushTimelineEvent({ kind: "external", paths: ["b.java"], at: 1800 });
    // 旧实现合并时会把 at 后移成 1800，这一条又被吞进同一轮，无限滚下去
    pushTimelineEvent({ kind: "external", paths: ["c.java"], at: 2600 });
    expect(getTimeline()).toHaveLength(2);
    expect(getTimeline()[0].paths).toEqual(["c.java"]);
    expect(getTimeline()[1].paths).toEqual(["a.java", "b.java"]);
    expect(getTimeline()[1].at).toBe(1000);
  });
});
