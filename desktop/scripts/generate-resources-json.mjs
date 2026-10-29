#!/usr/bin/env node
/**
 * generate-resources-json.mjs —— 读 pack-resources.mjs 的产物，拼下载 URL，
 * 生成发布版 resources.json（客户端唯一信任的清单）。
 *
 * 与 generate-updater-json.mjs 对齐的发布期变量（同一套镜像/多源机制）：
 *   RESOURCES_DOWNLOAD_BASE   下载基线 URL，默认 GitHub Release
 *   RESOURCES_URL_TEMPLATE    完全接管 URL 拼接，支持 {tag}/{filename} 占位符
 *                             （Gitee 的 raw 直链形状与 GitHub Release 不同，用它表达），
 *                             优先级高于 DOWNLOAD_BASE
 *   RESOURCES_OUTPUT_FILENAME 输出文件名，默认 resources.json（Gitee 变体可另起名）
 *   RESOURCES_MERGE_INTO      先读这份已有 json 的 packs 再按 id 覆盖，
 *                             用于「一次发布、多个 job 分别生成不同镜像变体」的场景
 *   GITHUB_REPOSITORY / GITHUB_RELEASE_TAG   与 updater 同源
 *
 * 与 updater 合并语义的差异：updater 按**平台**分条目（windows/mac 各自构建），
 * 资源包是全平台共用的同一个 zip，按 id 覆盖即可，不存在「新 windows + 旧 mac」
 * 的混合 manifest 问题——但仍保留版本一致性校验，防止拉错基线文件。
 *
 * 输入：dist/resource-packs/manifest.json（pack-resources.mjs 产出）
 * 输出：dist/resources.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "dist", "resource-packs", "manifest.json");

const [FALLBACK_OWNER, FALLBACK_REPO] = ["your-name", "your-app"];
const [REPO_OWNER, REPO_NAME] = (process.env.GITHUB_REPOSITORY || `${FALLBACK_OWNER}/${FALLBACK_REPO}`).split("/");
const GITHUB_RELEASE_BASE =
  process.env.RESOURCES_DOWNLOAD_BASE ||
  `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download`;
const URL_TEMPLATE = process.env.RESOURCES_URL_TEMPLATE || null;
const OUTPUT_FILENAME = process.env.RESOURCES_OUTPUT_FILENAME || "resources.json";
const MERGE_INTO = process.env.RESOURCES_MERGE_INTO || null;

function fail(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`);
}
function success(msg) {
  console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
}
function warn(msg) {
  console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`);
}

function readVersionFromConf() {
  const confPath = path.join(ROOT, "src-tauri", "tauri.conf.json");
  if (!fs.existsSync(confPath)) fail(`找不到 tauri.conf.json: ${confPath}`);
  const conf = JSON.parse(fs.readFileSync(confPath, "utf-8"));
  if (!conf.version) fail("tauri.conf.json 中未找到 version 字段");
  return conf.version;
}

function buildDownloadUrl(tag, fileName) {
  // replaceAll 而非 replace：模板里 {tag} 可能出现不止一次（Gitee 模板
  // ".../raw/{tag}/releases/{tag}/{filename}"），单次 replace 会留下未替换的 {tag}。
  return URL_TEMPLATE
    ? URL_TEMPLATE.replaceAll("{tag}", tag).replaceAll("{filename}", fileName)
    : `${GITHUB_RELEASE_BASE}/${tag}/${fileName}`;
}

function loadMergeBase() {
  if (!MERGE_INTO) return { packs: {} };
  if (!fs.existsSync(MERGE_INTO)) {
    warn(`RESOURCES_MERGE_INTO 指向的文件不存在，本次只写本次产物：${MERGE_INTO}`);
    return { packs: {} };
  }
  try {
    const base = JSON.parse(fs.readFileSync(MERGE_INTO, "utf-8"));
    const packs = {};
    for (const p of base.packs || []) packs[p.id] = p;
    info(`已从 ${MERGE_INTO} 读入 ${Object.keys(packs).length} 个已有条目：${Object.keys(packs).join(", ") || "(空)"}`);
    return { packs };
  } catch (e) {
    warn(`解析 RESOURCES_MERGE_INTO 失败，本次只写本次产物：${e.message}`);
    return { packs: {} };
  }
}

function main() {
  if (!fs.existsSync(MANIFEST)) {
    fail(`找不到 ${MANIFEST}\n请先运行: node scripts/pack-resources.mjs`);
  }
  let local;
  try {
    local = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
  } catch (e) {
    fail(`解析 manifest.json 失败: ${e.message}`);
  }
  if (!local.packs || local.packs.length === 0) fail("manifest.json 里没有任何包");

  const version = readVersionFromConf();
  const tag = process.env.GITHUB_RELEASE_TAG || `v${version}`;

  info(`仓库: ${REPO_OWNER}/${REPO_NAME}`);
  info(`Release Tag: ${tag}`);
  info(`清单来源: ${MANIFEST}`);

  const merge = loadMergeBase();

  // 本地产物为权威（本次构建的内容），按 id 覆盖基线条目；基线里本次没打的包
  // （例如只在另一个平台打的）原样保留——与 updater 的跨 job 合并同方向。
  const merged = { ...merge.packs };
  for (const p of local.packs) {
    // 发布前自检：sha256 必须是 64 位十六进制、size > 0。坏字段会让客户端在
    // 下载后 signature 失败，而那时用户已经等了整个下载时间。
    if (!/^[0-9a-f]{64}$/.test(p.sha256)) fail(`${p.id} 的 sha256 不是 64 位十六进制：${p.sha256}`);
    if (!(p.size > 0)) fail(`${p.id} 的 size 非法：${p.size}`);
    if (!p.version) fail(`${p.id} 缺少 version（内容寻址串）`);
    merged[p.id] = {
      id: p.id,
      version: p.version,
      title: p.title,
      notes: p.notes,
      ...(p.platforms && p.platforms.length ? { platforms: p.platforms } : {}),
      size: p.size,
      sha256: p.sha256,
      url: buildDownloadUrl(tag, p.file),
    };
    success(`${p.id}: v${p.version}（${(p.size / 1024 / 1024).toFixed(1)}MB）→ ${merged[p.id].url}`);
  }

  const out = { packs: Object.values(merged) };
  const distDir = path.join(ROOT, "dist");
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  const outputPath = path.join(distDir, OUTPUT_FILENAME);
  fs.writeFileSync(outputPath, `${JSON.stringify(out, null, 2)}\n`, "utf-8");

  success(`已生成: ${outputPath}（${out.packs.length} 个包）`);
  info("提示：把 <out>/*.zip 与 resources.json 一起上传为 release 资产（CI 自动做）");
}

main();
