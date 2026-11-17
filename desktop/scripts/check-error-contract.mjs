/**
 * 错误契约门禁（棘轮）。
 *
 * 规则只有一条：**新命令不许返 `Result<_, String>`**，请用 `Result<_, AppError>`
 * （`src-tauri/src/app_error.rs`）。存量记进基线，只许减。
 *
 * 为什么不一次改完：改一处签名要连带改它的每个调用点，400 多条命令的连锁改动
 * 会让 diff 无法 review，而且和「建立契约」是两件事。基线是小步推进的把手。
 *
 * 用法：
 *   node scripts/check-error-contract.mjs           # 校验（默认）
 *   node scripts/check-error-contract.mjs --update  # 收缩基线（迁移完一批后跑）
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { diffAgainstBaseline, normalizeBaseline, stringResultCommands } from "./lib/error-contract.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CMDS = join(ROOT, "src-tauri", "src", "commands");
const BASELINE = join(ROOT, "scripts", "error-contract-baseline.json");

function rustFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...rustFiles(p));
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

const current = [];
for (const file of rustFiles(CMDS)) {
  const src = readFileSync(file, "utf8");
  for (const name of stringResultCommands(src)) {
    current.push({ name, file: relative(ROOT, file).replace(/\\/g, "/") });
  }
}
current.sort((a, b) => a.name.localeCompare(b.name));

const update = process.argv.includes("--update");
let baseline = { commands: [], exempt: {} };
try {
  baseline = normalizeBaseline(JSON.parse(readFileSync(BASELINE, "utf8")));
} catch {
  baseline = { commands: [], exempt: {} };
}

const { added, migrated, staleExempt } = diffAgainstBaseline(
  current.map((c) => c.name),
  baseline.commands,
  baseline.exempt,
);

/**
 * 🔴 `--update` 不许吸收新增。
 *
 * 2026-11-17 真事：新写的 `svn_file_commits` 因为「先写命令、后跑 --update」
 * 被无声写进基线，门禁当场失效。基线是「历史存量」，不是「当前全量」——
 * 允许 update 吸收新增，等于任何人都能用一条命令绕过契约。
 *
 * 确实要破例（比如整族都用 `code|message`，单条改成对象反而割裂）：
 * 手工把它写进基线 JSON 的 `exempt`，附一句为什么。破例要留痕。
 */
if (update && added.length) {
  console.error(`❌ 拒绝更新基线：有 ${added.length} 条**新命令**返回了 Result<_, String>`);
  for (const name of added) {
    const hit = current.find((c) => c.name === name);
    console.error(`   - ${hit.file}：${name}`);
  }
  console.error("");
  console.error("  要么改成 Result<T, AppError>（推荐，见 src-tauri/src/app_error.rs）：");
  console.error('     Err(AppError::input("模块.原因", format!("…: {e}")).with_hint("怎么解决"))');
  console.error("  要么把它手工写进 scripts/error-contract-baseline.json 的 exempt，并写明理由。");
  process.exit(1);
}

if (update) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        note: "返 Result<_, String> 的命令：只许减。新命令用 Result<_, AppError>；确实要破例的写进 exempt 并说明理由。",
        commands: current.map((c) => c.name).filter((n) => !(n in baseline.exempt)),
        exempt: baseline.exempt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`✅ 错误契约基线已更新：${current.length} 条（本次收缩 ${migrated.length} 条）`);
  process.exit(0);
}

if (added.length) {
  console.error("❌ 错误契约门禁未通过：新增命令返回了 Result<_, String>");
  for (const name of added) {
    const hit = current.find((c) => c.name === name);
    console.error(`   - ${hit.file}：${name}`);
  }
  console.error("");
  console.error("   改成 Result<T, AppError>：");
  console.error("     use crate::app_error::AppError;");
  console.error('     Err(AppError::input("模块.原因", format!("…: {e}")).with_hint("怎么解决"))');
  console.error("   code 是给前端查表的契约，detail 是给排障看的证据，别混。");
  process.exit(1);
}

if (migrated.length) {
  // 提示而不是失败：失败会逼人改基线来「过门禁」，与只许减的方向相反
  console.log(`ℹ️  已有 ${migrated.length} 条命令改成了结构化错误，可跑 --update 收缩基线：`);
  console.log(`   ${migrated.join(", ")}`);
}

if (staleExempt.length) {
  console.log(`ℹ️  这些豁免已经不返 String 了（迁移完或命令已删），请从 exempt 删掉：${staleExempt.join(", ")}`);
}

const waived = Object.keys(baseline.exempt).filter((n) => !staleExempt.includes(n));
if (waived.length) {
  console.log(`ℹ️  豁免 ${waived.length} 条（族内一致，随族迁移）：${waived.join(", ")}`);
}

console.log(`✅ 错误契约门禁通过：${current.length} 条存量 String 命令，无新增`);
