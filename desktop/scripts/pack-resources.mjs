#!/usr/bin/env node
/**
 * pack-resources.mjs —— 把 jdtls / ecj / svnkit 三个大块资源打成 zip，并生成本地
 * manifest（含内容寻址版本、大小、SHA-256）。产物体积见文件尾注释。
 *
 * 为什么打 zip 而不是原样传目录：release 资产只支持单文件；zip 同时给了我们
 * 「一个文件 = 一个版本」的原子单元（版本号取 zip 的 SHA-256 前 12 位，内容变
 * ⇒ 版本变 ⇒ 客户端重下，机械正确，不需要人维护版本表）。
 *
 * 用法：
 *   node scripts/pack-resources.mjs                 打到 dist/resource-packs/
 *   node scripts/pack-resources.mjs --out <dir>     指定输出目录
 * 环境变量：
 *   RESOURCES_PLATFORMS   逗号分隔，默认 "windows"（当前只发 Windows；
 *                         jdtls 已裁掉 linux/macOS 插件，写全平台会骗人）
 *
 * 前置：jdtls 目录不存在时自动调 scripts/fetch-jdtls.mjs 准备（与构建时同一份
 * 裁剪逻辑：锁定 0.57.0 + SHA-256 校验 + 只留 Windows 平台插件）。
 *
 * 产物：
 *   <out>/{jdtls,ecj,svnkit}.zip
 *   <out>/manifest.json    —— 本地版清单；URL 由 generate-resources-json.mjs 拼
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildZip, zipEntriesFromDir } from "./lib/zip-store.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const RESOURCES = join(SRC_TAURI, "resources");
const DEFAULT_OUT = join(ROOT, "dist", "resource-packs");

/** 与 Rust 侧 resource_pack::ALL_PACKS 的 id / title / notes 一一对应（改一边同步另一边）。 */
const PACKS = [
  {
    id: "jdtls",
    dir: join(RESOURCES, "jdtls"),
    title: "Java 语言服务",
    notes: "补全、跳转、悬停与实时错误提示（jdt.ls 0.57.0）",
    // 占位 README 与构建标记不是运行内容，不进包
    skip: (rel) => rel === "README.md" || rel === ".bundled-version",
  },
  {
    id: "ecj",
    dir: join(RESOURCES, "ecj"),
    title: "Java 编译器",
    notes: "编译 NC 模块，输出错误清单",
    skip: () => false,
  },
  {
    id: "svnkit",
    dir: join(RESOURCES, "svnkit"),
    title: "SVN 客户端",
    notes: "代码检出与更新",
    skip: () => false,
  },
];

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

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** jdtls 目录未就绪就先拉取裁剪（与 prebuild 同一脚本，--force 由调用方决定）。 */
function ensureJdtlsReady(dir) {
  if (existsSync(join(dir, "plugins")) && existsSync(join(dir, "config_win"))) return;
  info("jdtls 目录未就绪，先执行 fetch-jdtls.mjs");
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "fetch-jdtls.mjs")], {
    stdio: "inherit",
  });
  if (r.status !== 0) fail(`fetch-jdtls.mjs 失败（退出码 ${r.status}）`);
  if (!existsSync(join(dir, "plugins")) || !existsSync(join(dir, "config_win"))) {
    fail(`fetch-jdtls.mjs 跑完了但 ${dir} 仍不完整（缺 plugins/ 或 config_win/）`);
  }
}

function main() {
  const outArgIndex = process.argv.indexOf("--out");
  const outDir = outArgIndex > -1 ? process.argv[outArgIndex + 1] : DEFAULT_OUT;
  if (outArgIndex > -1 && !outDir) fail("--out 需要一个目录参数");
  const platforms = (process.env.RESOURCES_PLATFORMS || "windows")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  mkdirSync(outDir, { recursive: true });

  const packs = [];
  for (const pack of PACKS) {
    // jdtls 未就绪时先拉取裁剪（与构建时同一份逻辑）；ecj/svnkit 是仓库里的小 jar，
    // 目录缺失就是仓库被动了，直接红。ensureJdtlsReady 内部有 exists 短路，已就绪时零成本。
    if (pack.id === "jdtls") ensureJdtlsReady(pack.dir);
    if (!existsSync(pack.dir)) fail(`资源目录不存在：${pack.dir}`);

    const entries = zipEntriesFromDir(pack.dir, pack.skip);
    if (entries.length === 0) fail(`${pack.dir} 是空目录，拒绝打出空包（打出去了客户端全部 signature 失败）`);
    const zip = buildZip(entries);
    const digest = sha256(zip);
    const fileName = `${pack.id}.zip`;
    const zipPath = join(outDir, fileName);
    writeFileSync(zipPath, zip);

    packs.push({
      id: pack.id,
      file: fileName,
      // 内容寻址版本：zip 的 SHA-256 前 12 位。内容变 ⇒ 版本变 ⇒ 客户端重下。
      version: digest.slice(0, 12),
      title: pack.title,
      notes: pack.notes,
      size: zip.length,
      sha256: digest,
      platforms,
    });
    success(`${pack.id}: ${fileName}（${(zip.length / 1024 / 1024).toFixed(1)}MB, ${entries.length} 项, v${digest.slice(0, 12)}）`);
  }

  // 本地 manifest：给 generate-resources-json.mjs 消费（URL 拼装 + 镜像变体）。
  // 不含 URL——发布形态（GitHub Release / Gitee 镜像）是发布期的事，与打包解耦。
  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), packs }, null, 2)}\n`,
    "utf-8",
  );

  const total = packs.reduce((s, p) => s + p.size, 0);
  info(`清单: ${manifestPath}`);
  info(`合计: ${(total / 1024 / 1024).toFixed(1)}MB → 安装包只需带 ncdb.jar（7KB）`);
  info("下一步: node scripts/generate-resources-json.mjs 生成 resources.json");
}

main();
