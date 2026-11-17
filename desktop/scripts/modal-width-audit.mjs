#!/usr/bin/env node
/**
 * 弹层宽度实测（人工跑的审计，不进 CI）。
 *
 * 为什么需要它：`tokens:check` 只能静态证明「代码里写的是 var(--w-modal-*)」，
 * 证明不了「这个变量在当时那个元素上真的解析成了 620px」。CSS 模块没加载、
 * 令牌拼错、被更高特异性规则覆盖，静态检查全都看不见。
 * 2026-11-17 就是靠它发现两个静态检查抓不到的问题：
 *   · ShortcutSheet 自写 `w-[min(720px,92vw)]`（720 不在档位里）
 *   · 密度档令牌只在字面上切换，顶栏/侧栏几何完全不动
 *
 * 用法：
 *   1) npm run vite:dev（端口被占时 `npx vite --port 1422`）
 *   2) node scripts/modal-width-audit.mjs --url=http://localhost:1422
 *
 * 清单不写死：从 CSS 里自动提取所有 `width: var(--w-modal-X)` 的选择器，
 * 期望值从 index.css 的令牌定义读。新增弹层自动纳入，不需要维护列表。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** dev server 下的 CSS 是按模块懒加载的，这里先按需 import 一遍。 */
const CSS_MODULES = [
  "/src/svn.css",
  "/src/meta-generation.css",
  "/src/linked.css",
  "/src/db-grid-inspector.css",
  "/src/db-transfer.css",
  "/src/db-transfer-workbench.css",
  "/src/db-workbench.css",
  "/src/db-console.css",
  "/src/db-compare-workbench.css",
  "/src/service-console-log.css",
  "/src/workspace.css",
  "/src/components/db/sql-parameters.css",
  "/src/components/db/db-reading.css",
  "/src/components/settings/settings-about.css",
];

const argv = process.argv.slice(2);
const urlArg = argv.find((a) => a.startsWith("--url="));
const TARGET_URL = urlArg ? urlArg.slice("--url=".length) : "http://localhost:1420";

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".css")) out.push(f);
  }
  return out;
}

/** `--w-modal-md: min(620px, calc(100vw - 32px))` → { md: 620 } */
export function parseTokenPx(indexCss) {
  const out = {};
  for (const m of indexCss.matchAll(/--w-modal-([\w-]+)\s*:\s*min\(\s*(\d+(?:\.\d+)?)px/g)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * 从 CSS 里找出「哪些类用了宽度档位」。
 * `.dbx-dlg.sm` → classes "dbx-dlg sm"；逗号分组逐个展开。
 *
 * 同一个类可能被多条规则写宽度（`.gen-modal, .gen-config-modal` 给 lg，
 * 随后 `.gen-config-modal` 单独特化到 xs）—— 层叠上只有最后一条生效，
 * 所以按 classes 去重保留最后一条，否则审计会拿被覆盖的值去比，报假失败。
 */
export function collectUsages(cssFiles) {
  const byClasses = new Map();
  for (const file of cssFiles) {
    const text = file.text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\s+/g, " ");
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].trim();
      const width = rule[2].match(/(?:^|;)\s*width\s*:\s*var\(--w-modal-([\w-]+)\)/);
      if (!width) continue;
      for (const part of selector.split(",")) {
        const classes = [...part.matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
        if (!classes.length) continue;
        if (!classes.some((c) => /dialog|modal/i.test(c))) continue;
        const key = classes.join(" ");
        const prev = byClasses.get(key);
        byClasses.set(key, {
          classes: key,
          token: width[1],
          file: file.path,
          overridden: prev ? [...(prev.overridden ?? []), `${prev.file}:${prev.token}`] : [],
        });
      }
    }
  }
  return [...byClasses.values()].sort((a, b) => a.classes.localeCompare(b.classes));
}

async function main() {
  const indexCss = readFileSync(join(SRC, "index.css"), "utf8");
  const tokenPx = parseTokenPx(indexCss);
  if (!Object.keys(tokenPx).length) {
    console.error("❌ index.css 里没找到 --w-modal-* 定义");
    process.exit(1);
  }

  const cssFiles = walk(SRC).map((f) => ({
    path: relative(ROOT, f).split(sep).join("/"),
    text: readFileSync(f, "utf8"),
  }));
  const usages = collectUsages(cssFiles);
  if (!usages.length) {
    console.error("❌ 没有任何 CSS 使用 --w-modal-*，检查器可能已失效");
    process.exit(1);
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {
    console.error(`❌ 打不开 ${TARGET_URL}。先起 dev server（端口被占时 npx vite --port 1422）`);
    process.exit(1);
  });
  await page.waitForTimeout(2000);

  const failedLoads = await page.evaluate(async (mods) => {
    const bad = [];
    for (const m of mods) {
      try {
        await import(/* @vite-ignore */ m);
      } catch (e) {
        bad.push(`${m}: ${String(e).slice(0, 60)}`);
      }
    }
    return bad;
  }, CSS_MODULES);
  for (const f of failedLoads) console.log(`⚠️ CSS 模块未加载 ${f}`);

  const measured = await page.evaluate((rows) => {
    return rows.map(({ classes }) => {
      const el = document.createElement("div");
      el.className = classes;
      el.style.position = "fixed";
      el.style.left = "-99999px";
      el.textContent = "x";
      document.body.appendChild(el);
      const w = Math.round(el.getBoundingClientRect().width);
      el.remove();
      return w;
    });
  }, usages);

  let bad = 0;
  usages.forEach((u, i) => {
    const expect = tokenPx[u.token];
    const actual = measured[i];
    const ok = expect === actual;
    if (!ok) bad += 1;
    const note = u.overridden.length ? `   （覆盖 ${u.overridden.join("、")}）` : "";
    console.log(
      `${ok ? "ok  " : "FAIL"} ${u.classes.padEnd(30)} --w-modal-${u.token.padEnd(4)} 期望 ${String(expect).padStart(4)}  实测 ${String(actual).padStart(4)}   ${u.file}${note}`,
    );
  });
  console.log(`\n${usages.length - bad}/${usages.length} 与档位一致`);

  // 窄视口：只判「真的溢出视口」。部分弹层在小视口下刻意贴边
  // （传输工作台 860px 以下 `calc(100vw - 24px)`，为内容让空间），少留边距是对的。
  await page.setViewportSize({ width: 720, height: 800 });
  await page.waitForTimeout(200);
  const narrow = await page.evaluate((rows) => {
    return rows.map(({ classes }) => {
      const el = document.createElement("div");
      el.className = classes;
      el.style.position = "fixed";
      el.style.left = "-99999px";
      document.body.appendChild(el);
      const w = Math.round(el.getBoundingClientRect().width);
      el.remove();
      return w;
    });
  }, usages);
  const overflow = usages
    .map((u, i) => ({ classes: u.classes, w: narrow[i] }))
    .filter((r) => r.w > 720);
  console.log(
    overflow.length
      ? `❌ 视口 720 时溢出视口：${overflow.map((o) => `${o.classes}=${o.w}`).join("、")}`
      : "✅ 视口 720 时全部不溢出",
  );

  await browser.close();
  process.exit(bad || overflow.length ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("modal-width-audit.mjs")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
