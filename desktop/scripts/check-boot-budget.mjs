#!/usr/bin/env node
/**
 * 启动耗时门槛（同机滚动基线）。
 *
 * 判据只有一个：**最近 10 次冷启动的首帧中位数，不能比基线慢 20% 以上。**
 *
 * 🔴 为什么不做绝对阈值：CI 机器与开发机的 CPU、磁盘、杀软差异能把同一份代码跑出
 * 两倍差距。跨机红线必然演变成「本地绿、CI 红」或反向的集体麻木——两种都比没有门禁更糟。
 * 这里的基线是**这台机器自己**的历史，只回答「我这台最近是不是变慢了」。
 *
 * 🔴 为什么数据不够就跳过而不是红：新机器、刚清过配置、CI 环境都没有历史。
 * 把「没数据」判成失败，这个门禁第二天就会被 `|| true` 掉。
 *
 * 数据来源：应用启动时 `boot_timing::append_history` 写的 `boot-history.jsonl`
 * （release 构建没有控制台，不落盘就只能靠感觉）。
 *
 * 用法：
 *   node scripts/check-boot-budget.mjs                 # 校验
 *   node scripts/check-boot-budget.mjs --update        # 用最近 10 次重写基线
 *   node scripts/check-boot-budget.mjs --file=<路径>    # 显式指定历史文件（CI 用）
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET = join(ROOT, "scripts", "boot-budget.json");
/** 取最近多少次做中位数：太少受单次抖动影响，太多对近期回归不敏感。 */
const WINDOW = 10;
/** 首帧允许的退化幅度。20% 是「能感觉到但可能是噪声」的分界。 */
const TOLERANCE = 1.2;
/** 分段波动天然更大（索引那一段取决于工程大小），只提示不判失败。 */
const STAGE_TOLERANCE = 1.5;
/** 少于这个样本数不给结论。 */
const MIN_SAMPLES = 3;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** 默认按平台找 Tauri 的 config_dir。identifier 以 tauri.conf.json 为准，别硬编码。 */
function defaultHistoryFile() {
  const conf = readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8");
  const identifier = JSON.parse(conf).identifier;
  if (!identifier) return null;
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, identifier, "boot-history.jsonl");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", identifier, "boot-history.jsonl");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), identifier, "boot-history.jsonl");
}

function readHistory(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        // 半截行（写到一半被杀）不该拖垮整份历史
        return [];
      }
    })
    .filter((row) => typeof row.firstFrameMs === "number");
}

function main() {
  const update = flag("update");
  const file = opt("file") ?? (opt("config-dir") ? join(opt("config-dir"), "boot-history.jsonl") : defaultHistoryFile());
  const rows = readHistory(file);
  const recent = rows.slice(-WINDOW);

  if (recent.length < MIN_SAMPLES) {
    console.log(
      `⚠️ 启动历史样本不足（${recent.length}/${MIN_SAMPLES}），跳过。\n   数据文件：${file ?? "未定位到"}（正常启动几次应用后自动生成）`,
    );
    return;
  }

  const current = median(recent.map((r) => r.firstFrameMs));
  const stageNames = [...new Set(recent.flatMap((r) => Object.keys(r.stages ?? {})))];
  const currentStages = Object.fromEntries(
    stageNames.map((name) => [name, median(recent.map((r) => r.stages?.[name]).filter((v) => typeof v === "number"))]),
  );

  if (update) {
    const next = {
      firstFrameMs: current,
      stages: currentStages,
      samples: recent.length,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(BUDGET, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`✅ 启动基线已更新：首帧 ${current} ms（${recent.length} 次中位数）`);
    for (const [name, ms] of Object.entries(currentStages)) console.log(`   ${name}: ${ms} ms`);
    return;
  }

  if (!existsSync(BUDGET)) {
    console.log(`⚠️ 没有 scripts/boot-budget.json，跳过。确认后运行 --update 生成并一起提交。`);
    return;
  }
  const budget = JSON.parse(readFileSync(BUDGET, "utf8"));
  const base = budget.firstFrameMs;
  if (!base) {
    console.log("⚠️ 基线文件里没有 firstFrameMs，跳过（可能被误改）。");
    return;
  }

  const delta = ((current - base) / base) * 100;
  const slow = current > base * TOLERANCE;
  console.log(
    `${slow ? "❌" : "✅"} 启动首帧：${current} ms（基线 ${base} ms，${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%，窗口 ${recent.length} 次）`,
  );

  const notes = [];
  for (const [name, ms] of Object.entries(currentStages)) {
    const stageBase = budget.stages?.[name];
    if (!stageBase || typeof ms !== "number") continue;
    if (ms > stageBase * STAGE_TOLERANCE) {
      notes.push(`  · 分段「${name}」${ms} ms（基线 ${stageBase} ms）明显变慢`);
    }
  }
  if (notes.length) {
    console.log("   分段提示（不判失败，取决于工程大小）：");
    for (const note of notes) console.log(note);
  }

  if (slow) {
    console.error(`\n启动首帧比本机基线慢 ${delta.toFixed(0)}%，超过 ${Math.round((TOLERANCE - 1) * 100)}% 容差。`);
    console.error("先确认是不是启动路径上多了同步 IO（`check-boot-path` 只拦目录遍历，拦不住读配置/建连接）。");
    console.error("确实是这台机器变慢（换了杀软/磁盘满），用 --update 重置基线。");
    process.exit(1);
  }
  console.log("（同机滚动基线：跨机器不可比，别拿 CI 的数字当结论）");
}

main();
