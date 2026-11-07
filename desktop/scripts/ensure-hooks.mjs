#!/usr/bin/env node
/**
 * 幂等启用仓库自带的 git 钩子（core.hooksPath = .githooks）。
 *
 * 为什么需要它：`.githooks/pre-push` 存在了很久，但 `git config core.hooksPath`
 * 一直是空的 —— 新 clone 的机器上没人知道要手动执行那行命令，于是 push 时
 * 根本不跑门禁（2026-11-06 因此带着 4 项未跑的门禁推上去，CI 全红）。
 * 挂到 postinstall 与 predev 上，克隆完装依赖就自动生效。
 *
 * 静默的场景：CI（不需要钩子）、不是 git 仓库（源码压缩包）。
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

if (process.env.CI || process.env.GITHUB_ACTIONS) process.exit(0);

const read = spawnSync("git", ["config", "core.hooksPath"], { cwd: repoRoot, encoding: "utf8" });
if (read.status !== 0) process.exit(0); // 不是 git 仓库：静默跳过

if ((read.stdout || "").trim() === ".githooks") process.exit(0);

const write = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (write.status === 0) {
  console.log("[hooks] 已启用 .githooks：提交前跑三项、push 前跑全量（清单见 scripts/lib/gate-plan.mjs）");
}
process.exit(write.status ?? 0);
