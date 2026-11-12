import { describe, expect, it } from "vitest";
import { emptyStream, reduceStream } from "./svnStream";
import type { ChangeItem, ScanUnit } from "./svn";

const unit = (epoch: number, module: string, ...items: ChangeItem[]): ScanUnit => ({ epoch, module, items });
const item = (name: string, module: string): ChangeItem => ({
  path: `C:/work/${module}/${name}.java`,
  rel: `${module}/${name}.java`,
  module,
  mtimeMs: 1,
  letter: "M",
  revision: 1,
  status: "modified",
  isDir: false,
  ignored: false,
});

describe("流式上屏的 reducer", () => {
  it("同一纪元的单元逐批累加", () => {
    let s = reduceStream(emptyStream, { type: "unit", unit: unit(5, "pu", item("A", "pu")), lastResultEpoch: 0 });
    s = reduceStream(s, { type: "unit", unit: unit(5, "pu", item("B", "pu")), lastResultEpoch: 0 });
    s = reduceStream(s, { type: "unit", unit: unit(5, "ic", item("C", "ic")), lastResultEpoch: 0 });
    expect(s.epoch).toBe(5);
    expect(s.view?.groups.map(g => g.module)).toEqual(["pu", "ic"]);
    expect(s.view?.groups[0].items.map(it => it.rel)).toEqual(["pu/A.java", "pu/B.java"]);
    expect(s.view?.shown).toBe(3);
  });

  it("比已应用结果旧的纪元一律丢弃", () => {
    const stale = reduceStream(emptyStream, { type: "unit", unit: unit(3, "pu", item("A", "pu")), lastResultEpoch: 4 });
    expect(stale).toBe(emptyStream);
    // 已经在累积第 6 轮时，第 4 轮的残余也不许掺进来
    const live = reduceStream(emptyStream, { type: "unit", unit: unit(6, "pu", item("A", "pu")), lastResultEpoch: 0 });
    expect(reduceStream(live, { type: "unit", unit: unit(4, "ic", item("B", "ic")), lastResultEpoch: 6 })).toBe(live);
  });
  it("换纪元重新开始，不把两轮扫的条目缝在一起", () => {
    const first = reduceStream(emptyStream, { type: "unit", unit: unit(2, "pu", item("A", "pu")), lastResultEpoch: 0 });
    const second = reduceStream(first, { type: "unit", unit: unit(3, "ic", item("B", "ic")), lastResultEpoch: 0 });
    expect(second.epoch).toBe(3);
    expect(second.view?.groups.map(g => g.module)).toEqual(["ic"]);
    expect(second.view?.total).toBe(1);
  });

  it("最终结果到达后清空，之后只认更新的纪元", () => {
    const streamed = reduceStream(emptyStream, { type: "unit", unit: unit(7, "pu", item("A", "pu")), lastResultEpoch: 0 });
    const cleared = reduceStream(streamed, { type: "reset" });
    expect(cleared).toBe(emptyStream);
    // 清空之后同纪元的迟到事件不再接受（那一轮已经出结论了）
    expect(reduceStream(cleared, { type: "unit", unit: unit(7, "pu", item("A", "pu")), lastResultEpoch: 7 })).toBe(emptyStream);
  });
});
