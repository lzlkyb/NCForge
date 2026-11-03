#!/usr/bin/env node
/**
 * UI 约定门禁（棘轮）。
 *
 * 两条机器可判的约定，其余（焦点可见、键盘可达）靠组件测试和 review：
 *   1. 缓动只能用 token：CSS 里除 `--ease*:` 定义行外，不允许出现裸
 *      `cubic-bezier(...)`——否则全站会出现十几条肉眼难辨却不一致的曲线。
 *   2. 字号下限 10px：10px 以下的中文正文/徽章在 1080p 缩放下已经糊成一团。
 *      存量违规记进基线（只许减），新增 < 10px 直接红。
 *
 * TSX 里 Tailwind 的 `text-[Npx]` 与内联 `style={{ fontSize: N }}` 也纳入检查
 * （CSS 之外的入口同样会绕过 token）；`lib/motion.ts` 例外——JS 动画库读不到 CSS 变量。
 *
 * 用法：
 *   node scripts/check-ui-contract.mjs          # 校验
 *   node scripts/check-ui-contract.mjs --update # 下调基线
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");
const BASELINE = join(ROOT, "scripts", "ui-contract-baseline.json");

const EXCLUDE = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /[\\/]design-preview[\\/]/, /[\\/]motion\.ts$/];
const EASING = /cubic-bezier\([^)]*\)/g;
const FONT = /font-size\s*:\s*([0-9.]+)px/g;
const TW_FONT = /text-\[([0-9.]+)px\]/g;
const INLINE_FONT = /fontSize\s*:\s*(?:["'])?([0-9.]+)(?:px)?/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (file) => relative(ROOT, file).split(sep).join("/");

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_, p) => p);
}

/** @returns {{easing: string[], tinyFont: string[]}} */
function scan(file) {
  const isCss = file.endsWith(".css");
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  const easing = [];
  const tinyFont = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // token 定义行是字面值唯一合法的归宿
    const isDefinition = /^--ease[\w-]*\s*:/.test(trimmed);
    if (!isDefinition) {
      for (const m of line.matchAll(EASING)) easing.push(`${i + 1}:${m[0]}`);
    }
    for (const m of line.matchAll(isCss ? FONT : TW_FONT)) {
      if (Number(m[1]) < 10) tinyFont.push(`${i + 1}:${m[1]}px`);
    }
    if (!isCss) {
      for (const m of line.matchAll(INLINE_FONT)) {
        if (Number(m[1]) < 10) tinyFont.push(`${i + 1}:${m[1]}px inline`);
      }
    }
  });
  return { easing, tinyFont };
}

function main() {
  const update = process.argv.includes("--update");
  const files = walk(SRC).filter(
    (f) => (f.endsWith(".css") || f.endsWith(".tsx") || f.endsWith(".ts")) && !EXCLUDE.some((re) => re.test(f)),
  );

  const actual = new Map();
  for (const file of files) {
    const { easing, tinyFont } = scan(file);
    if (easing.length || tinyFont.length) actual.set(rel(file), { easing, tinyFont });
  }

  const hasBaseline = exists(BASELINE);
  if (!update && !hasBaseline) {
    console.error("❌ 找不到 scripts/ui-contract-baseline.json——棘轮基线必须随仓库提交。");
    console.error("   确认后运行 `node scripts/check-ui-contract.mjs --update` 生成，并把它一起提交。");
    process.exit(1);
  }
  const baseline = hasBaseline ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  const problems = [];
  const next = {};

  for (const [file, { easing, tinyFont }] of [...actual].sort(([a], [b]) => a.localeCompare(b))) {
    const allowed = baseline[file] ?? { easing: 0, tinyFont: 0 };
    const eAllowed = allowed.easing ?? 0;
    const fAllowed = allowed.tinyFont ?? 0;
    if (!update && easing.length > eAllowed) {
      problems.push(`${file}: 裸缓动 ${eAllowed} → ${easing.length}（改用 var(--ease*)：${easing.slice(0, 4).join("、")}）`);
    }
    if (!update && tinyFont.length > fAllowed) {
      problems.push(`${file}: <10px 字号 ${fAllowed} → ${tinyFont.length}（${tinyFont.slice(0, 4).join("、")}）`);
    }
    next[file] = { easing: easing.length, tinyFont: tinyFont.length };
  }

  if (problems.length) {
    console.error("❌ UI 约定门禁被突破：");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  if (update) {
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`✅ UI 约定基线已写入 scripts/ui-contract-baseline.json（${actual.size} 个文件有存量）`);
    return;
  }

  const totalEase = [...actual.values()].reduce((n, v) => n + v.easing.length, 0);
  const totalFont = [...actual.values()].reduce((n, v) => n + v.tinyFont.length, 0);
  console.log(`✅ UI 约定门禁通过（裸缓动 ${totalEase} 处、<10px 字号 ${totalFont} 处，均未超过基线）`);
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
