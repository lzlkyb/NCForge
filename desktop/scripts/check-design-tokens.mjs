#!/usr/bin/env node
/**
 * 设计 token 机器检查（双棘轮）。
 *
 * 1) 裸 hex：现有样式里大量色值是历史债务，全量清洗会牵动视觉回归；这里做的是
 *    **只降不升**的棘轮：每个文件的裸 hex 色值数量记进基线，新代码只要让任何文件
 *    多出一个色值就红，改动时顺手把它们换成 token 才允许通过。
 * 2) 裸表面底色：TSX 里直接写 `bg-card` / `bg-background`（不带 /xx 透明档）等于
 *    在玻璃材质下钉死一块实色。classic 里它们是对的，所以不要求删掉，而是按文件
 *    记棘轮：glass 侧必须同时有作用域内的覆盖规则（见 appearance.css），新文件
 *    一旦新增这种实色块就红，逼作者先想清楚这层会不会把玻璃戳穿。
 *
 * 统计口径：
 *   - 扫 src 下 .css / .tsx（排除 *.test.* 与 design-preview——后者是开发用走查页）。
 *   - 忽略注释里的色值（注释常写「原值 #f4f6f9」这类说明，不是真实使用）。
 *   - CSS 里 `--xxx: ...` 自定义属性定义行不算：token 的源头本来就必须是字面值，
 *     否则棘轮会把「新增一个 token」判成违规。
 *   - TSX 里 Tailwind 任意值（text-[#4f46e5]）和内联 style 的 hex 都算。
 *   - `bg-card/70`、`bg-card-foreground` 这类带透明档/后缀的写法不算「实底」。
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
const SURFACE_BASELINE = join(ROOT, "scripts", "surface-baseline.json");

const EXCLUDE = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /[\\/]design-preview[\\/]/];
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const SURFACE = /\bbg-(?:card|background)(?![/\w-])/g;

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

/** TSX 里的实底表面类。CSS 不算：覆盖规则本来就要写这些类名。 */
function scanSurfaces(file) {
  const lines = stripTsComments(readFileSync(file, "utf8")).split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(SURFACE)) hits.push(`${i + 1}:${m[0]}`);
  });
  return hits;
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

  const surfaceActual = new Map();
  for (const file of files.filter((f) => f.endsWith(".tsx"))) {
    const hits = scanSurfaces(file);
    if (hits.length) surfaceActual.set(rel(file), hits);
  }

  const hasBaseline = exists(BASELINE);
  const hasSurfaceBaseline = exists(SURFACE_BASELINE);
  if (!update && (!hasBaseline || !hasSurfaceBaseline)) {
    const missing = [!hasBaseline ? "design-token-baseline.json" : null, !hasSurfaceBaseline ? "surface-baseline.json" : null]
      .filter(Boolean)
      .join("、");
    console.error(`❌ 找不到棘轮基线：${missing}——基线必须随仓库提交。`);
    console.error("   确认后运行 `node scripts/check-design-tokens.mjs --update` 生成，并把它一起提交。");
    process.exit(1);
  }
  const baseline = hasBaseline ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  const surfaceBaseline = hasSurfaceBaseline ? JSON.parse(readFileSync(SURFACE_BASELINE, "utf8")) : {};
  const problems = [];

  if (!update) {
    for (const [file, { count, hits }] of actual) {
      const allowed = baseline[file] ?? 0;
      if (count > allowed) {
        problems.push(`${file}: ${allowed} → ${count}（新增 ${count - allowed} 个裸色值：${hits.slice(0, 6).join("、")}${hits.length > 6 ? " …" : ""}）`);
      }
    }
    if (hasSurfaceBaseline) {
      for (const [file, hits] of surfaceActual) {
        const allowed = surfaceBaseline[file] ?? 0;
        if (hits.length > allowed) {
          problems.push(`${file}: 实底表面 ${allowed} → ${hits.length}（${hits.slice(0, 4).join("、")}${hits.length > 4 ? " …" : ""}；classic 可留，但要在 appearance.css 的 glass 作用域里覆盖）`);
        }
      }
    }
  }

  if (problems.length) {
    console.error("❌ 设计 token 棘轮被突破（把新增色值换成 var(--token) 或复用现有 token；实底表面类见提示）：");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  let wrote = false;
  const next = {};
  for (const [file, { count }] of [...actual].sort(([a], [b]) => a.localeCompare(b))) {
    next[file] = count;
  }
  const nextSrc = `${JSON.stringify(next, null, 2)}\n`;
  if (update) {
    writeFileSync(BASELINE, nextSrc, "utf8");
    console.log(`✅ 基线已写入 scripts/design-token-baseline.json（${actual.size} 个文件有裸色值，共 ${[...actual.values()].reduce((n, v) => n + v.count, 0)} 处）`);
    wrote = true;
  } else if (readFileSync(BASELINE, "utf8") !== nextSrc) {
    console.log("ℹ️ 有文件的色值数量低于基线，可运行 --update 下调（不阻断）。");
  }

  const nextSurface = {};
  for (const [file, hits] of [...surfaceActual].sort(([a], [b]) => a.localeCompare(b))) {
    nextSurface[file] = hits.length;
  }
  const nextSurfaceSrc = `${JSON.stringify(nextSurface, null, 2)}\n`;
  if (update) {
    writeFileSync(SURFACE_BASELINE, nextSurfaceSrc, "utf8");
    console.log(`✅ 表面底色基线已写入 scripts/surface-baseline.json（${surfaceActual.size} 个文件有实底表面，共 ${[...surfaceActual.values()].reduce((n, v) => n + v.length, 0)} 处）`);
    wrote = true;
  } else if (readFileSync(SURFACE_BASELINE, "utf8") !== nextSurfaceSrc) {
    console.log("ℹ️ 有文件的实底表面数量低于基线，可运行 --update 下调（不阻断）。");
  }

  if (wrote) return;

  const total = [...actual.values()].reduce((n, v) => n + v.count, 0);
  const surfaceTotal = [...surfaceActual.values()].reduce((n, v) => n + v.length, 0);
  console.log(`✅ 设计 token 棘轮通过（${actual.size} 个文件 ${total} 处裸色值；${surfaceActual.size} 个文件 ${surfaceTotal} 处实底表面，均未超过基线）`);
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
