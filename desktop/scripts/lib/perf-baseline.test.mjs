import { test } from "node:test";
import assert from "node:assert/strict";

import { CHANNELS, buildRows, formatTable, indexMs, parseBootLog, parseEcjPerf, parseIncrementalPerf, parseModuleMakePerf, parseModuleNochangePerf, splitIndexRound, summarize, verdictOf } from "./perf-baseline.mjs";

test("清单：id 唯一、五指标都在、目标与方案 §4.2 一致", () => {
  const ids = CHANNELS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const target = Object.fromEntries(CHANNELS.map((c) => [c.id, c.target]));
  assert.equal(target.compile, 400);
  assert.equal(target.index, 60000);
  assert.equal(target.boot, 2000);
  assert.equal(target.completion, 150);
  assert.equal(target.incremental, 1500);
  // 大文件两项 + make 两项只作代价基线：方案没给数字，编一个目标出来就是自欺
  assert.equal(target.bigfile, null);
  assert.equal(target["bigfile-completion"], null);
  assert.equal(target["module-make"], null);
  assert.equal(target["module-nochange"], null);
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

test("增量编译：ecj 的数字不许顶替它（两条独立通道）", () => {
  // 只给 ecj、不给 incremental：incremental 必须仍未测，绝不能借用 ecj 的 p50。
  const rows = buildRows({ ecj: { ok: true, n: 20, min: 90, p50: 118, max: 200, mean: 130 } });
  assert.equal(rows.find((r) => r.id === "compile").verdict, "达标");
  const inc = rows.find((r) => r.id === "incremental");
  assert.equal(inc.value, null);
  assert.equal(inc.verdict, "未测");
  assert.match(inc.note, /--only=incremental/);
});

test("增量编译：有自己的 PERF 行就取自己的 p50", () => {
  const rows = buildRows({
    ecj: { ok: true, n: 20, min: 90, p50: 118, max: 200, mean: 130 },
    incremental: { ok: true, n: 20, files: 5, min: 300, p50: 800, max: 1200, mean: 850 },
  });
  const inc = rows.find((r) => r.id === "incremental");
  assert.equal(inc.value, 800);
  assert.equal(inc.verdict, "达标"); // 800 < 1500
  assert.match(inc.note, /5 文件/);
  // compile 仍取 ecj 的 118，不被 incremental 影响
  assert.equal(rows.find((r) => r.id === "compile").value, 118);
});

test("增量编译 PERF 行解析：正常出六个数（含 files）", () => {
  const r = parseIncrementalPerf("PERF incremental-compile n=20 files=5 min=300 p50=800 max=1200 mean=850\n");
  assert.deepEqual(r, { ok: true, n: 20, files: 5, min: 300, p50: 800, max: 1200, mean: 850 });
});

test("增量编译 PERF 行解析：跳过 / 失败 / 没输出三种分开，且不认 ecj 的行", () => {
  assert.match(parseIncrementalPerf("跳过：本机没有 java / ecj").reason, /java/);
  assert.match(parseIncrementalPerf("PERF incremental-compile failed: 2 个错误").reason, /编译失败/);
  assert.match(parseIncrementalPerf("error: could not compile").reason, /没拿到 PERF incremental-compile/);
  // 🔴 ecj 的单文件行绝不能被增量通道认走
  assert.equal(parseIncrementalPerf("PERF single-file-compile n=20 min=90 p50=118 max=200 mean=130").ok, false);
  assert.equal(parseIncrementalPerf(null).ok, false);
});

test("增量编译失败绝不变成耗时数字", () => {
  const rows = buildRows({ incremental: parseIncrementalPerf("PERF incremental-compile failed: boom") });
  const inc = rows.find((r) => r.id === "incremental");
  assert.equal(inc.value, null);
  assert.equal(inc.verdict, "未测");
  assert.match(inc.note, /编译失败/);
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

test("索引超时：guard 到点的 ~300000ms 绝不能当实测耗时（没数就是未测）", () => {
  // bench 侧 5min guard 触发后 resolve ready 让流程往下走，早期版本把
  // Date.now()-t0 直接当 totalMs 落盘 ⇒ 一个「等到放弃」的时长进了 p50 与结论表。
  const timedOut = { label: "fresh", totalMs: null, timedOut: true, elapsedMs: 300012, statuses: [{ at: 0 }, { at: 9000 }] };
  assert.equal(indexMs(timedOut), null, "超时轮必须是 null");
  assert.deepEqual(splitIndexRound(timedOut), { total: null, boot: null, progress: null });
  // 兜底：万一旧 JSON 里 timedOut 与 totalMs 同时存在，也不许出数
  assert.equal(indexMs({ totalMs: 300012, timedOut: true }), null);
  // 正常轮不受影响；没有 timedOut 字段的旧 JSON 仍按原值读
  assert.equal(indexMs({ totalMs: 17792 }), 17792);
  assert.equal(indexMs({ totalMs: 17792, timedOut: false }), 17792);
  assert.equal(indexMs(null), null);
  assert.equal(indexMs({}), null);
});

test("索引超时：整轮超时时表里是「未测」，不是 300000", () => {
  const rows = buildRows({
    index: {
      fileCount: 2000,
      verdict: { firstImportMs: null, timedOutRounds: ["fresh"] },
      rounds: [{ label: "fresh", totalMs: null, timedOut: true, elapsedMs: 300012, statuses: [{ at: 0 }, { at: 9000 }] }],
    },
  });
  const index = rows.find((r) => r.id === "index");
  assert.equal(index.value, null);
  assert.equal(index.verdict, "未测");
  assert.ok(!formatTable(rows).includes("300012"), "超时时长不许出现在结论表里");
  assert.ok(!formatTable(rows).includes("300000"));
  // 备注里的引导/索引分段也走 indexMs：超时轮不许拆出「引导 291012 + 索引 9000」
  assert.ok(!/引导 \d/.test(index.note), `超时轮不该有分段数字：${index.note}`);
  assert.match(index.note, /超时/, "超时未测要写明原因，不能只留一句通用备注");
  assert.equal(splitIndexRound({ totalMs: null, timedOut: true, elapsedMs: 300012, statuses: [{ at: 0 }, { at: 9000 }] }).boot, null);
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

test("索引备注：root 模式标明真实工程与 IProject 数", () => {
  const rows = buildRows({
    index: {
      mode: "root",
      projects: ["AppService", "medPM", "phm"],
      fileCount: 1245,
      verdict: { firstImportMs: 43299 },
      rounds: [{ label: "fresh", totalMs: 43299, statuses: [{ at: 1000 }, { at: 20519 }] }],
    },
  });
  const note = rows.find((r) => r.id === "index").note;
  assert.match(note, /真实工程 3 个 IProject/);
  assert.match(note, /1245 个 java/);
  assert.match(note, /引导 23780/);
  assert.match(note, /索引 19519/);
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
  // 四条基线通道（大文件两项 + make 两项）也没数：没数就是未测，不能因为「没有目标」就算成已建立基线
  assert.equal(s.untested, 8);
  assert.equal(s.baseline, 0);
  assert.match(s.text, /1\/1 项达标/);
  assert.match(s.text, /8 项未测/);
});

test("一个数都没有时不许说达标", () => {
  const s = summarize(buildRows());
  assert.match(s.text, /没有可判定的指标/);
  assert.ok(!s.text.includes("达标率"));
});

test("make 热路径解析：汇总行取最大模块，明细行收进 details，汇总不混进明细", () => {
  const text = [
    "PERF module-make module=medsoprc sources=1 nochange=2 p50=120 min=110 max=160 runs=10",
    "PERF module-make module=pu sources=300 nochange=40 p50=260 min=240 max=320 runs=10",
    "PERF module-make-summary module=pu sources=300 nochange=40 p50=260",
  ].join("\n");
  const r = parseModuleMakePerf(text);
  assert.equal(r.ok, true);
  assert.equal(r.module, "pu");
  assert.equal(r.sources, 300);
  assert.equal(r.nochange, 40);
  assert.equal(r.p50, 260);
  // 明细只认两条 module-make 行，汇总行（module-make-summary）不许被当成明细
  assert.equal(r.details.length, 2);
  assert.deepEqual(r.details.map((d) => d.module), ["medsoprc", "pu"]);
  assert.equal(r.details[1].min, 240);
  assert.equal(r.details[1].runs, 10);
});

test("make 热路径解析：跳过 / 失败 / 没输出三种分开，不认 ecj/增量的行", () => {
  assert.match(parseModuleMakePerf("跳过：本机没有工作区 / java / ecj / 桥 jar").reason, /工作区/);
  assert.match(parseModuleMakePerf("PERF module-make failed: 单文件编译 3 错").reason, /编译失败/);
  assert.match(parseModuleMakePerf("error: could not compile").reason, /没拿到 PERF module-make/);
  assert.equal(parseModuleMakePerf("PERF single-file-compile n=20 min=90 p50=118 max=200 mean=130").ok, false);
  assert.equal(parseModuleMakePerf("PERF incremental-compile n=20 files=5 min=300 p50=800 max=1200 mean=850").ok, false);
  assert.equal(parseModuleMakePerf(null).ok, false);
});

test("无变更扫描解析：汇总取最大模块，小/中/大明细收齐", () => {
  const text = [
    "PERF module-nochange module=bc sources=1 ms=1",
    "PERF module-nochange module=medsoprc sources=80 ms=12",
    "PERF module-nochange module=pu sources=1900 ms=180",
    "PERF module-nochange-summary module=pu sources=1900 ms=180",
  ].join("\n");
  const r = parseModuleNochangePerf(text);
  assert.equal(r.ok, true);
  assert.equal(r.module, "pu");
  assert.equal(r.ms, 180);
  assert.equal(r.details.length, 3);
  assert.deepEqual(r.details.map((d) => d.sources), [1, 80, 1900]);
  assert.match(parseModuleNochangePerf("跳过：本机没有 NC home").reason, /NC home/);
  assert.match(parseModuleNochangePerf("error: could not compile").reason, /没拿到 PERF module-nochange/);
  assert.equal(parseModuleNochangePerf(null).ok, false);
});

test("make 两通道：有自己的数就取自己的，target null 判基线，缺席判未测", () => {
  const rows = buildRows({
    moduleMake: { ok: true, module: "pu", sources: 300, nochange: 40, p50: 260, details: [{ module: "pu", sources: 300, nochange: 40, p50: 260, min: 240, max: 320, runs: 10 }] },
    moduleNochange: { ok: true, module: "pu", sources: 1900, ms: 180, details: [{ module: "bc", sources: 1, ms: 1 }, { module: "pu", sources: 1900, ms: 180 }] },
  });
  const mk = rows.find((r) => r.id === "module-make");
  assert.equal(mk.value, 260);
  assert.equal(mk.verdict, "基线"); // target null
  assert.match(mk.note, /pu（300 文件）/);
  assert.match(mk.note, /无变更 40 ms/);
  const nc = rows.find((r) => r.id === "module-nochange");
  assert.equal(nc.value, 180);
  assert.equal(nc.verdict, "基线");
  assert.match(nc.note, /1900→180ms/);
  // 缺席时未测，且不借用 ecj/增量的数
  const empty = buildRows({ ecj: { ok: true, n: 20, min: 90, p50: 118, max: 200, mean: 130 } });
  assert.equal(empty.find((r) => r.id === "module-make").value, null);
  assert.equal(empty.find((r) => r.id === "module-make").verdict, "未测");
  assert.equal(empty.find((r) => r.id === "module-nochange").value, null);
});

test("make 编译失败绝不变成耗时数字", () => {
  const rows = buildRows({ moduleMake: parseModuleMakePerf("PERF module-make failed: 单文件编译 3 错") });
  const mk = rows.find((r) => r.id === "module-make");
  assert.equal(mk.value, null);
  assert.equal(mk.verdict, "未测");
  assert.match(mk.note, /编译失败/);
});