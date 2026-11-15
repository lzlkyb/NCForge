import { test } from "node:test";
import assert from "node:assert/strict";

import { CHANNELS, buildRows, formatTable, parseBootLog, parseEcjPerf, splitIndexRound, summarize, verdictOf } from "./perf-baseline.mjs";

test("清单：id 唯一、五指标都在、目标与方案 §4.2 一致", () => {
  const ids = CHANNELS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const target = Object.fromEntries(CHANNELS.map((c) => [c.id, c.target]));
  assert.equal(target.compile, 400);
  assert.equal(target.index, 60000);
  assert.equal(target.boot, 2000);
  assert.equal(target.completion, 150);
  assert.equal(target.incremental, 1500);
  // 大文件两项只作代价基线：方案 §4.3 没给数字，编一个目标出来就是自欺
  assert.equal(target.bigfile, null);
  assert.equal(target["bigfile-completion"], null);
});

test("判定是严格小于：正好等于目标算超标", () => {
  assert.equal(verdictOf(399, 400), "达标");
  assert.equal(verdictOf(400, 400), "超标");
  assert.equal(verdictOf(0, 400), "达标");
  assert.equal(verdictOf(null, 400), "未测");
  assert.equal(verdictOf(undefined, 400), "未测");
  assert.equal(verdictOf(Number.NaN, 400), "未测");
  assert.equal(verdictOf(12345, null), "基线");
});

test("PERF 行解析：正常出五个数", () => {
  const r = parseEcjPerf("running 1 test\nPERF single-file-compile n=20 min=91 p50=118 max=402 mean=140\n");
  assert.deepEqual(r, { ok: true, n: 20, min: 91, p50: 118, max: 402, mean: 140 });
});

test("PERF 行解析：跳过 / 编译失败 / 没输出，三种原因分开", () => {
  const skipped = parseEcjPerf("跳过：本机没有 java / ecj / 桥 jar");
  assert.equal(skipped.ok, false);
  assert.match(skipped.reason, /java/);

  const failed = parseEcjPerf("PERF single-file-compile failed: Some((false, \"boom\"))");
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /编译失败/);

  const none = parseEcjPerf("error: could not compile");
  assert.equal(none.ok, false);
  assert.match(none.reason, /没拿到 PERF 行/);
  assert.equal(parseEcjPerf(null).ok, false);
});

test("编译失败绝不能变成一个耗时数字", () => {
  const rows = buildRows({ ecj: parseEcjPerf("PERF single-file-compile failed: Some((false, \"x\"))") });
  const row = rows.find((r) => r.id === "compile");
  assert.equal(row.value, null);
  assert.equal(row.verdict, "未测");
  assert.match(row.note, /编译失败/);
});

test("冷启动日志：多次启动取最后一次，分段一并带出", () => {
  const log = [
    "冷启动：进程启动 → 前端首帧 3100 ms（其中前端自报 800 ms）",
    "启动分段：进程启动 → tree 900 ms（其中前端自报 300 ms）",
    "冷启动：进程启动 → 前端首帧 1800 ms（其中前端自报 700 ms）",
    "启动分段：进程启动 → index 2400 ms（其中前端自报 1200 ms）",
  ].join("\n");
  const r = parseBootLog(log);
  assert.equal(r.firstFrameMs, 1800);
  assert.equal(r.runs, 2);
  assert.deepEqual(r.stages, { tree: 900, index: 2400 });
});

test("冷启动日志：没有那一行就是 null，不编一个 0", () => {
  assert.equal(parseBootLog("INFO 别的东西"), null);
  assert.equal(parseBootLog(""), null);
  assert.equal(parseBootLog(null), null);
});

test("全部输入缺席时：每行都未测，且不抛", () => {
  const rows = buildRows();
  assert.equal(rows.length, CHANNELS.length);
  assert.ok(rows.every((r) => r.value === null));
  assert.ok(rows.every((r) => r.verdict === "未测"));
  assert.ok(rows.every((r) => r.note.length > 0), "未测也要说清楚为什么");
});

test("增量编译永远标未测：ecj 的数字不许顶替它", () => {
  const rows = buildRows({ ecj: { ok: true, n: 20, min: 90, p50: 118, max: 200, mean: 130 } });
  assert.equal(rows.find((r) => r.id === "compile").verdict, "达标");
  const inc = rows.find((r) => r.id === "incremental");
  assert.equal(inc.value, null);
  assert.equal(inc.verdict, "未测");
  assert.match(inc.note, /未接探针/);
});

test("索引拆段：把 OSGi 引导与状态推进分开（2026-11-15 实测数）", () => {
  // 真实数据：fresh 总 17792，状态跨度 4355 → 引导 13437
  const fresh = splitIndexRound({ totalMs: 17792, statuses: [{ at: 1000 }, { at: 5355 }] });
  assert.deepEqual(fresh, { total: 17792, boot: 13437, progress: 4355 });
  const warm = splitIndexRound({ totalMs: 12963, statuses: [{ at: 2000 }, { at: 6284 }] });
  assert.deepEqual(warm, { total: 12963, boot: 8679, progress: 4284 });
  // 关键结论：总耗时差 4829 ms，但状态段只差 71 ms —— 差异几乎全在引导段
  assert.equal(fresh.total - warm.total, 4829);
  assert.equal(fresh.progress - warm.progress, 71);
});

test("索引拆段：状态不足或时间戳不合理时不编数", () => {
  assert.deepEqual(splitIndexRound({ totalMs: 100, statuses: [] }), { total: 100, boot: null, progress: null });
  assert.deepEqual(splitIndexRound({ totalMs: 100, statuses: [{ at: 1 }] }), { total: 100, boot: null, progress: null });
  // 跨度大于总耗时 = 数据自相矛盾，宁可不给
  assert.deepEqual(splitIndexRound({ totalMs: 100, statuses: [{ at: 0 }, { at: 500 }] }), { total: 100, boot: null, progress: null });
  assert.deepEqual(splitIndexRound(null), { total: null, boot: null, progress: null });
});

test("索引备注不许把引导差异说成缓存收益", () => {
  const rows = buildRows({
    index: {
      fileCount: 2000,
      verdict: { firstImportMs: 17792, cacheSavesMs: 4829 },
      rounds: [
        { label: "fresh", totalMs: 17792, statuses: [{ at: 1000 }, { at: 5355 }] },
        { label: "warm", totalMs: 12963, statuses: [{ at: 2000 }, { at: 6284 }] },
      ],
    },
  });
  const note = rows.find((r) => r.id === "index").note;
  assert.match(note, /引导 13437/);
  assert.match(note, /索引 4355/);
  assert.ok(!note.includes("缓存复用节省"), "这个措辞会把 OSGi 引导的差记到索引账上");
  assert.match(note, /别当缓存收益/);
});

test("四路齐全：取数各归各的通道，不串台", () => {
  const rows = buildRows({
    ecj: { ok: true, n: 20, min: 90, p50: 118, max: 200, mean: 130 },
    gaps: {
      completion: { coldMs: 900, samples: 30, p50Ms: 42 },
      diagnosticsLatency: { bigFileMs: 3400, bigFileLines: 6003, bigFileCompletionP50Ms: 1165 },
    },
    index: { fileCount: 2000, verdict: { firstImportMs: 12792, cacheSavesMs: 53 } },
    boot: { firstFrameMs: 1800, stages: {}, runs: 1 },
  });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.compile.value, 118);
  assert.equal(by.completion.value, 42);
  assert.equal(by.index.value, 12792);
  assert.equal(by.boot.value, 1800);
  assert.equal(by.bigfile.value, 3400);
  assert.equal(by.bigfile.verdict, "基线");
  assert.equal(by.index.verdict, "达标");
  assert.equal(by.boot.verdict, "达标");
  assert.match(by.index.note, /2000 个 java/);
  assert.match(by.bigfile.note, /6003 行/);
});

test("汇总是 markdown 表格：列齐、每行列数一致、中文不歪", () => {
  const text = formatTable(buildRows({ ecj: { ok: true, n: 20, min: 90, p50: 118, max: 200, mean: 130 } }));
  const lines = text.split("\n");
  assert.equal(lines.length, CHANNELS.length + 2);
  assert.ok(lines[0].includes("指标") && lines[0].includes("判定"));
  assert.match(lines[1], /^\|-+/);
  const pipes = lines.map((l) => (l.match(/\|/g) ?? []).length);
  assert.equal(new Set(pipes).size, 1, "每行的竖线数必须相同，否则贴进文档就是坏表");
  assert.ok(lines.some((l) => l.includes("118 ms") && l.includes("达标")));
  assert.ok(lines.some((l) => l.includes("未测")));
});

test("结论把「未测」单列，不混进达标率", () => {
  const s = summarize(buildRows({ ecj: { ok: true, n: 20, min: 90, p50: 118, max: 200, mean: 130 } }));
  assert.equal(s.pass, 1);
  assert.equal(s.over, 0);
  // 两条大文件基线也没数：没数就是未测，不能因为「没有目标」就算成已建立基线
  assert.equal(s.untested, 6);
  assert.equal(s.baseline, 0);
  assert.match(s.text, /1\/1 项达标/);
  assert.match(s.text, /6 项未测/);
});

test("一个数都没有时不许说达标", () => {
  const s = summarize(buildRows());
  assert.match(s.text, /没有可判定的指标/);
  assert.ok(!s.text.includes("达标率"));
});