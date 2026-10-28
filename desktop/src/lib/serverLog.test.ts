import { describe, expect, it } from "vitest";
import {
  appendChunk,
  countLevels,
  emptyLogState,
  filterLines,
  formatBytes,
  formatUptime,
  parseLine,
} from "./serverLog";

describe("parseLine", () => {
  it("拆出时间、线程、级别与 logger", () => {
    const line = parseLine("2026-10-28 09:31:02,123 [main] INFO  nc.bs.framework.server.Server - 启动完成", 1);
    expect(line.time).toBe("09:31:02");
    expect(line.thread).toBe("main");
    expect(line.level).toBe("info");
    expect(line.logger).toBe("nc.bs.framework.server.Server");
    expect(line.text).toBe("启动完成");
    expect(line.stack).toBe(false);
  });

  it("没有日期也能解析（NC 只打时间的格式）", () => {
    const line = parseLine("09:31:04 [http-80-1] WARN  缓存命中率偏低", 2);
    expect(line.time).toBe("09:31:04");
    expect(line.thread).toBe("http-80-1");
    expect(line.level).toBe("warn");
    expect(line.text).toBe("缓存命中率偏低");
  });

  it("ERROR 与 FATAL 都归为 error", () => {
    expect(parseLine("ERROR 模块加载失败", 3).level).toBe("error");
    expect(parseLine("FATAL 数据库连不上", 4).level).toBe("error");
  });

  it("异常栈的一行不算新日志（没有时间/线程/级别）", () => {
    const line = parseLine("    at nc.bs.framework.server.ModuleLoader.load(ModuleLoader.java:218)", 5);
    expect(line.stack).toBe(true);
    expect(line.text).toContain("ModuleLoader.java:218");
  });

  it("普通句子不会被误切成 logger", () => {
    // logger 必须无空格且含点；这句含中文与空格，整段留在 text 里
    const line = parseLine("INFO 加载模块 gl 已完成", 6);
    expect(line.logger).toBe("");
    expect(line.text).toBe("加载模块 gl 已完成");
  });
});

describe("appendChunk", () => {
  it("末尾半行留到下一块，不会被腰斩成两条", () => {
    const a = appendChunk(emptyLogState(), "INFO 第一行\nINFO 第二行");
    expect(a.lines).toHaveLength(1);
    expect(a.pending).toBe("INFO 第二行");

    const b = appendChunk(a, "结束\n");
    expect(b.lines).toHaveLength(2);
    expect(b.lines[1].text).toBe("第二行结束");
    expect(b.pending).toBe("");
  });

  it("空块不改变状态引用（避免无谓重渲染）", () => {
    const s = emptyLogState();
    expect(appendChunk(s, "")).toBe(s);
  });

  it("超过上限时丢最旧的，id 继续递增", () => {
    let s = emptyLogState();
    for (let i = 0; i < 10; i++) s = appendChunk(s, `INFO 第 ${i} 行\n`, 5);
    expect(s.lines).toHaveLength(5);
    expect(s.lines[4].text).toBe("第 9 行");
    expect(s.nextId).toBe(11);
  });

  it("半行超长时强制成行，pending 不会无限涨", () => {
    const big = "x".repeat(5000);
    const s = appendChunk(emptyLogState(), `INFO ${big}`);
    expect(s.pending).toBe("");
    expect(s.lines).toHaveLength(1);
  });
});

describe("filterLines", () => {
  const state = appendChunk(
    emptyLogState(),
    [
      "INFO 正常一行",
      "WARN 警告一行",
      "ERROR 出错了一行",
      "    at foo.Bar.baz(Bar.java:10)",
      "    at foo.Bar.qux(Bar.java:20)",
      "INFO 收尾",
      "",
    ].join("\n"),
  );

  it("只看错误时，异常栈跟着错误行一起显示", () => {
    const out = filterLines(state.lines, "error", "");
    expect(out.map((l) => l.stack)).toEqual([false, true, true]);
    expect(out[0].text).toBe("出错了一行");
  });

  it("关键字匹配消息正文", () => {
    const out = filterLines(state.lines, "all", "警告");
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe("warn");
  });

  it("关键字匹配线程名（大小写不敏感）", () => {
    const s = appendChunk(emptyLogState(), "[HTTP-80-9] INFO NPE\n");
    expect(filterLines(s.lines, "all", "http-80")).toHaveLength(1);
  });

  it("无过滤条件时原样返回（不复制数组）", () => {
    expect(filterLines(state.lines, "all", "  ")).toBe(state.lines);
  });
});

describe("计数与格式化", () => {
  it("按级别计数", () => {
    const s = appendChunk(emptyLogState(), "INFO a\nWARN b\nERROR c\nINFO d\n");
    expect(countLevels(s.lines)).toEqual({ all: 4, warn: 1, error: 1 });
  });

  it("字节与时长格式", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatUptime(65_000)).toBe("01:05");
    expect(formatUptime(3_725_000)).toBe("1:02:05");
  });
});
