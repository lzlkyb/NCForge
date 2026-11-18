// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  accessTypeLabel,
  addWatchpoint,
  clearAllWatchpoints,
  cycleWatchpointAccess,
  getWatchpoints,
  loadWatchpoints,
  nextAccessType,
  removeWatchpoint,
  setWatchpointEnabled,
  updateWatchpoint,
  watchpointDisplay,
} from "./watchpoints";

/**
 * 每个用例换一个全新 root：store 的 `currentRoot` 是模块级状态、同 root 重复
 * `loadWatchpoints` 会早退（不断开重载），共用 root 会让上一个用例的清单漏进来。
 */
let seq = 0;
const freshRoot = () => `D:/ws-${++seq}`;

const put = (r: string, items: unknown[]) =>
  localStorage.setItem(`ncforge-watchpoints:${r.toLowerCase()}`, JSON.stringify(items));

beforeEach(() => {
  localStorage.clear();
});

describe("存取与清洗", () => {
  it("读盘时丢弃非法条目，缺省字段按 readWrite + 启用补齐", () => {
    const r = freshRoot();
    put(r, [
      { dataId: "nc.vo.A#x", accessType: "read", enabled: true },
      { dataId: "A#y" }, // 缺 accessType / enabled
      { dataId: "no-separator" }, // 无 #：丢
      { dataId: "#onlyField" }, // 类名空：丢
      { dataId: "A#" }, // 字段名空：丢
      { dataId: "A#b#c" }, // 三段：丢（适配器 split('#') 只要两段）
      "not-an-object",
      null,
      { dataId: "A#c", accessType: "READWRITE" }, // 非法访问类型：归一 readWrite
      { dataId: "A#d", condition: "  x > 0  ", hitCondition: "5" },
    ]);
    loadWatchpoints(r);
    expect(getWatchpoints()).toEqual([
      { dataId: "nc.vo.A#x", accessType: "read", enabled: true },
      { dataId: "A#y", accessType: "readWrite", enabled: true },
      { dataId: "A#c", accessType: "readWrite", enabled: true },
      { dataId: "A#d", accessType: "readWrite", enabled: true, condition: "x > 0", hitCondition: "5" },
    ]);
  });

  it("切工作区换清单；回到旧工作区恢复（同 root 重复加载不重置）", () => {
    const a = freshRoot();
    const b = freshRoot();
    loadWatchpoints(a);
    addWatchpoint({ dataId: "A#x", accessType: "read" });
    loadWatchpoints(b);
    expect(getWatchpoints()).toEqual([]);
    loadWatchpoints(a);
    expect(getWatchpoints()).toEqual([{ dataId: "A#x", accessType: "read", enabled: true }]);
    // 同一 root 再加载不该把刚加的观察点清掉
    addWatchpoint({ dataId: "A#y", accessType: "write" });
    loadWatchpoints(a);
    expect(getWatchpoints()).toHaveLength(2);
  });

  it("localStorage 损坏时降级为空清单而不是崩", () => {
    const r = freshRoot();
    localStorage.setItem(`ncforge-watchpoints:${r.toLowerCase()}`, "{ 不是 JSON");
    loadWatchpoints(r);
    expect(getWatchpoints()).toEqual([]);
  });
});

describe("增删改", () => {
  it("同一 dataId 不重复加入", () => {
    loadWatchpoints(freshRoot());
    expect(addWatchpoint({ dataId: "A#x", accessType: "read" })).toBe(true);
    expect(addWatchpoint({ dataId: "A#x", accessType: "write" })).toBe(false);
    expect(getWatchpoints()).toHaveLength(1);
  });

  it("访问类型循环 read → write → readWrite → read", () => {
    loadWatchpoints(freshRoot());
    addWatchpoint({ dataId: "A#x", accessType: "read" });
    expect(cycleWatchpointAccess("A#x")).toBe("write");
    expect(cycleWatchpointAccess("A#x")).toBe("readWrite");
    expect(cycleWatchpointAccess("A#x")).toBe("read");
    // 不存在的条目返回 null，不炸
    expect(cycleWatchpointAccess("B#z")).toBeNull();
  });

  it("nextAccessType 是纯函数（UI 悬停提示也用）", () => {
    expect(nextAccessType("read")).toBe("write");
    expect(nextAccessType("write")).toBe("readWrite");
    expect(nextAccessType("readWrite")).toBe("read");
  });

  it("改条件：空串清掉字段，undefined 不动", () => {
    loadWatchpoints(freshRoot());
    addWatchpoint({ dataId: "A#x", accessType: "read", condition: "x > 0" });
    expect(updateWatchpoint("A#x", { condition: undefined })).toBe(true);
    expect(getWatchpoints()[0].condition).toBe("x > 0");
    updateWatchpoint("A#x", { condition: "   " });
    expect(getWatchpoints()[0].condition).toBeUndefined();
    // 找不到的条目返回 false
    expect(updateWatchpoint("B#z", { condition: "x" })).toBe(false);
  });

  it("启用/禁用与删除、清空", () => {
    loadWatchpoints(freshRoot());
    addWatchpoint({ dataId: "A#x", accessType: "read" });
    addWatchpoint({ dataId: "A#y", accessType: "write" });
    setWatchpointEnabled("A#x", false);
    expect(getWatchpoints()[0].enabled).toBe(false);
    removeWatchpoint("A#x");
    expect(getWatchpoints().map((w) => w.dataId)).toEqual(["A#y"]);
    clearAllWatchpoints();
    expect(getWatchpoints()).toEqual([]);
  });

  it("改动落盘：切走再切回来还在", () => {
    const r = freshRoot();
    const other = freshRoot();
    loadWatchpoints(r);
    addWatchpoint({ dataId: "A#x", accessType: "read", condition: "x > 0" });
    loadWatchpoints(other);
    loadWatchpoints(r);
    expect(getWatchpoints()).toEqual([
      { dataId: "A#x", accessType: "read", enabled: true, condition: "x > 0" },
    ]);
  });
});

describe("展示", () => {
  it("类名取简单名，字段原样", () => {
    expect(watchpointDisplay("nc.ui.pubapp.Caps#total")).toBe("Caps.total");
    expect(watchpointDisplay("String#value")).toBe("String.value");
    expect(accessTypeLabel("read")).toBe("读");
    expect(accessTypeLabel("write")).toBe("写");
    expect(accessTypeLabel("readWrite")).toBe("读写");
  });
});
