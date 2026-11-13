import { beforeEach, describe, expect, it } from "vitest";
import { navLook, navLookAt, navCommit, recordNavJump, navSize, pushNav, resetNav, swapGroupNavigation, mergeGroupNavigation } from "./navHistory";
import { getSession, setSession, type TabMeta } from "./workspaceSession";
import { emptyEditorGroups, selectGroupFile } from "./editorGroups";

beforeEach(() => { resetNav(); setSession({ tabs: [], editorGroups: emptyEditorGroups() }); });

/** 真实调用方是「先打开、成功了才 commit」；这里把两步连起来，保持用例读起来像以前的 navBack。 */
const back = () => { const step = navLook(-1); if (!step) return null; navCommit(step); return step.point; };
const forward = () => { const step = navLook(1); if (!step) return null; navCommit(step); return step.point; };
const at = (index: number) => { const step = navLookAt(index); if (!step) return null; navCommit(step); return step.point; };

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
    expect(back()?.path).toBe("B.java");
    expect(back()?.path).toBe("A.java");
    expect(forward()?.path).toBe("B.java");
  });

  it("两头都到头就返回 null，不循环", () => {
    pushNav({ path: "A.java", line: 1 });
    expect(back()).toBeNull();
    expect(forward()).toBeNull();
  });

  it("后退之后又跳新地方，前进那一支作废（浏览器语义）", () => {
    pushNav({ path: "A.java", line: 1 });
    pushNav({ path: "B.java", line: 2 });
    pushNav({ path: "C.java", line: 3 });
    back();
    pushNav({ path: "D.java", line: 4 });
    expect(navSize()).toBe(3);
    expect(forward()).toBeNull();
  });

  it("超过上限丢掉最老的", () => {
    for (let i = 0; i < 70; i++) pushNav({ path: `F${i}.java`, line: i });
    expect(navSize()).toBe(60);
    // 能从最后一路退回去，但退不到最早的
    for (let i = 0; i < 60; i++) back();
    expect(back()).toBeNull();
  });

  it("jdt 目标与同名磁盘文件算两个点", () => {
    pushNav({ path: "jdt://Contents/x.class", line: 1, jdt: true });
    pushNav({ path: "jdt://Contents/x.class", line: 1 });
    expect(navSize()).toBe(2);
  });

  it("目标没打开就不落游标：文件被删时后退不跳格", () => {
    pushNav({ path: "A.java", line: 1 });
    pushNav({ path: "B.java", line: 2 });
    pushNav({ path: "C.java", line: 3 });
    const step = navLook(-1)!;
    expect(step.point.path).toBe("B.java");
    // 调用方打开 B 失败 → 不 commit。再按一次后退必须还是同一个目标，
    // 不然「白跳一格」直接落在 A 上，用户以为 B 从来不在历史里。
    expect(navLook(-1)!.point.path).toBe("B.java");
    navCommit(step);
    expect(navLook(-1)!.point.path).toBe("A.java");
  });
});


it("跳到任一历史位置时保留前进分支与列号", () => {
  resetNav();
  const start = { path: "A.java", line: 10, column: 8, symbol: "run()" };
  const middle = { path: "B.java", line: 20 };
  const end = { path: "C.java", line: 30 };
  recordNavJump(start, middle);
  recordNavJump(middle, end);
  expect(at(0)).toEqual(start);
  expect(forward()).toEqual(middle);
  expect(at(2)).toEqual(end);
  expect(at(2)).toBeNull();
});

it("左右组各自后退前进，交换及合并导航保留当前组位置", () => {
  setSession({ tabs: ["A.java", "B.java"].map(path => ({ path }) as TabMeta), editorGroups: { ...emptyEditorGroups(), left: ["A.java"], leftActive: "A.java" } });
  pushNav({ path: "A.java", line: 1 }); pushNav({ path: "A.java", line: 8 });
  setSession({ editorGroups: old => selectGroupFile(old!, "right", "B.java") });
  pushNav({ path: "B.java", line: 3 }); pushNav({ path: "B.java", line: 20 });
  expect(back()).toEqual({ path: "B.java", line: 3 });
  setSession({ editorGroups: old => ({ ...old!, focused: "left" }) });
  expect(back()).toEqual({ path: "A.java", line: 1 });
  swapGroupNavigation();
  expect(forward()).toEqual({ path: "B.java", line: 20 });
  mergeGroupNavigation("left");
  expect(back()).toEqual({ path: "B.java", line: 3 });
  expect(back()).toEqual({ path: "A.java", line: 1 });
  expect(getSession().editorGroups?.focused).toBe("left");
});
