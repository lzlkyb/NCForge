#!/usr/bin/env node
/**
 * 设计 token 机器检查（棘轮）。
 *
 * 目标不是「一次性消灭所有色值」——现有样式里大量色值是历史债务，全量清洗会牵动
 * 视觉回归；这里做的是**只降不升**的棘轮：每个文件的裸 hex 色值数量记进基线，
 * 新代码只要让任何文件多出一个色值就红，改动时顺手把它们换成 token 才允许通过。
 *
 * 统计口径：
 *   - 扫 src 下 .css / .tsx（排除 *.test.* 与 design-preview——后者是开发用走查页）。
 *   - 忽略注释里的色值（注释常写「原值 #f4f6f9」这类说明，不是真实使用）。
 *   - CSS 里 `--xxx: ...` 自定义属性定义行不算：token 的源头本来就必须是字面值，
 *     否则棘轮会把「新增一个 token」判成违规。
 *   - TSX 里 Tailwind 任意值（text-[#4f46e5]）和内联 style 的 hex 都算。
 *
 * 用法：
 *   node scripts/check-design-tokens.mjs          # 校验（pre-push / CI）
 *   node scripts/check-design-tokens.mjs --update # 下调基线（色值变少时）
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");
const BASELINE = join(ROOT, "scripts", "design-token-baseline.json");

const EXCLUDE = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /[\\/]design-preview[\\/]/];
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (file) => relative(ROOT, file).split(sep).join("/");

function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function stripTsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** @returns {{count: number, hits: string[]}} */
function scan(file) {
  const isCss = file.endsWith(".css");
  const raw = readFileSync(file, "utf8");
  const lines = (isCss ? stripCssComments(raw) : stripTsComments(raw)).split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (isCss && /^--[\w-]+\s*:/.test(trimmed)) return;
    const found = line.match(HEX);
    if (found) for (const h of found) hits.push(`${i + 1}:${h}`);
  });
  return { count: hits.length, hits };
}

function main() {
  const update = process.argv.includes("--update");
  const files = walk(SRC).filter(
    (f) => (f.endsWith(".css") || f.endsWith(".tsx")) && !EXCLUDE.some((re) => re.test(f)),
  );

  const actual = new Map();
  for (const file of files) {
    const { count, hits } = scan(file);
    if (count > 0) actual.set(rel(file), { count, hits });
  }

  const hasBaseline = exists(BASELINE);
  const baseline = hasBaseline ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  const problems = [];

  if (!update) {
    for (const [file, { count, hits }] of actual) {
      const allowed = baseline[file] ?? 0;
      if (count > allowed) {
        problems.push(`${file}: ${allowed} → ${count}（新增 ${count - allowed} 个裸色值：${hits.slice(0, 6).join("、")}${hits.length > 6 ? " …" : ""}）`);
      }
    }
  }

  if (problems.length) {
    console.error("❌ 设计 token 棘轮被突破（把新增色值换成 var(--token) 或复用现有 token）：");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const next = {};
  for (const [file, { count }] of [...actual].sort(([a], [b]) => a.localeCompare(b))) {
    next[file] = count;
  }
  const nextSrc = `${JSON.stringify(next, null, 2)}\n`;

  if (update || !hasBaseline) {
    writeFileSync(BASELINE, nextSrc, "utf8");
    console.log(`✅ 基线已写入 scripts/design-token-baseline.json（${actual.size} 个文件有裸色值，共 ${[...actual.values()].reduce((n, v) => n + v.count, 0)} 处）`);
    return;
  }

  if (BASELINE && readFileSync(BASELINE, "utf8") !== nextSrc) {
    console.log("ℹ️ 有文件的色值数量低于基线，可运行 --update 下调（不阻断）。");
  }
  const total = [...actual.values()].reduce((n, v) => n + v.count, 0);
  console.log(`✅ 设计 token 棘轮通过（${actual.size} 个文件，共 ${total} 处裸色值，均未超过基线）`);
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
