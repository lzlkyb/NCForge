#!/usr/bin/env node
/**
 * gitee-manifest.mjs —— 由 updater.json / resources.json 生成 Gitee 变体清单。
 *
 * 为什么需要它：这两份变体要把 GitHub 的下载地址换成 Gitee 的，其余字段（version /
 * notes / signature / sha256）原样搬——签名与哈希的正确性由构建期保证，镜像阶段
 * 重算一遍既没能力也没必要（还要把 60MB 的 zip 再下一次）。
 *
 * 🔴 为什么 URL 指向「发行版附件」而不是 raw 分支（2026-11-05 实测）：
 *   Gitee 的 raw 对大于 ~50MB 的文件返回 403 `large file require login for access`，
 *   匿名客户端读不到。jdtls.zip 56MB 正好踩线 → raw 方案对大文件直接作废。
 *   发行版附件（releases/download/<tag>/<file>）匿名可下、2MB/s，且不污染 git 历史。
 *   代价是 URL 里带 tag，所以每次发版清单都要重新生成（本来也要）。
 *
 * 用法：
 *   node scripts/gitee-manifest.mjs <输入目录> <输出目录> --repo owner/repo --tag v1.2.3
 *
 * 输入目录里需要：
 *   updater.json    → 产出 updater-gitee.json（任一缺失则跳过该份）
 *   resources.json  → 产出 resources-gitee.json
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
function takeFlag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const repo = (takeFlag("--repo") || process.env.GITEE_REPOSITORY || "").trim();
const tag = (takeFlag("--tag") || process.env.GITEE_TAG || "").trim();
// 位置参数只取不以 -- 开头、且不是某个 flag 的值的项。
const flagsWithValue = new Set(["--repo", "--tag"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !flagsWithValue.has(argv[i - 1]));

// 目录也可走环境变量：CI 里用 `npm run gitee:manifest`（让 knip 能看到这个脚本被
// 引用），此时没法传位置参数，Windows 路径还容易在 npm 的多层引号里被吃掉。
const inDir = positional[0] || process.env.GITEE_ASSET_DIR || "";
const outDir = positional[1] || process.env.GITEE_OUT_DIR || "";

if (!inDir || !outDir) {
  fail(
    "用法: node scripts/gitee-manifest.mjs <输入目录> <输出目录> --repo owner/repo --tag v1.2.3\n" +
      "      或设环境变量 GITEE_ASSET_DIR / GITEE_OUT_DIR / GITEE_REPOSITORY / GITEE_TAG。",
  );
}
if (!repo) {
  fail("缺少 Gitee 仓库路径（--repo owner/repo 或环境变量 GITEE_REPOSITORY）。");
}
if (!tag) {
  fail("缺少版本 tag（--tag v1.2.3 或环境变量 GITEE_TAG）：附件地址里必须带 tag。");
}

// 发行版附件直链：客户端不带任何凭证也能下（raw 分支对 >50MB 的文件会 403）。
const URL_BASE = `https://gitee.com/${repo}/releases/download/${tag}`;

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
    p.url = `${URL_BASE}/${baseName(p.url)}`;
  }
  return { data, keys };
}

function rewriteResources(src) {
  const data = JSON.parse(fs.readFileSync(src, "utf-8"));
  const packs = Array.isArray(data.packs) ? data.packs : [];
  if (!packs.length) fail(`${src} 里没有 packs，无法生成 Gitee 变体`);
  for (const p of packs) {
    if (!p.url) fail(`${src} 的包 ${p.id || "?"} 缺 url`);
    p.url = `${URL_BASE}/${baseName(p.url)}`;
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
info(`输出目录：${outDir}；URL 前缀：${URL_BASE}`);
