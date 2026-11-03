// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { recentCommandIds, recordCommandUse } from "./commandUsage";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

beforeEach(() => {
  localStorage.clear();
});

describe("命令使用记录", () => {
  it("刚用过的命令排前面，次数相同时新的优先", () => {
    recordCommandUse("a", NOW - 2 * DAY);
    recordCommandUse("b", NOW - DAY);
    recordCommandUse("b", NOW - DAY);
    expect(recentCommandIds(NOW)).toEqual(["b", "a"]);
  });

  it("老习惯会被新近度压下去（60 天前用 10 次不如今天用 1 次）", () => {
    for (let i = 0; i < 10; i++) recordCommandUse("old", NOW - 60 * DAY);
    recordCommandUse("fresh", NOW);
    expect(recentCommandIds(NOW)[0]).toBe("fresh");
  });

  it("limit 生效，存储损坏时返回空而不是抛错", () => {
    recordCommandUse("a", NOW);
    recordCommandUse("b", NOW);
    expect(recentCommandIds(NOW, 1)).toHaveLength(1);
    localStorage.setItem("ncforge-cmd-usage", "{not json");
    expect(recentCommandIds(NOW)).toEqual([]);
  });
});
