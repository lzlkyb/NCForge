import { describe, expect, it } from "vitest";
import { shouldLoadMore } from "./gridLoadMore";

/**
 * 「滚到底就续取」的判据。
 *
 * 三条规则各自都fail过真实场景：阈值太大会滚到底还没反应，`rowsChanged` 去掉后
 * 一次滚动连发十几次请求（`loadedAt` 还没被父组件更新），`loading` 去掉后
 * 网络慢时请求叠请求。逐个钉住。
 */
const el = (scrollTop: number, clientHeight: number, scrollHeight: number) => ({ scrollTop, clientHeight, scrollHeight });

describe("shouldLoadMore", () => {
  const base = { hasMore: true, loading: false, rowsChanged: true, margin: 96 };

  it("离底部不到一个 margin 就续取", () => {
    // 内容 1000，视口 400，滚到 504 时底部还剩 96 —— 正好在边界上
    expect(shouldLoadMore(el(504, 400, 1000), base)).toBe(true);
    expect(shouldLoadMore(el(503, 400, 1000), base)).toBe(false);
  });

  it("没有更多行 / 正在加载 / 行数没变过都不续取", () => {
    expect(shouldLoadMore(el(900, 400, 1000), { ...base, hasMore: false })).toBe(false);
    expect(shouldLoadMore(el(900, 400, 1000), { ...base, loading: true })).toBe(false);
    // 新行没到就再滚到底：父组件的 loadedAt 还没更新，发了也白发
    expect(shouldLoadMore(el(900, 400, 1000), { ...base, rowsChanged: false })).toBe(false);
  });

  it("内容比视口还短时也算看到底：第一批装不满一屏也要续，否则用户等不到第二批", () => {
    // 第一批 50 行只占 300px、视口 400px：没滚到底也早就看到底了
    expect(shouldLoadMore(el(0, 400, 300), base)).toBe(true);
  });
});
