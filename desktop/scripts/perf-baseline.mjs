#!/usr/bin/env node
/**
 * A0 性能基线：一条命令把五个速度指标汇成一张表（方案 §4.2）。
 *
 * 为什么不是门禁：这些数字依赖真机 java / jdt.ls / NC home，机器之间差一倍很正常，
 * 拿来卡 CI 只会让人去调阈值。所以**本地一键出表、CI 不跑**；表里的目标值只作判定，
 * 不作为退出码依据（除非显式 --strict）。
 *
 * 各路探针各跑各的，谁缺席就标未测：
 *   compile     → cargo 的 `单文件编译_p50`（#[ignore]，要显式点名）
 *   incremental → cargo 的 `增量编译_p50`（#[ignore]，1–5 文件走常驻 worker）
 *   gaps        → code-editor-gaps-live.mjs（补全 p50 / 诊断延迟 / 大文件）
 *   index       → lang-index-bench.mjs（首次导入 / 缓存复用 / 排除产物目录）
 *   boot        → 只能从真机日志读，用 --boot-log=<文件> 传进来
 *
 * 用法（在 desktop/ 下）：
 *   npm run test:perf                          # 三路全跑（约 5~10 分钟）
 *   node scripts/perf-baseline.mjs --only=compile
 *   node scripts/perf-baseline.mjs --reuse     # 只读上轮 JSON，不重跑探针
 *   node scripts/perf-baseline.mjs --boot-log=D:/tmp/app.log
 *   node scripts/perf-baseline.mjs --index-files=2000 --strict
 *   node scripts/perf-baseline.mjs --timeout-ms=120000   # 单路探针上限，默认 8 分钟
 *
 * 冷启动那一路怎么取数（env_logger 默认打 stderr，没有日志文件）：
 *   $env:RUST_LOG="info"; & .\src-tauri\target\release\nc-forge.exe 2> D:\tmp\app.log
 *   等界面出来、能敲字之后关掉，再 --boot-log=D:\tmp\app.log
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRows, formatTable, parseBootLog, parseEcjPerf, parseIncrementalPerf, summarize } from "./lib/perf-baseline.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * 🔴 结论目录必须与 `test-tmp` 分开（2026-11-15 踩到）。
 *
 * 三个探针都把 JSON 落在 `target/test-tmp/`，而 `rust-gate.mjs` 每次跑 cargo
 * 前后都会 `wipeTmp()` **清空那个目录里的所有条目**——它只认目录不认文件，
 * 于是「跑完 clippy / rust-test，再 --reuse 出表」会得到一张全「未测」的表，
 * 看起来像探针坏了，实际是结论被自己的门禁清掉了。
 *
 * 现在：读仍从 `test-tmp`（探针写在那儿，不改它们），但**汇总与快照一律写
 * `target/perf/`**，`--reuse` 优先读这里。`target/` 整个在 .gitignore 里，
 * 跟着 `cargo clean` 走，不入库也不污染系统盘。
 */
const probeDir = join(desktop, "src-tauri", "target", "test-tmp");
const base = join(desktop, "src-tauri", "target", "perf");
mkdirSync(base, { recursive: true });

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const ONLY = opt("only");
const REUSE = flag("reuse");
const STRICT = flag("strict");
const INDEX_FILES = opt("index-files") ?? "600";

/** 只跑点名的那一路；其余路仍会尝试读上一轮的 JSON（读得到就有数，读不到就未测）。 */
const wanted = (id) => !ONLY || ONLY === id;

/**
 * 跑一路探针。
 *
 * 🔴 为什么要超时（2026-11-15 实测）：`lang-index-bench` 三轮测量只花 48 s，但
 * **收尾清理花了 20 分钟以上**——沙箱的 `node-safe-delete-shim`（`NODE_OPTIONS`
 * 注入）会逐条拦 `unlinkSync`，2400 个 fixture 文件删起来约每秒 0.2 个。
 * 数据在清理之前就已落盘，所以「测量完成」与「进程退出」是两件事。
 *
 * 这里给一个上限：到点就 kill，然后照常读 JSON。表里的数字不受影响，
 * 残留目录由下一轮 `rust-gate` 的 wipeTmp 或手工清（都在 target 下，跟着 cargo clean 走）。
 * 不设上限的话，一条「出个表」的命令会挂半小时，人会以为探针卡死。
 */
const PROBE_TIMEOUT_MS = Number(opt("timeout-ms") ?? 8 * 60 * 1000);

const run = (label, cmd, args, opts = {}) => {
  console.log(`\n—— ${label}`);
  console.log(`   ${cmd} ${args.join(" ")}`);
  const t = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: desktop, encoding: "utf8", shell: false, timeout: PROBE_TIMEOUT_MS, ...opts,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  if (r.error?.code === "ETIMEDOUT" || r.signal) {
    console.log(`   ⏱ ${secs} s 到上限被中止（${r.signal ?? "timeout"}）——测量结果若已落盘仍会采用，残留目录在 target/test-tmp 下`);
  } else {
    console.log(`   退出码 ${r.status ?? "?"}，耗时 ${secs} s`);
  }
  return { out, status: r.status ?? 1 };
};

/**
 * 读一份结论：先看 `target/perf/` 的快照，再回落探针原目录 `test-tmp/`。
 * 读到探针目录的就顺手抄一份进 perf/，这样下一次门禁 wipeTmp 之后仍在。
 */
const readJson = (name) => {
  for (const dir of [base, probeDir]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, "utf8");
      const data = JSON.parse(text);
      if (dir === probeDir) writeFileSync(join(base, name), text);
      return data;
    } catch (e) {
      console.log(`   ⚠️ ${name} 读不动（${String(e).slice(0, 80)}），按未测处理`);
      return null;
    }
  }
  return null;
};

// —— compile：Rust 的 #[ignore] 测试。走 rust-gate 是为了临时目录与并发限制。
let ecj = null;
if (wanted("compile") && !REUSE) {
  const { out } = run("单文件编译 p50（ecj 常驻 worker）", process.execPath, [
    "scripts/rust-gate.mjs", "test", "--lib", "--", "--ignored", "单文件编译_p50", "--nocapture",
  ]);
  ecj = parseEcjPerf(out);
  writeFileSync(join(base, "perf-ecj.json"), JSON.stringify({ generatedAt: new Date().toISOString(), ...ecj }, null, 2));
  if (!ecj.ok) console.log(`   ⚠️ ${ecj.reason}`);
} else {
  ecj = readJson("perf-ecj.json");
}

// —— incremental：1–5 文件增量编译。与 compile 分开两条 Rust 测试，数字不互相顶替。
let incremental = null;
if (wanted("incremental") && !REUSE) {
  const { out } = run("1–5 文件增量编译 p50（ecj 常驻 worker）", process.execPath, [
    "scripts/rust-gate.mjs", "test", "--lib", "--", "--ignored", "增量编译_p50", "--nocapture",
  ]);
  incremental = parseIncrementalPerf(out);
  writeFileSync(join(base, "perf-incremental.json"), JSON.stringify({ generatedAt: new Date().toISOString(), ...incremental }, null, 2));
  if (!incremental.ok) console.log(`   ⚠️ ${incremental.reason}`);
} else {
  incremental = readJson("perf-incremental.json");
}

// —— gaps：补全 p50 与大文件代价。
if (wanted("gaps") && !REUSE) {
  run("补全 / 诊断 / 大文件（jdt.ls 真机）", process.execPath, ["scripts/code-editor-gaps-live.mjs"]);
}
const gaps = readJson("editor-gaps.json");

// —— index：首次导入与缓存复用。
if (wanted("index") && !REUSE) {
  run("全量索引（fixture 规模）", process.execPath, ["scripts/lang-index-bench.mjs", `--files=${INDEX_FILES}`]);
}
const index = readJson("lang-index-bench.json");

// —— boot：没有探针可跑，只认用户给的真机日志。
const bootLog = opt("boot-log");
let boot = null;
if (bootLog) {
  if (existsSync(bootLog)) boot = parseBootLog(readFileSync(bootLog, "utf8"));
  else console.log(`\n⚠️ --boot-log 指的文件不存在：${bootLog}`);
  if (bootLog && !boot) console.log("   日志里没有「冷启动：进程启动 → 前端首帧」那一行；确认启动时带了 RUST_LOG=info");
} else {
  boot = readJson("perf-boot.json");
}
if (boot) writeFileSync(join(base, "perf-boot.json"), JSON.stringify(boot, null, 2));

const rows = buildRows({ ecj, incremental, gaps, index, boot });
const table = formatTable(rows);
const sum = summarize(rows);

console.log("\n=== 速度基线（方案 §4.2）===");
console.log(table);
console.log(`\n${sum.text}`);
if (boot?.stages && Object.keys(boot.stages).length) {
  console.log(`启动分段：${Object.entries(boot.stages).map(([k, v]) => `${k} ${v} ms`).join(" / ")}`);
}

const report = { generatedAt: new Date().toISOString(), rows, summary: sum, inputs: { ecj, incremental, gaps, index, boot } };
const outJson = join(base, "perf-baseline.json");
const outMd = join(base, "perf-baseline.md");
writeFileSync(outJson, JSON.stringify(report, null, 2));
writeFileSync(outMd, `# 速度基线 ${report.generatedAt}\n\n${table}\n\n${sum.text}\n`);
console.log(`\n已落盘：${outJson}\n         ${outMd}`);

// 默认不因超标退出：目标不是门槛（见头注释）。--strict 才把超标当失败。
if (STRICT && sum.over > 0) {
  console.error(`\n❌ --strict：${sum.over} 项超标`);
  process.exit(1);
}