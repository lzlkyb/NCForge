import { describe, expect, it } from "vitest";
import { formatAbsoluteTime, formatHistoryTime } from "./historyFormat";

describe("formatHistoryTime", () => {
  it("刚刚：30 秒前", () => {
    const now = new Date(2026, 10, 1, 12, 0, 0).getTime();
    const ts = now - 30_000;
    expect(formatHistoryTime(ts, now).label).toBe("刚刚");
  });

  it("N 分钟前", () => {
    const now = new Date(2026, 10, 1, 12, 0, 0).getTime();
    const ts = now - 12 * 60_000;
    expect(formatHistoryTime(ts, now).label).toBe("12 分钟前");
  });

  it("N 小时前", () => {
    const now = new Date(2026, 10, 1, 12, 0, 0).getTime();
    const ts = now - 3 * 3600_000;
    expect(formatHistoryTime(ts, now).label).toBe("3 小时前");
  });

  it("N 天前", () => {
    const now = new Date(2026, 10, 1, 12, 0, 0).getTime();
    const ts = now - 2 * 24 * 3600_000;
    expect(formatHistoryTime(ts, now).label).toBe("2 天前");
  });

  it("title 是绝对时间（本地时区，补零）", () => {
    const ts = new Date(2026, 0, 5, 9, 7, 3).getTime();
    expect(formatAbsoluteTime(ts)).toBe("2026-01-05 09:07:03");
    const { title } = formatHistoryTime(ts, ts + 3600_000);
    expect(title).toBe("2026-01-05 09:07:03");
  });

  it("相对与绝对都给：title 恒为绝对时间", () => {
    const now = new Date(2026, 10, 1, 12, 0, 0).getTime();
    const { label, title } = formatHistoryTime(now - 90_000, now);
    expect(label).toBe("1 分钟前");
    expect(title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
