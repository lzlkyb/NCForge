import { beforeEach, describe, expect, it } from "vitest";
import { navAt, recordNavJump, navBack, navForward, navSize, pushNav, resetNav } from "./navHistory";

beforeEach(() => resetNav());

describe("导航历史", () => {
  it("同一位置连记两次只留一个（连点同一条引用不该出现两个「上一处」）", () => {
    pushNav({ path: "A.java", line: 10 });
    pushNav({ path: "a.JAVA", line: 10 });
    expect(navSize()).toBe(1);
  });

  it("后退 / 前进按顺序走", () => {
    pushNav({ path: "A.java", line: 1 });
    pushNav({ path: "B.java", line: 2 });
    pushNav({ path: "C.java", line: 3 });
    expect(navBack()?.path).toBe("B.java");
    expect(navBack()?.path).toBe("A.java");
    expect(navForward()?.path).toBe("B.java");
  });

  it("两头都到头就返回 null，不循环", () => {
    pushNav({ path: "A.java", line: 1 });
    expect(navBack()).toBeNull();
    expect(navForward()).toBeNull();
  });

  it("后退之后又跳新地方，前进那一支作废（浏览器语义）", () => {
    pushNav({ path: "A.java", line: 1 });
    pushNav({ path: "B.java", line: 2 });
    pushNav({ path: "C.java", line: 3 });
    navBack();
    pushNav({ path: "D.java", line: 4 });
    expect(navSize()).toBe(3);
    expect(navForward()).toBeNull();
  });

  it("超过上限丢掉最老的", () => {
    for (let i = 0; i < 70; i++) pushNav({ path: `F${i}.java`, line: i });
    expect(navSize()).toBe(60);
    // 能从最后一路退回去，但退不到最早的
    for (let i = 0; i < 60; i++) navBack();
    expect(navBack()).toBeNull();
  });

  it("jdt 目标与同名磁盘文件算两个点", () => {
    pushNav({ path: "jdt://Contents/x.class", line: 1, jdt: true });
    pushNav({ path: "jdt://Contents/x.class", line: 1 });
    expect(navSize()).toBe(2);
  });
});


it("跳到任一历史位置时保留前进分支与列号", () => {
  resetNav();
  const start = { path: "A.java", line: 10, column: 8, symbol: "run()" };
  const middle = { path: "B.java", line: 20 };
  const end = { path: "C.java", line: 30 };
  recordNavJump(start, middle);
  recordNavJump(middle, end);
  expect(navAt(0)).toEqual(start);
  expect(navForward()).toEqual(middle);
  expect(navAt(2)).toEqual(end);
  expect(navAt(2)).toBeNull();
});
