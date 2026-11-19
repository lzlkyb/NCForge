// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "ncforge-sql-assist-stats";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-18T10:00:00Z")); vi.resetModules(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SQL 补全质量统计", () => {
  it("曝光与接受分源计数，汇总按曝光降序给出接受率", async () => {
    const s = await import("./sqlAssistStats");
    s.recordAssistCall("auto"); s.recordAssistCall("invoke");
    s.recordAssistOffers([{ ncforgeSource: "table" }, { ncforgeSource: "table" }, { ncforgeSource: "keyword" }, {}]);
    s.recordAssistAccept("table");
    const snap = s.assistStatsSnapshot();
    expect(snap.calls).toEqual({ auto: 1, invoke: 1 });
    expect(snap.sources.table).toEqual({ offers: 2, accepts: 1 });
    expect(snap.sources.keyword).toEqual({ offers: 1, accepts: 0 });
    const { sources } = s.summarizeAssistStats(snap);
    expect(sources.map(row => row.source)).toEqual(["table", "keyword"]);
    expect(sources[0].rate).toBe(0.5); expect(sources[1].rate).toBe(0);
  });

  it("反例：没有曝光的接受不入账，接受数不允许超过曝光数", async () => {
    const s = await import("./sqlAssistStats");
    s.recordAssistAccept("template");
    expect(s.assistStatsSnapshot().sources.template).toBeUndefined();
    s.recordAssistOffers([{ ncforgeSource: "template" }]);
    s.recordAssistAccept("template"); s.recordAssistAccept("template");
    expect(s.assistStatsSnapshot().sources.template).toEqual({ offers: 1, accepts: 1 });
    const { sources } = s.summarizeAssistStats(s.assistStatsSnapshot());
    expect(sources[0].rate).toBeLessThanOrEqual(1);
  });

  it("反例：未知建议源与无标签条目都不计数", async () => {
    const s = await import("./sqlAssistStats");
    s.recordAssistOffers([{ ncforgeSource: "bogus" }, { ncforgeSource: "" }, {}]);
    s.recordAssistAccept("bogus");
    expect(s.assistStatsSnapshot().sources).toEqual({});
  });

  it("early 等待按预算分档，超时只在真超时时计数", async () => {
    const s = await import("./sqlAssistStats");
    s.recordAssistEarly(120, false); s.recordAssistEarly(120, true);
    s.recordAssistEarly(500, false); s.recordAssistEarly(37, true);
    const snap = s.assistStatsSnapshot();
    expect(snap.early.auto).toEqual({ waits: 3, timeouts: 2 });
    expect(snap.early.invoke).toEqual({ waits: 1, timeouts: 0 });
    const { early } = s.summarizeAssistStats(snap);
    expect(early[0].okRate).toBeCloseTo(1 / 3); expect(early[1].okRate).toBe(1);
  });

  it("关闭后立即停止记录，清空保留开关状态", async () => {
    const s = await import("./sqlAssistStats");
    s.recordAssistCall("auto");
    expect(s.setAssistStatsEnabled(false)).toBe(true);
    s.recordAssistCall("auto"); s.recordAssistOffers([{ ncforgeSource: "table" }]); s.recordAssistAccept("table"); s.recordAssistEarly(120, true);
    expect(s.assistStatsSnapshot().calls.auto).toBe(1);
    expect(s.assistStatsSnapshot().sources).toEqual({});
    expect(s.clearAssistStats()).toBe(true);
    expect(s.getAssistStatsEnabled()).toBe(false);
    expect(s.assistStatsSnapshot().calls).toEqual({ auto: 0, invoke: 0 });
    s.setAssistStatsEnabled(true); s.recordAssistCall("invoke");
    expect(s.assistStatsSnapshot().calls.invoke).toBe(1);
  });

  it("防抖落盘，重启后读回；存储不含 SQL 正文与对象名", async () => {
    const s = await import("./sqlAssistStats");
    s.recordAssistOffers([{ ncforgeSource: "column" }]); s.recordAssistAccept("column");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    vi.advanceTimersByTime(400);
    const raw = localStorage.getItem(STORAGE_KEY)!;
    expect(raw).toContain("column"); expect(raw).not.toContain("select");
    vi.resetModules();
    const again = await import("./sqlAssistStats");
    expect(again.assistStatsSnapshot().sources.column).toEqual({ offers: 1, accepts: 1 });
  });

  it("反例：损坏或伪造的存储被纠正——超时不超等待、接受不超曝光、未知源丢弃", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, enabled: true, calls: { auto: -3, invoke: "x" },
      early: { auto: { waits: 2, timeouts: 9 }, invoke: { waits: 1, timeouts: 0 } },
      sources: { table: { offers: 1, accepts: 5 }, bogus: { offers: 9, accepts: 9 }, keyword: { offers: 0, accepts: 0 } },
    }));
    const s = await import("./sqlAssistStats");
    const snap = s.assistStatsSnapshot();
    expect(snap.calls).toEqual({ auto: 0, invoke: 0 });
    expect(snap.early.auto).toEqual({ waits: 2, timeouts: 2 });
    expect(snap.sources.table).toEqual({ offers: 1, accepts: 1 });
    expect(snap.sources.bogus).toBeUndefined(); expect(snap.sources.keyword).toBeUndefined();
    localStorage.setItem(STORAGE_KEY, "{broken");
    vi.resetModules();
    const fresh = await import("./sqlAssistStats");
    expect(fresh.assistStatsSnapshot().calls).toEqual({ auto: 0, invoke: 0 });
  });

  it("计数封顶后不再增长，订阅随发布通知", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, enabled: true, calls: { auto: 1000000, invoke: 0 },
      early: { auto: { waits: 1000000, timeouts: 1000000 }, invoke: { waits: 0, timeouts: 0 } },
      sources: { table: { offers: 1000000, accepts: 999999 } },
    }));
    const s = await import("./sqlAssistStats");
    const notify = vi.fn(), off = s.subscribeAssistStats(notify);
    s.recordAssistCall("auto"); s.recordAssistEarly(120, true);
    s.recordAssistOffers([{ ncforgeSource: "table" }]); s.recordAssistAccept("table");
    const snap = s.assistStatsSnapshot();
    expect(snap.calls.auto).toBe(1000000);
    expect(snap.early.auto).toEqual({ waits: 1000000, timeouts: 1000000 });
    expect(snap.sources.table).toEqual({ offers: 1000000, accepts: 1000000 });
    expect(notify).toHaveBeenCalled(); off();
  });

  it("空快照的达标率是 100% 而不是除零", async () => {
    const s = await import("./sqlAssistStats");
    const { early, sources } = s.summarizeAssistStats(s.assistStatsSnapshot());
    expect(early.every(row => row.okRate === 1 && row.waits === 0)).toBe(true);
    expect(sources).toEqual([]);
  });

  it("快照引用稳定：store 不变返回同一对象，变更后换新（useSyncExternalStore 契约）", async () => {
    const s = await import("./sqlAssistStats");
    const first = s.assistStatsSnapshot();
    expect(s.assistStatsSnapshot()).toBe(first);
    s.recordAssistCall("auto");
    const second = s.assistStatsSnapshot();
    expect(second).not.toBe(first);
    expect(s.assistStatsSnapshot()).toBe(second);
  });
});