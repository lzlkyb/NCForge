import { describe, expect, it } from "vitest";
import { computeChanged } from "./changedLines";
import { locateBlock, revertEdit } from "./changedLinesRestore";

/**
 * P0-6 回归：浮层非模态，用户可以在打开浮层后继续编辑。
 * 还原时必须按「当前模型重算的快照」重定位，不能拿旧 block 的行号盲写。
 */
const base = "a\nb\nc\nd\n";
const changed = "a\nB\nc\nd\n";

describe("locateBlock", () => {
  it("块前插一行：能重定位到新行号，不会改错无辜的一行", () => {
    const old = computeChanged(base, changed).blocks[0];
    expect(old.startLine).toBe(2);
    const now = "x\na\nB\nc\nd\n";
    const fresh = computeChanged(base, now);
    const located = locateBlock(old, fresh);
    expect(located).not.toBeNull();
    expect(located!.startLine).toBe(3);
    const edit = revertEdit(located!, now.split("\n"));
    expect(edit.startLine).toBe(3);
    expect(edit.text).toBe("b");
  });

  it("块后插行：指纹不含新侧行号，仍能定位", () => {
    const old = computeChanged(base, changed).blocks[0];
    const fresh = computeChanged(base, "a\nB\nc\nd\ny\n");
    expect(locateBlock(old, fresh)?.startLine).toBe(2);
  });

  it("块内容被改过：匹配不上返回 null，调用方必须拒绝盲写", () => {
    const old = computeChanged(base, changed).blocks[0];
    const fresh = computeChanged(base, "a\nB2\nc\nd\n");
    expect(locateBlock(old, fresh)).toBeNull();
  });

  it("基线切换后同名块不存在时也返回 null", () => {
    const old = computeChanged(base, changed).blocks[0];
    expect(locateBlock(old, computeChanged("a\nB\nc\nd\n", "a\nB\nc\nd\n"))).toBeNull();
  });
});
