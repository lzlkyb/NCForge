#!/usr/bin/env node
/**
 * 前端产物体积门禁（棘轮）。
 *
 * 为什么不用 size-limit：它要额外装依赖、默认按单文件粒度配上限，而这里真正想拦的是
 * 「有人无意间把一个大依赖拖进首屏」——总 gzip 体量和最大 chunk 两条线足够，且零依赖，
 * 和 scripts/ 下其它门禁的形态一致。
 *
 * 口径：dist/assets/*.js（vite 产物）。gzip 用 level 9 现算，与发布包里的压缩率同量级。
 *
 * 用法：
 *   npm run vite:build && npm run bundle:check   # 校验
 *   node scripts/check-bundle-size.mjs --update  # 体积确实变大且合理时，上调预算
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIST = join(ROOT, "dist", "assets");
const BUDGET = join(ROOT, "scripts", "bundle-budget.json");

const kb = (n) => Math.round(n / 1024);

function main() {
  let names;
  try {
    names = readdirSync(DIST).filter((f) => f.endsWith(".js"));
  } catch {
    console.error("❌ 找不到 dist/assets——先跑 `npm run vite:build` 再校验体积。");
    process.exit(1);
  }

  let raw = 0;
  let gz = 0;
  const chunks = [];
  for (const name of names) {
    const bytes = readFileSync(join(DIST, name));
    const gzip = gzipSync(bytes, { level: 9 }).length;
    raw += bytes.length;
    gz += gzip;
    chunks.push({ name, raw: bytes.length, gzip });
  }

  const maxChunk = chunks.reduce((a, b) => (b.raw > a.raw ? b : a), { name: "-", raw: 0 });
  const actual = { totalRawKB: kb(raw), totalGzipKB: kb(gz), maxChunkRawKB: kb(maxChunk.raw) };
  const update = process.argv.includes("--update");

  if (update || !exists(BUDGET)) {
    writeFileSync(BUDGET, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    console.log(`✅ 体积预算已写入 scripts/bundle-budget.json（${actual.totalGzipKB} KB gzip / ${actual.totalRawKB} KB raw / 最大 chunk ${actual.maxChunkRawKB} KB）`);
    return;
  }

  const budget = JSON.parse(readFileSync(BUDGET, "utf8"));
  const over = Object.keys(budget).filter((k) => actual[k] > budget[k]);
  const fmt = (k) => `${k}: ${budget[k]} KB → ${actual[k]} KB`;

  console.log(`JS 产物：${chunks.length} 个 chunk，${actual.totalGzipKB} KB gzip / ${actual.totalRawKB} KB raw`);
  console.log(`  最大 chunk：${maxChunk.name}（${actual.maxChunkRawKB} KB raw）`);
  console.log(`  预算：${Object.entries(budget).map(([k, v]) => `${k}=${v}KB`).join("，")}`);

  if (over.length) {
    console.error("❌ 体积超出预算：");
    for (const k of over) console.error(`  - ${fmt(k)}`);
    console.error("   确认增长合理后运行 `node scripts/check-bundle-size.mjs --update` 上调预算，并在提交说明里写清原因。");
    process.exit(1);
  }

  console.log("✅ 体积预算通过");
}

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

main();
