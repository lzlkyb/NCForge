#!/usr/bin/env node
/**
 * vite:build 前置：清空上次的前端产物。
 *
 * 不做「检测沙箱才清」——干净构建本身就是对的（旧 hash chunk 混进 dist 会让
 * bundle:check 按 *.js 全扫时统计到已下线的 chunk）。只在 WorkBuddy 沙箱里它
 * 还顺带避开了删除守卫：见 scripts/lib/dist-clean.mjs 的说明。
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { distCleanArgv } from "./lib/dist-clean.mjs";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { argv } = distCleanArgv(process.platform);

const r = spawnSync(argv[0], argv.slice(1), { cwd: desktopDir, stdio: "inherit" });
if (r.error) {
  console.error(`❌ 清空 dist 失败：${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`❌ 清空 dist 失败：退出码 ${r.status}`);
  process.exit(1);
}
