import { beforeEach, describe, expect, it } from "vitest";
import { editSpots, noteEdit, previousEditSpot, resetEditSpots } from "./editHistory";

/**
 * 「上一次编辑位置」（Ctrl+Shift+Backspace）。
 *
 * 两条容易写错的地方：同一位置连续输入不能记一百条；连点两次不能原地打转。
 */
describe("editHistory", () => {
  beforeEach(() => resetEditSpots());

  it("同一位置连续输入只记一条", () => {
    noteEdit("a\\A.java", 10);
    noteEdit("a\\A.java", 10);
    noteEdit("a\\A.java", 10);
    expect(editSpots()).toHaveLength(1);
  });

  it("路径大小写与斜杠方向不影响去重", () => {
    noteEdit("a\\A.java", 10);
    noteEdit("a/A.java", 10);
    expect(editSpots()).toHaveLength(1);
  });

  it("换了行就是新的一条", () => {
    noteEdit("a\\A.java", 10);
    noteEdit("a\\A.java", 11);
    expect(editSpots()).toHaveLength(2);
  });

  it("取上一步时出栈：连点两次回到更早的位置，不原地打转", () => {
    noteEdit("a\\A.java", 3);
    noteEdit("a\\A.java", 20);
    noteEdit("b\\B.java", 5);

    // 当前在 b:5（刚打完字的那一处自己不算"上一步"）
    expect(previousEditSpot({ path: "b\\B.java", line: 5 })).toMatchObject({ path: "a\\A.java", line: 20 });
    expect(previousEditSpot({ path: "a\\A.java", line: 20 })).toMatchObject({ path: "a\\A.java", line: 3 });
    expect(previousEditSpot({ path: "a\\A.java", line: 3 })).toBeNull();
  });

  it("与当前行相邻（差 1 行）也不跳：视觉上等于没动，且那条已被丢弃", () => {
    noteEdit("a\\A.java", 10);
    expect(previousEditSpot({ path: "a\\A.java", line: 11 })).toBeNull();
    // 被跳过的那条已出栈，不会留在下一次再被问到
    expect(editSpots()).toHaveLength(0);

    noteEdit("a\\A.java", 10);
    expect(previousEditSpot({ path: "a\\A.java", line: 12 })).toMatchObject({ line: 10 });
  });

  it("没有当前位置时直接给栈顶", () => {
    noteEdit("a\\A.java", 7);
    expect(previousEditSpot(null)).toMatchObject({ line: 7 });
  });

  it("上限 50 条：只留最近的", () => {
    for (let i = 1; i <= 60; i += 1) noteEdit("a\\A.java", i);
    expect(editSpots()).toHaveLength(50);
    expect(editSpots()[0].line).toBe(11);
    expect(editSpots()[49].line).toBe(60);
  });
});
