#!/usr/bin/env node
/**
 * 门禁 CLI —— 清单与真源在 scripts/lib/gate-plan.mjs，本文件只负责解析参数、跑命令、报结果。
 *
 * 为什么要一个统一入口（2026-11-06 的教训）：
 *   门禁清单原本抄在三处（pre-push 的 sh、build.yml 的 frontend、build.yml 的
 *   test + check-macos），增删一项要改三个文件。结果 cargo fmt --check 从 11-05
 *   起在 CI 里一次都没跑过（钩子也从未安装）；而「按记忆手动跑那 12 个命令」
 *   漏了 knip / 设计 token / UI 约定 / 体积预算四项，push 后 CI 三个 job 全红。
 *
 * 用法：
 *   node scripts/gate.mjs                    # 全量（pre-push 就是这一条）
 *   node scripts/gate.mjs --scope frontend   # 只跑某个 scope（可多次）
 *   node scripts/gate.mjs --only clippy      # 只跑某项（CI 每步用这个，可逗号分隔）
 *   node scripts/gate.mjs --precommit        # 提交前的三项（pre-commit 钩子用）
 *   node scripts/gate.mjs --list             # 打印清单，不执行
 *   node scripts/gate.mjs --verify-ci        # 断言 workflow 与清单一致
 *
 * 退出码：0 全过；1 有失败（第一个失败即停，别让人等完 cargo test 才知道
 * eslint 挂了）；2 参数错。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CI_JOBS, PRECOMMIT, STEPS, SCOPES, stepById, verifyWorkflow } from "./lib/gate-plan.mjs";

const here = dirname(fileURLToPath(import.meta.url)); // desktop/scripts
const desktopDir = resolve(here, ".."); // desktop
const repoRoot = resolve(desktopDir, "..");
const workflowPath = resolve(repoRoot, ".github/workflows/build.yml");

/** Windows 上 npm/npx 是 .cmd：Node 从 18.20.2 起拒绝直接 spawn（EINVAL，CVE-2024-27980 的修复）。 */
const WIN = process.platform === "win32";
const NPM_LIKE = new Set(["npm", "npx"]);

/**
 * 起一步。npm/npx 在 Windows 上必须经 cmd.exe 转一道；cwd 仍由 spawn 参数给，
 * 不经过 shell 拼接，所以路径带空格也不会出问题。
 */
function spawnStep(argv, cwd) {
  if (WIN && NPM_LIKE.has(argv[0])) {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/c", ...argv], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
  }
  return spawnSync(argv[0], argv.slice(1), { cwd, stdio: "inherit", env: process.env });
}

const fmtDuration = (ms) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);

/** 极简参数解析：只认长选项，值紧跟在后面或逗号分隔。 */
function parseArgs(argv) {
  const opts = { scopes: [], only: [], precommit: false, list: false, verifyCi: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const takeValue = () => {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) {
        console.error(`❌ ${a} 后面缺值`);
        process.exit(2);
      }
      i += 1;
      return v;
    };
    if (a === "--scope") opts.scopes.push(...takeValue().split(",").filter(Boolean));
    else if (a === "--only") opts.only.push(...takeValue().split(",").filter(Boolean));
    else if (a === "--precommit") opts.precommit = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--verify-ci") opts.verifyCi = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else {
      console.error(`❌ 不认识的参数：${a}（--help 看用法）`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`门禁 CLI（清单真源：scripts/lib/gate-plan.mjs）

  node scripts/gate.mjs                   全量（${STEPS.length} 项，pre-push 用的就是这个）
  node scripts/gate.mjs --scope frontend  只跑某 scope：${SCOPES.join(" / ")}
  node scripts/gate.mjs --only clippy     只跑某项，可逗号分隔
  node scripts/gate.mjs --precommit       提交前三项（${PRECOMMIT.map((p) => p.id).join(" / ")}，按暂存文件后缀挑）
  node scripts/gate.mjs --list            打印清单
  node scripts/gate.mjs --verify-ci       断言 workflow 与清单一致

CI job ↔ scope：${Object.entries(CI_JOBS).map(([j, s]) => `${j}=${s}`).join("  ")}`);
}

function printList(scopes) {
  const picked = scopes.length ? STEPS.filter((s) => s.scopes.some((sc) => scopes.includes(sc))) : STEPS;
  for (const s of picked) {
    console.log(`${s.id.padEnd(16)} [${s.scopes.join(",")}]  ${s.name}`);
    console.log(`${"".padEnd(16)}   ${s.cwd}$ ${s.argv.join(" ")}`);
    console.log(`${"".padEnd(16)}   ${s.why}`);
  }
  console.log(`\n共 ${picked.length} 项；scope：${SCOPES.join(" / ")}；不带参数跑全部 ${STEPS.length} 项。`);
  console.log(`pre-commit（提交前，按暂存文件后缀挑）：${PRECOMMIT.map((p) => p.id).join(" → ")}`);
}

/**
 * 提示「钩子没装」。这不是失败项：CI 上跑本文件时 core.hooksPath 也没意义，
 * 手动跑门禁的人也应当被提醒一次——否则他会以为 push 时也会自动跑。
 */
function warnIfHooksOff() {
  if (process.env.CI || process.env.GITHUB_ACTIONS) return;
  const r = spawnSync("git", ["config", "core.hooksPath"], { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) return; // 不是 git 仓库（源码压缩包 / 打包产物），不吵
  const v = (r.stdout || "").trim();
  if (v === ".githooks") return;
  console.log("");
  console.log(`⚠️  git 钩子没启用（core.hooksPath=${v || "空"}）：push 时不会自动跑这套门禁。`);
  console.log("    修好它：git config core.hooksPath .githooks（npm install 也会自动装）");
  console.log("");
}

/** 暂存区里的文件（相对仓库根）。不在 git 仓库里返回 null —— 那时保守全跑。 */
function stagedFiles() {
  const r = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return (r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 选出要跑的步骤：--precommit 优先，其次 --only、--scope，都没有则全量。
 *
 * --precommit 只跑清单里 PRECOMMIT 声明的三项，并按「暂存文件后缀」跳过无关项：
 * 只改文档的提交不该花 20 秒等 tsc。跳过项会打印出来，免得让人以为三项都验过。
 */
function pickSteps(opts) {
  if (opts.precommit) {
    if (opts.only.length || opts.scopes.length) {
      console.error("❌ --precommit 不能与 --only / --scope 一起用");
      process.exit(2);
    }
    const staged = stagedFiles();
    const picked = [];
    const skipped = [];
    for (const item of PRECOMMIT) {
      const step = stepById(item.id);
      if (!step) {
        console.error(`❌ PRECOMMIT 引用了清单里不存在的 id：${item.id}`);
        process.exit(2);
      }
      if (!staged || staged.some((f) => item.match.test(f))) picked.push(step);
      else skipped.push(item.id);
    }
    if (staged) {
      const tail = skipped.length ? `；无相关改动，跳过：${skipped.join(", ")}` : "";
      console.log(`暂存 ${staged.length} 个文件${tail}`);
    }
    return picked;
  }
  if (opts.only.length) {
    const unknown = opts.only.filter((id) => !stepById(id));
    if (unknown.length) {
      console.error(`❌ 清单里没有这些 id：${unknown.join(", ")}（--list 看全部）`);
      process.exit(2);
    }
    const wanted = new Set(opts.only);
    return STEPS.filter((s) => wanted.has(s.id));
  }
  if (opts.scopes.length) {
    const unknown = opts.scopes.filter((s) => !SCOPES.includes(s));
    if (unknown.length) {
      console.error(`❌ 未知 scope：${unknown.join(", ")}（可选：${SCOPES.join(" / ")}）`);
      process.exit(2);
    }
    return STEPS.filter((s) => s.scopes.some((sc) => opts.scopes.includes(sc)));
  }
  return STEPS;
}

function runVerifyCi() {
  let text;
  try {
    text = readFileSync(workflowPath, "utf8");
  } catch (e) {
    console.error(`❌ 读不到 ${workflowPath}：${e.message}`);
    process.exit(1);
  }
  const { errors, warnings } = verifyWorkflow(text);
  for (const w of warnings) console.log(`⚠️  ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`❌ ${e}`);
    console.error(`\n门禁清单与 .github/workflows/build.yml 不一致（共 ${errors.length} 处）。`);
    console.error("清单真源：desktop/scripts/lib/gate-plan.mjs；CI 侧只该有 `gate.mjs --only <id>`。");
    process.exit(1);
  }
  console.log(`✅ workflow 与清单一致：${Object.entries(CI_JOBS).map(([j, s]) => `${j}(${s})`).join("、")}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();
  if (opts.list) return printList(opts.scopes);
  if (opts.verifyCi) return runVerifyCi();

  const steps = pickSteps(opts);
  if (!steps.length) {
    if (opts.precommit) {
      // 只改了文档/图片之类：三项都与它无关，别拿一个空跑当失败。
      console.log("✅ 暂存改动不涉及设计 token / fmt / tsc，pre-commit 无需跑");
      return;
    }
    console.error("❌ 没有选中任何步骤");
    process.exit(2);
  }

  const label = opts.precommit
    ? "pre-commit"
    : opts.only.length
      ? `--only ${opts.only.join(",")}`
      : opts.scopes.length
        ? `--scope ${opts.scopes.join(",")}`
        : "全量";
  console.log("");
  console.log("══════════════════════════════════════════════");
  console.log(`  门禁（${label}）：${steps.length} 项`);
  console.log("══════════════════════════════════════════════");
  // 本文件正被钩子调用时不必提醒「钩子没装」——那正是它跑起来的原因。
  if (!opts.precommit) warnIfHooksOff();

  const totalStart = Date.now();
  const failures = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const cwd = resolve(repoRoot, step.cwd);
    console.log(`[${i + 1}/${steps.length}] ${step.name} ...`);

    const started = Date.now();
    const r = spawnStep(step.argv, cwd);
    const took = Date.now() - started;

    if (r.error || r.status !== 0) {
      const reason = r.error ? r.error.message : `退出码 ${r.status}`;
      console.log("");
      console.error(`❌ [${i + 1}/${steps.length}] ${step.name} 失败（${fmtDuration(took)}，${reason}）`);
      console.error(`   为什么有这一项：${step.why}`);
      console.error(`   单独复现：node scripts/gate.mjs --only ${step.id}`);
      if (opts.precommit) {
        console.error("   确实要跳过这次提交：git commit --no-verify");
        console.error("   （同工作树里别人的半成品把这项弄红时用它，别改自己的代码去迁就）");
      }
      failures.push(step.id);
      break; // fail-fast：第一个失败就停
    }
    console.log(`  ✅ ${fmtDuration(took)}`);
    console.log("");
  }

  const took = fmtDuration(Date.now() - totalStart);
  if (failures.length) {
    console.log("══════════════════════════════════════════════");
    console.error(`  ✗ 失败：${failures.join(", ")}（已跑 ${took}）`);
    console.log("══════════════════════════════════════════════");
    process.exit(1);
  }

  console.log("══════════════════════════════════════════════");
  console.log(`  全部 ${steps.length} 项通过 ✅（${took}）`);
  console.log("══════════════════════════════════════════════");
}

main();
