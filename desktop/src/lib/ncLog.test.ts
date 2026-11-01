import { describe, expect, it } from "vitest";
import {
  entryKey,
  entryTitle,
  formatSize,
  logStamp,
  severityMeta,
  sinceOf,
  type LogEntry,
} from "./ncLog";

const base: LogEntry = {
  logger: "nclog",
  file: "nc-log.log",
  lineNo: 7442,
  ts: "2026-10-30 16:57:33",
  callId: null,
  thread: null,
  userId: null,
  remoteCall: null,
  level: "ERROR",
  msg: "",
  stack: [],
  stackTruncated: false,
  costMs: null,
  rowCount: null,
  verdict: null,
};

describe("日志时间边界", () => {
  it("按本地墙上时间格式化，定宽补零", () => {
    expect(logStamp(new Date(2026, 0, 5, 9, 8, 7))).toBe("2026-01-05 09:08:07");
    expect(logStamp(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31 23:59:59");
  });

  it("不限时间不产生边界", () => {
    expect(sinceOf("none")).toBeNull();
  });

  it("今天从零点算起", () => {
    expect(sinceOf("today", new Date(2026, 10, 1, 15, 30, 5))).toBe("2026-11-01 00:00:00");
  });

  it("最近一小时与最近七天按毫秒回退", () => {
    const now = new Date(2026, 10, 1, 15, 0, 0);
    expect(sinceOf("1h", now)).toBe("2026-11-01 14:00:00");
    expect(sinceOf("7d", now)).toBe("2026-10-25 15:00:00");
  });
});

describe("条目展示", () => {
  it("有结论时标题用结论", () => {
    const entry = {
      ...base,
      msg: "ORA-00942: 表或视图不存在",
      verdict: {
        rule: "ora-00942",
        severity: "error" as const,
        title: "表或视图不存在：bi_conf_cache",
        cause: "c",
        action: "a",
        jump: null,
      },
    };
    expect(entryTitle(entry)).toBe("表或视图不存在：bi_conf_cache");
  });

  it("没有结论时退回消息首行，再退回堆栈", () => {
    expect(entryTitle({ ...base, msg: "第一行\n第二行" })).toBe("第一行");
    // 堆栈行去掉前导 tab：行标题里带缩进会显得怪，且浪费横向空间
    expect(entryTitle({ ...base, msg: "  ", stack: ["\tat A.b(C.java:1)"] })).toBe(
      "at A.b(C.java:1)",
    );
    expect(entryTitle(base)).toBe("(空消息)");
  });

  it("标识用文件名加行号，不含目录", () => {
    // 含目录会让「换了 HOME 但文件名相同」的两条互相覆盖
    expect(entryKey(base)).toBe("nc-log.log:7442");
  });

  it("大小按 B/KB/MB 折算", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(1_879_872)).toBe("1.8 MB");
  });

  it("三档严重性各有图标与文案", () => {
    expect(severityMeta("error").icon).toBe("alertTriangle");
    expect(severityMeta("slow").icon).toBe("clock");
    expect(severityMeta("warn").label).toBe("警告");
  });
});
