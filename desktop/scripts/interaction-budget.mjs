#!/usr/bin/env node
/**
 * 交互延迟预算对比（DESIGN.md §3）。
 *
 * 为什么不进 CI：延迟随机器、缩放、插件状态变化，卡阈值只会逼人调阈值。
 * 这里只出表 + 本地标红，退出码仅在显式 `--strict` 时有意义。
 *
 * 采集（dev 构建已内置采样器，生产构建不装）：
 *   1) npm run vite:dev
 *   2) 在应用里正常操作：敲字、开命令面板、切标签、拖面板
 *   3) DevTools 控制台执行：
 *        copy(JSON.stringify(window.__ncInteraction.snapshot()))
 *      粘到 desktop/interaction-budget.json
 *   4) node scripts/interaction-budget.mjs --from=interaction-budget.json
 *
 * 用法：
 *   node scripts/interaction-budget.mjs --from=<file> [--strict]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUDGETS, evaluate, formatTable, normalize } from "./lib/interaction-budget.mjs";

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const fromArg = argv.find((a) => a.startsWith("--from="));
const from = fromArg ? fromArg.slice("--from=".length) : null;

if (!from) {
  console.log("交互延迟预算表（DESIGN.md §3）\n");
  console.log(formatTable(evaluate({}, BUDGETS).rows));
  console.log("\n没有样本。采集方法：");
  console.log("  1) npm run vite:dev");
  console.log("  2) 在应用里敲字 / 开命令面板 / 切标签 / 拖面板");
  console.log("  3) DevTools 控制台：copy(JSON.stringify(window.__ncInteraction.snapshot()))");
  console.log("  4) 粘到 interaction-budget.json 后运行：node scripts/interaction-budget.mjs --from=interaction-budget.json");
  process.exit(0);
}

const path = resolve(process.cwd(), from);
if (!existsSync(path)) {
  console.error(`❌ 找不到样本文件：${path}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`❌ 样本文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const { summary } = normalize(data);
const { rows, failed, unmeasured } = evaluate(summary, BUDGETS);
console.log("交互延迟预算表（DESIGN.md §3）\n");
console.log(formatTable(rows));

if (unmeasured.length) {
  console.log(`\nℹ️ 未测场景：${unmeasured.join("、")}——dev 里没操作过就不会有样本。`);
}

if (failed.length) {
  console.error("\n❌ 超预算：");
  for (const f of failed) console.error(`  - ${f}`);
  console.error("  先定位是渲染放大、还是同步计算挡在主线程（用 Performance 面板看 long task）。");
  process.exit(1);
}

if (strict && unmeasured.length) {
  console.error(`\n❌ --strict：以下场景没有样本，不能判达标：${unmeasured.join("、")}`);
  process.exit(1);
}

console.log("\n✅ 已测场景均在预算内。");
