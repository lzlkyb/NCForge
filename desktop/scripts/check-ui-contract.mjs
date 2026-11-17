#!/usr/bin/env node
/**
 * UI 约定门禁（棘轮 + 两条硬约束）。
 *
 * 两条棘轮项（存量记基线，只许减）：
 *   1. 缓动只能用 token：CSS 里除 `--ease*:` 定义行外，不允许出现裸
 *      `cubic-bezier(...)`——否则全站会出现十几条肉眼难辨却不一致的曲线。
 *   2. 字号下限 10px：10px 以下的中文正文/徽章在 1080p 缩放下已经糊成一团。
 *
 * 两条硬约束（现在就是 0，新增即红，所以不需要基线）：
 *   3. 图标按钮必须有可达名称：`<button>` 内既无可见文本、又无 `aria-label` /
 *      `aria-labelledby` / `title` 的，读屏只会念「按钮」。2026-11-17 全仓实测 0 处，
 *      说明这是既有标准，只是没人把它钉住。
 *   4. 「跳到主要内容」必须存在：`src/App.tsx` 要有 `href="#main"`，
 *      主内容区要有 `id="main"`（WCAG 2.4.1）。重构外壳时最容易把它删掉。
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
const BUTTON = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
const BUTTON_NAME = /aria-label|aria-labelledby|title=/;
const SKIP_LINK = ['href="#main"', 'id="main"'];

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

/** 图标按钮可达名称：只有「无文本 + 无表达式 + 无标签属性」三条同时成立才报。
 *  表达式放行是因为静态看不出它渲染什么，宁可漏报也不误报（误报会让门禁失去威信）。 */
function unnamedButtons(file, src) {
  if (!file.endsWith(".tsx")) return [];
  const out = [];
  for (const m of src.matchAll(BUTTON)) {
    if (BUTTON_NAME.test(m[1])) continue;
    const body = m[2].replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
    const text = body.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
    if (text.length > 0 || body.includes("{")) continue;
    out.push(String(src.slice(0, m.index).split("\n").length));
  }
  return out;
}

/** @returns {{easing: string[], tinyFont: string[], unnamedButton: string[]}} */
function scan(file) {
  const isCss = file.endsWith(".css");
  const raw = stripComments(readFileSync(file, "utf8"));
  const lines = raw.split("\n");
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
  return { easing, tinyFont, unnamedButton: unnamedButtons(file, raw) };
}

function main() {
  const update = process.argv.includes("--update");
  const files = walk(SRC).filter(
    (f) => (f.endsWith(".css") || f.endsWith(".tsx") || f.endsWith(".ts")) && !EXCLUDE.some((re) => re.test(f)),
  );

  const actual = new Map();
  const hardProblems = [];
  for (const file of files) {
    const { easing, tinyFont, unnamedButton } = scan(file);
    if (unnamedButton.length) {
      hardProblems.push(
        `${rel(file)}: 图标按钮无可达名称 ${unnamedButton.length} 处（第 ${unnamedButton.slice(0, 5).join("、")} 行；补 aria-label 或可见文本）`,
      );
    }
    if (easing.length || tinyFont.length) actual.set(rel(file), { easing, tinyFont });
  }

  // 「跳到主要内容」：重构外壳时最容易顺手删掉的一条。
  const appFile = files.find((f) => rel(f) === "src/App.tsx");
  const appSrc = appFile ? readFileSync(appFile, "utf8") : "";
  for (const needle of SKIP_LINK) {
    if (!appSrc.includes(needle)) {
      hardProblems.push(`src/App.tsx: 缺少「跳到主要内容」结构（需要 \`${needle}\`，WCAG 2.4.1）`);
    }
  }

  if (hardProblems.length) {
    console.error("❌ UI 约定硬约束被突破（这两项没有基线，0 容忍）：");
    for (const p of hardProblems) console.error(`  - ${p}`);
    process.exit(1);
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
