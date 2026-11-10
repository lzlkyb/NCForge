// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { countUnreadVersions, getLastSeenVersion, markChangelogSeen, CHANGELOG_SEEN_EVENT } from "./utils";
import { groupReleaseItems, releaseText } from "./releaseReading";
beforeEach(() => localStorage.clear());
it("只提示本版，首次安装不累加旧版，未来记录不参与", () => {
  const versions = ["0.4.0", "0.3.0", "0.2.0"];
  expect(countUnreadVersions(versions, null, "v0.3.0")).toBe(1);
  expect(countUnreadVersions(versions, "0.2.0", "0.3.0")).toBe(1);
  expect(countUnreadVersions(versions, "0.3.0", "0.3.0")).toBe(0);
  expect(countUnreadVersions(versions, null, "0.1.0")).toBe(0);
});
it("看过同步消除，刷新后保留，浏览旧版不倒退；后续升级重新提醒", () => {
  const listener = vi.fn(); window.addEventListener(CHANGELOG_SEEN_EVENT, listener);
  try {
    markChangelogSeen("0.3.0");
    expect(listener).toHaveBeenCalledOnce();
    expect(countUnreadVersions(["0.3.0"], getLastSeenVersion(), "0.3.0")).toBe(0);
    markChangelogSeen("0.2.0"); expect(getLastSeenVersion()).toBe("0.3.0");
    expect(countUnreadVersions(["0.4.0", "0.3.0"], getLastSeenVersion(), "0.4.0")).toBe(1);
  } finally { window.removeEventListener(CHANGELOG_SEEN_EVENT, listener); }
});
it("按显式功能前缀分组，不猜测普通文本，正文去掉重复分类", () => {
  expect(groupReleaseItems([{label:"新增",text:"数据库｜直接改数：支持批量写回"},{label:"修复",text:"数据库｜重查更稳定：修复断连"},{label:"改进",text:"NC 开发｜热替换：减少重启"},{label:"修复",text:"普通记录"}]).map(group=>[group.label,group.items.length])).toEqual([["数据库",2],["NC 开发",1],["修复",1]]);
  expect(releaseText("数据库｜直接改数：支持批量写回")).toBe("直接改数：支持批量写回");
});
