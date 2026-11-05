#!/usr/bin/env node
/**
 * gitee-manifest.mjs —— 由**已有的** updater.json / resources.json 生成 Gitee raw 变体。
 *
 * 为什么需要它：正常发版里这两份变体由 generate-*.mjs 直接从构建产物生成；但补镜像
 * （workflow_dispatch → mirror_only）手上只有 Release 上的资产，没有构建产物目录。
 * 此时唯一要变的只有下载 URL：GitHub / ghproxy 的 "…/releases/download/<tag>/<file>"
 * 换成 Gitee 的 "…/raw/releases/latest/<file>"，签名与 sha256 原样搬。
 *
 * 用法：
 *   node scripts/gitee-manifest.mjs <输入目录> <输出目录> --repo owner/repo
 *
 * 输入目录里需要：
 *   updater.json    → 产出 updater-gitee.json（任一缺失则跳过该份）
 *   resources.json  → 产出 resources-gitee.json
 *
 * 只改 url，不动 version / notes / signature / sha256：这些字段的正确性由构建期
 * 保证，补镜像阶段没有能力也没有理由重新计算（重算 sha256 得再下一次 60MB 的 zip）。
 */

import fs from "node:fs";
import path from "node:path";

function fail(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`);
}
function ok(msg) {
  console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
}
function warn(msg) {
  console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`);
}

const argv = process.argv.slice(2);
const repoIdx = argv.indexOf("--repo");
const repo = (repoIdx >= 0 ? argv[repoIdx + 1] : process.env.GITEE_REPOSITORY || "").trim();
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--repo"));

// 目录也可走环境变量：CI 里用 `npm run gitee:manifest`（让 knip 能看到这个脚本被
// 引用），此时没法传位置参数，Windows 路径还容易在 npm 的多层引号里被吃掉。
const inDir = positional[0] || process.env.GITEE_ASSET_DIR || "";
const outDir = positional[1] || process.env.GITEE_OUT_DIR || "";

if (!inDir || !outDir) {
  fail(
    "用法: node scripts/gitee-manifest.mjs <输入目录> <输出目录> --repo owner/repo\n" +
      "      或设环境变量 GITEE_ASSET_DIR / GITEE_OUT_DIR。",
  );
}
if (!repo) {
  fail("缺少 Gitee 仓库路径（--repo owner/repo 或环境变量 GITEE_REPOSITORY）。");
}

// raw 直链：客户端 tauri.conf.json 的 resourcePacks.endpoints 与 updater 的 Gitee
// 候选组读的都是这个形状（owner/repo/raw/<branch>/<path>），与 GitHub Release 的
// "<base>/<tag>/<file>" 完全不同，所以只能按文件名重建，不能拼 tag。
const RAW_BASE = `https://gitee.com/${repo}/raw/releases/latest`;

/** 取文件名：容忍 query/hash，也容忍 gh-proxy 那种 "前缀/https://github.com/…" 套娃。 */
function baseName(url) {
  const clean = String(url).split(/[?#]/)[0];
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  if (!name) fail(`无法从 URL 取文件名（镜像会指向目录而不是文件）：${url}`);
  return decodeURIComponent(name);
}

function rewriteUpdater(src) {
  const data = JSON.parse(fs.readFileSync(src, "utf-8"));
  const platforms = data.platforms || {};
  const keys = Object.keys(platforms);
  if (!keys.length) fail(`${src} 里没有 platforms 条目，无法生成 Gitee 变体`);
  for (const k of keys) {
    const p = platforms[k];
    if (!p || !p.url) fail(`${src} 的 platforms.${k} 缺 url`);
    if (!p.signature || !String(p.signature).trim()) {
      // 空签名会让 mac/win 客户端下到包却验签失败，且毫无报错——宁可这一步就红。
      fail(`${src} 的 platforms.${k}.signature 为空，拒绝生成会让用户装不上的清单`);
    }
    p.url = `${RAW_BASE}/${baseName(p.url)}`;
  }
  return { data, keys };
}

function rewriteResources(src) {
  const data = JSON.parse(fs.readFileSync(src, "utf-8"));
  const packs = Array.isArray(data.packs) ? data.packs : [];
  if (!packs.length) fail(`${src} 里没有 packs，无法生成 Gitee 变体`);
  for (const p of packs) {
    if (!p.url) fail(`${src} 的包 ${p.id || "?"} 缺 url`);
    p.url = `${RAW_BASE}/${baseName(p.url)}`;
  }
  return { data, packs };
}

if (!fs.existsSync(inDir)) fail(`输入目录不存在：${inDir}`);
fs.mkdirSync(outDir, { recursive: true });

let produced = 0;

const updaterSrc = path.join(inDir, "updater.json");
if (fs.existsSync(updaterSrc)) {
  const { data, keys } = rewriteUpdater(updaterSrc);
  const out = path.join(outDir, "updater-gitee.json");
  fs.writeFileSync(out, JSON.stringify(data, null, 2) + "\n", "utf-8");
  ok(`updater-gitee.json ← ${keys.join(", ")}（version ${data.version}）`);
  produced += 1;
} else {
  warn(`没有 ${updaterSrc}，跳过 updater-gitee.json`);
}

const resourcesSrc = path.join(inDir, "resources.json");
if (fs.existsSync(resourcesSrc)) {
  const { data, packs } = rewriteResources(resourcesSrc);
  const out = path.join(outDir, "resources-gitee.json");
  fs.writeFileSync(out, JSON.stringify(data, null, 2) + "\n", "utf-8");
  ok(`resources-gitee.json ← ${packs.length} 个包（${packs.map((p) => p.id).join(", ")}）`);
  produced += 1;
} else {
  warn(`没有 ${resourcesSrc}，跳过 resources-gitee.json`);
}

if (!produced) fail(`输入目录里既没有 updater.json 也没有 resources.json：${inDir}`);
info(`输出目录：${outDir}；URL 前缀：${RAW_BASE}`);
