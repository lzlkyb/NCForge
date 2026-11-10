#!/usr/bin/env node
/**
 * reship.mjs —— 同一个版本号「重新发布」，一条命令收敛全部步骤。
 *
 * 为什么需要它（2026-11-10 v0.4.0 事故）：tag 已推、CI 出错或产物不对，重发要人工
 * 走五步——取消旧 run、删两端 tag、重打 tag、等 30~50 分钟 CI、重做 Gitee 镜像——
 * 每一步都能漏。漏掉「取消旧 run」＝两次构建并发写同一个 Release；漏掉「清单强制
 * 重下」＝镜像上一轮的签名，客户端下完验签失败、反复重下。本脚本把五步串成一条，
 * 并且**每步都自检**，任何一步不对就停在那里，不产生「看起来发完了」的假象。
 *
 * 用法：
 *   node scripts/reship.mjs v0.4.0                  # 自动诊断：GitHub 自洽就只补镜像，否则重新构建
 *   node scripts/reship.mjs v0.4.0 --mirror-only     # 只重做 Gitee 镜像 + 端到端验签（几秒~一分钟）
 *   node scripts/reship.mjs v0.4.0 --full --yes      # 强制重新构建（删 tag 重推，30~50 分钟）
 *   node scripts/reship.mjs v0.4.0 --full --mac --yes # 重新构建并包含 macOS 产物
 *   node scripts/reship.mjs v0.4.0 --dry-run         # 只诊断 + 打印计划，不动任何东西
 *
 * 判据（不是版本号，是签名）：
 *   · GitHub 侧通过 `verify-update-chain --skip-gitee` ＝ 清单与产物自洽；
 *   · 全源通过 ＝ 连 Gitee 也一致。两者都过就是「链路本来没问题」，此时不重发。
 *   · 重新构建后必须等 **本轮** 产出的资产（updater.json 的 createdAt 晚于开跑时间），
 *     否则镜像的就是上一轮清单——那正是 v0.4.0 反复下载的根因。
 *
 * 危险动作（删远端 tag）只在 --full 且明确确认（--yes）时执行；非 TTY 无 --yes 只打印计划。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { decideMode, failedRunsForTag, pendingRunsForTag, releaseReadiness } from "./lib/reship-plan.mjs";

const SCRIPTS = import.meta.dirname;
const DESKTOP = path.resolve(SCRIPTS, "..");
const ROOT = path.resolve(DESKTOP, "..");

const C = { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m", dim: "\x1b[2m", off: "\x1b[0m" };
const info = (m) => console.log(`${C.cyan}[INFO]${C.off} ${m}`);
const ok = (m) => console.log(`${C.green}[OK]${C.off} ${m}`);
const warn = (m) => console.log(`${C.yellow}[WARN]${C.off} ${m}`);
const step = (m) => console.log(`\n${C.magenta}▸ ${m}${C.off}`);
function fail(m) {
  console.error(`${C.red}[ERROR]${C.off} ${m}`);
  process.exit(1);
}
const tail = (s) => (s || "").trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 参数 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const TAG = (argv.find((a) => /^v\d+\.\d+\.\d+/.test(a)) || "").trim();
const FULL = argv.includes("--full");
const MIRROR_ONLY = argv.includes("--mirror-only");
const WANT_MAC = argv.includes("--mac");
const YES = argv.includes("--yes");
const DRY = argv.includes("--dry-run");
const NO_MIRROR = argv.includes("--no-mirror");
const TIMEOUT_MIN = Number(opt("--timeout") || 60);

if (!TAG) fail("用法: node scripts/reship.mjs v0.4.0 [--full | --mirror-only] [--mac] [--yes] [--dry-run]");
if (FULL && MIRROR_ONLY) fail("--full 与 --mirror-only 互斥");
if (!Number.isFinite(TIMEOUT_MIN) || TIMEOUT_MIN <= 0) fail(`--timeout 需要正数分钟（收到 ${opt("--timeout")}）`);

// ── gh / git ─────────────────────────────────────────────────────────────────
function sh(bin, args, { allowFail = false, cwd = ROOT } = {}) {
  const r = spawnSync(bin, args, { cwd, encoding: "utf-8" });
  if (r.status !== 0 && !allowFail) fail(`\`${bin} ${args.join(" ")}\` 失败：${tail(r.stderr || r.stdout)}`);
  return r;
}

function findGh() {
  if (process.env.GH_BIN) return process.env.GH_BIN;
  if (spawnSync("gh", ["--version"], { encoding: "utf-8" }).status === 0) return "gh";
  const fallback = "C:\\Program Files\\GitHub CLI\\gh.exe";
  return process.platform === "win32" && fs.existsSync(fallback) ? fallback : null;
}
const GH = findGh();
if (!GH) fail("找不到 gh（GitHub CLI）。装一个，或设 GH_BIN 指向它。");

const remoteUrl = sh("git", ["remote", "get-url", "origin"], { allowFail: true }).stdout.trim();
const repoMatch = remoteUrl.match(/github\.com[:/]+([^/]+)\/([^/\s]+?)(?:\.git)?$/);
if (!repoMatch) fail(`无法从 git remote 推断 GitHub 仓库（${remoteUrl || "空"}）`);
const GH_REPO = `${repoMatch[1]}/${repoMatch[2]}`;

function listRuns() {
  const r = sh(
    GH,
    [
      "api",
      `repos/${GH_REPO}/actions/runs?per_page=60`,
      "--jq",
      "[.workflow_runs[] | {id,name,status,conclusion,event,head_branch,created_at,url:.html_url}]",
    ],
    { allowFail: true },
  );
  if (r.status !== 0) {
    warn(`读 CI run 列表失败（${tail(r.stderr)}）——跳过「取消旧 run / 提前判失败」`);
    return [];
  }
  try {
    return JSON.parse(r.stdout || "[]");
  } catch {
    return [];
  }
}

function releaseView() {
  const r = sh(GH, ["release", "view", TAG, "-R", GH_REPO, "--json", "isDraft,assets"], { allowFail: true });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** 下载 Release 上的 updater.json（几 KB）——平台与签名只有它说得清。 */
function fetchUpdaterManifest(dir) {
  const r = sh(GH, ["release", "download", TAG, "-R", GH_REPO, "--dir", dir, "--clobber", "--pattern", "updater.json"], {
    allowFail: true,
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "updater.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** token：环境变量优先，其次 gitignore 的 .gitee-token（与 mirror-gitee.mjs 同一套解析）。 */
function findGiteeToken() {
  const env = (process.env.GITEE_TOKEN || "").trim();
  if (env) return env;
  for (const p of [path.join(ROOT, ".gitee-token"), path.join(DESKTOP, ".gitee-token")]) {
    try {
      const t = fs.readFileSync(p, "utf-8").split(/\r?\n/)[0].trim();
      if (t) return t;
    } catch {
      /* 不存在，继续 */
    }
  }
  return "";
}

/** 跑 verify-update-chain，返回它的退出码：0 通过 / 1 内容不符 / 2 网络不通无法判定。 */
function runVerify(extra, note) {
  info(note);
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, "verify-update-chain.mjs"), TAG, ...extra], {
    encoding: "utf-8",
    stdio: "inherit",
  });
  return r.status;
}

async function confirm(question) {
  if (YES) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(`${C.cyan}${question}${C.off} `)).trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

// ── 重新构建 ─────────────────────────────────────────────────────────────────
async function cancelStaleRuns() {
  step("取消该 tag 上未结束的 CI（删 tag 不会停旧 run，并行构建会写出混合产物）");
  const pending = pendingRunsForTag(listRuns(), TAG);
  if (!pending.length) return ok("没有在跑的 run");
  for (const r of pending) {
    sh(GH, ["api", "--method", "POST", `repos/${GH_REPO}/actions/runs/${r.id}/force-cancel`], { allowFail: true });
    // 竞态：cancel 请求发出去时 run 可能刚好结束，所以以「再查一次状态」为准。
    const still = pendingRunsForTag(listRuns(), TAG).find((x) => x.id === r.id);
    if (still) fail(`run ${r.id}（${r.name || r.event}）取消失败：${r.url}\n先手动 force-cancel 它，否则新旧两轮会同时写这个 Release。`);
    ok(`已取消 run ${r.id}（${r.name || r.event}）`);
  }
}

function retag(head) {
  step("重打 tag 并推送（指向当前 HEAD）");
  const del = sh("git", ["push", "origin", `:refs/tags/${TAG}`], { allowFail: true });
  if (del.status === 0) ok(`已删除远端 tag ${TAG}`);
  else warn(`远端 tag 不存在或删除失败（继续）——${tail(del.stderr)}`);
  sh("git", ["tag", "-d", TAG], { allowFail: true });
  sh("git", ["tag", TAG]);
  sh("git", ["push", "origin", `refs/tags/${TAG}`]);
  ok(`tag ${TAG} → ${head.slice(0, 7)}，CI 已触发`);

  if (WANT_MAC) {
    const w = sh(GH, ["workflow", "run", "build.yml", "--ref", TAG, "-f", "with_macos=true"], { allowFail: true });
    if (w.status === 0) ok("已触发 macOS 构建（约 +26 分钟）");
    else warn(`触发 macOS 构建失败：${tail(w.stderr)}，可稍后手动跑 gh workflow run build.yml --ref ${TAG} -f with_macos=true`);
  }
}

function describeGap(r) {
  const bits = [];
  if (r.missingFiles.length) bits.push(`缺 ${r.missingFiles.join("、")}`);
  if (r.staleFiles.length) bits.push(`还是上一轮构建的 ${r.staleFiles.join("、")}`);
  if (r.missingPlatforms.length) bits.push(`清单缺平台 ${r.missingPlatforms.join("、")}`);
  if (r.missingSig.length) bits.push(`签名为空 ${r.missingSig.join("、")}`);
  return bits.join("；") || "产物未就绪";
}

/** 等本轮构建出全产物；失败/超时都返回原因，由调用方决定怎么报。 */
async function waitForRelease(notBefore) {
  step(`等 CI 出全产物（最多 ${TIMEOUT_MIN} 分钟，updater.json 必须是本轮生成的）`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ncforge-reship-"));
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let lastGap = "";
  try {
    for (;;) {
      const runs = listRuns();
      const mine = runs.filter((r) => r.head_branch === TAG);
      const view = releaseView();

      if (view && !view.isDraft && view.assets?.length) {
        const manifest = fetchUpdaterManifest(tmp);
        if (manifest) {
          const ready = releaseReadiness(manifest, view.assets, { wantMac: WANT_MAC, notBefore });
          if (ready.ready) {
            ok(`Release 就绪：${view.assets.length} 个资产，updater.json v${manifest.version}`);
            return { ok: true, manifest };
          }
          const gap = describeGap(ready);
          if (gap !== lastGap) {
            info(`${gap} —— 继续等`);
            lastGap = gap;
          }
        }
      } else if (!lastGap) {
        info("Release 还没建出来（CI 在编译）");
        lastGap = "waiting";
      }

      // 全都不在跑且有失败的 run：别干等到超时，立刻把日志地址给人。
      const failed = failedRunsForTag(runs, TAG).filter((r) => Date.parse(r.created_at || 0) >= notBefore - 600_000);
      if (failed.length && !pendingRunsForTag(runs, TAG).length) {
        return {
          ok: false,
          reason: `CI 失败，不用再等：\n${failed.map((f) => `    ${f.id} ${f.conclusion} ${f.url}`).join("\n")}`,
        };
      }
      if (Date.now() > deadline) {
        const where = mine.length ? mine.map((r) => `${r.id} ${r.status}/${r.conclusion || "-"}`).join("；") : "查不到 run";
        return { ok: false, reason: `${TIMEOUT_MIN} 分钟仍未出全产物（${where}）。查 CI：gh run list -R ${GH_REPO} -L 5` };
      }
      await sleep(30_000);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 只重做镜像 ───────────────────────────────────────────────────────────────
function runMirror(extra) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, "mirror-gitee.mjs"), TAG, ...extra], {
    cwd: DESKTOP,
    stdio: "inherit",
    env: { ...process.env, GITEE_TOKEN: findGiteeToken(), NO_PROXY: "gitee.com", no_proxy: "gitee.com" },
  }).status;
}

/**
 * 两段式：先幂等补（清单必重下重推，附件只补缺的），再视情况全量重传。
 *
 * 不默认 --force 的原因：它会「先删旧附件再传」，中途断网就比原来更糟（连旧的都没了）。
 * 而多数故障（清单落后、少传了某个文件）幂等那一段就修好了；只有「同名同大小但内容
 * 不同」这种幂等看不见的坑，才需要全量重传——那时已经复验失败，重传是唯一的出路。
 */
function reshipMirror() {
  step("重新镜像到 Gitee（先幂等补齐，复验不过再全量重传）");
  if (!findGiteeToken()) fail("缺 GITEE_TOKEN：设环境变量，或把令牌写进仓库根 .gitee-token（首行）。");

  if (runMirror([]) === 0) return;
  warn("幂等镜像后复验仍未通过——可能是「同名同大小但内容不同」的旧包。升级为 --force 全量重传（约 200MB / 2 分钟）…");
  if (runMirror(["--force"]) === 0) return;
  fail(
    "镜像失败（内部端到端验签未通过）。重跑本命令是幂等的；\n" +
      "  若反复失败且签名始终对不上，说明 GitHub 侧产物与清单本身有问题，改用 --full 重新构建。",
  );
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now();
  const head = sh("git", ["rev-parse", "HEAD"]).stdout.trim();
  const headLine = sh("git", ["log", "-1", "--pretty=%h %s"]).stdout.trim();
  const remoteTag = sh("git", ["ls-remote", "--tags", "origin", `refs/tags/${TAG}`], { allowFail: true }).stdout.trim();

  console.log(`${C.dim}仓库 ${GH_REPO} · HEAD ${headLine}${C.off}`);
  if (remoteTag) info(`远端已有 tag ${TAG} → ${remoteTag.split(/\s+/)[0].slice(0, 7)}（重发会替换它）`);
  else info(`远端没有 tag ${TAG}（本次是补发）`);

  step("预检");
  const ahead = sh("git", ["log", "--oneline", "origin/main..HEAD"], { allowFail: true }).stdout.trim();
  if (ahead) {
    warn(
      `HEAD 比 origin/main 多 ${ahead.split(/\r?\n/).length} 个 commit。CI 用 tag 里的代码构建，能出包；\n` +
        `      但 Gitee 发行版的 target_commitish 是 master、GitHub Release 也挂在 main 的头上，建议先 push main。`,
    );
  }
  const dirty = sh("git", ["status", "--porcelain"], { allowFail: true }).stdout.trim();
  if (dirty && (FULL || !MIRROR_ONLY)) {
    warn(`工作区有 ${dirty.split(/\r?\n/).length} 处未提交改动——它们不会进构建。若修复还没提交，重发的还是坏版本。`);
  }

  step("诊断更新链路（判据是签名，不是版本号）");
  let githubOk = false;
  let giteeOk = false;
  if (MIRROR_ONLY) {
    info("--mirror-only：跳过诊断，直接重做镜像");
    giteeOk = false;
  } else {
    const ghStatus = runVerify(["--skip-gitee"], "先只验 GitHub 源（清单 ↔ 产物 ↔ 签名）");
    // 退出码 2 = 网络不通，什么都证明不了。绝不能当成「不自洽」去重建——那是白跑 50 分钟。
    if (ghStatus === 2) {
      fail(
        "本机到更新源网络不通，无法判定链路状态，所以不擅自重建。\n" +
          "  设 HTTPS_PROXY 后重跑；或确定要重建就显式 --full --yes；只怀疑镜像就 --mirror-only。",
      );
    }
    githubOk = ghStatus === 0;
    if (githubOk) {
      const allStatus = runVerify([], "再验全链路（把 Gitee 算进去）");
      if (allStatus === 2) {
        fail("校验 Gitee 源时网络不通，无法判定它是否落后。\n  先确认 Gitee 可达；或直接 --mirror-only 强制重做镜像。");
      }
      giteeOk = allStatus === 0;
    } else {
      warn("GitHub 侧就不自洽：只重做镜像没用，需要重新构建");
    }
  }

  const { mode, why } = decideMode({ githubOk, giteeOk, full: FULL, mirrorOnly: MIRROR_ONLY });
  console.log(`\n${C.magenta}结论：${mode === "full" ? "重新构建" : mode === "mirror" ? "只重做镜像" : "无需重发"}${C.off} —— ${why}`);
  if (WANT_MAC && mode !== "full") warn("--mac 只在重新构建时生效，本次忽略");

  if (mode === "none") {
    console.log(`${C.green}✅ ${TAG} 的更新链路本来就是一致的，没有需要重发的东西。${C.off}`);
    console.log(`${C.dim}   确实想重建：加 --full --yes${C.off}`);
    return;
  }
  if (DRY) {
    console.log(
      mode === "full"
        ? `\n${C.dim}--dry-run 到此为止。真跑会：取消该 tag 的旧 run → 删远端 tag → 重打到 ${head.slice(0, 7)} → 推送` +
            `${WANT_MAC ? " + 触发 macOS" : ""} → 等 CI（≤${TIMEOUT_MIN} 分钟） → 镜像 Gitee → 端到端验签。${C.off}`
        : `\n${C.dim}--dry-run 到此为止。真跑会：重新生成两份 Gitee 清单 → 幂等补齐附件 → 推 raw 分支 → 端到端验签（验不过再全量重传）。${C.off}`,
    );
    return;
  }

  if (mode === "full") {
    if (!(await confirm(`将删除并重推远端 tag ${TAG}（指向 ${head.slice(0, 7)}），随后重建约 30~50 分钟。继续？(y/N)`))) {
      console.log(`${C.yellow}已中止，什么都没改。${C.off}`);
      console.log(`  非交互环境需显式确认：node scripts/reship.mjs ${TAG} --full --yes`);
      return;
    }

    step("取消旧 run → 重打 tag → 推送");
    await cancelStaleRuns();
    retag(head);

    step("等产物 → 镜像 → 验签");
    const result = await waitForRelease(startedAt);
    if (!result.ok) {
      fail(
        `${result.reason}\n` +
          `  tag ${TAG} 已指向 ${head.slice(0, 7)} 并推送；修好 CI 后再跑一次本命令（会重新取消、重推）。`,
      );
    }
    if (NO_MIRROR) {
      warn(`--no-mirror：跳过 Gitee。补齐后跑 node scripts/reship.mjs ${TAG} --mirror-only`);
      return;
    }
  }

  reshipMirror();

  console.log(`\n${C.green}✅ ${TAG} 重发完成：GitHub Release + Gitee 镜像 + 端到端验签全部通过。${C.off}`);
  console.log(`${C.dim}   客户端下次检查更新（默认 24h，可在设置里手动检查）即可拿到一致签名的新包。${C.off}`);
}

main().catch((e) => {
  fail(e.stack || String(e));
});
