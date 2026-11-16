#!/usr/bin/env node
/**
 * 视觉回归基线（P2-1）。
 *
 * 定位：**先只报不拦**。截图 diff 在没有人工判读的情况下必然误报（字体渲染、
 * 滚动条宽度、GPU 合成都会变），拿它当门禁会逼人天天 --update，最后没人看。
 * 所以这里只回答"哪几张变了"，变没变坏由人看。
 *
 * 前提：
 *   1) dev server 已起：npm run vite:dev（端口 1420）
 *   2) 装过一次 chromium：npx playwright install chromium
 *
 * 用法：
 *   node scripts/visual-baseline.mjs --update      # 生成/刷新基线（首次必须跑）
 *   node scripts/visual-baseline.mjs               # 与基线对比，列出变化
 *   node scripts/visual-baseline.mjs --url=http://localhost:1420
 *
 * 场景覆盖 DESIGN.md 的两个正交维度：外观档（classic/glass）× 密度档（三档）× 明暗。
 * 通过直接改 <html data-ui-*> 与 .dark 类来切换，不依赖 localStorage 键名——
 * 键名会随 APP_SLUG 改名，视觉基线不该跟着碎。
 */
/* global document */
// document 只在 page.evaluate 的回调里用——那段代码在浏览器里跑，不在 Node 里。
// 同 check-motion.mjs 的口径：浏览器侧全局逐文件声明，别往 eslint.config 的 scripts 块塞。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BASE_DIR = join(ROOT, "visual-baseline");
const CURRENT_DIR = join(ROOT, "src-tauri", "target", "visual-current");

const SCENES = [
  { name: "classic-standard-light", style: "classic", density: "standard", dark: false },
  { name: "classic-compact-light", style: "classic", density: "compact", dark: false },
  { name: "classic-comfortable-light", style: "classic", density: "comfortable", dark: false },
  { name: "classic-standard-dark", style: "classic", density: "standard", dark: true },
  { name: "glass-standard-light", style: "glass", density: "standard", dark: false },
  { name: "glass-standard-dark", style: "glass", density: "standard", dark: true },
];

const argv = process.argv.slice(2);
const update = argv.includes("--update");
const urlArg = argv.find((a) => a.startsWith("--url="));
const TARGET_URL = urlArg ? urlArg.slice("--url=".length) : "http://localhost:1420";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

/** @returns {{changed:string[], added:string[], missing:string[]}} */
export function diffHashes(baseline, current) {
  const changed = [];
  const added = [];
  const missing = [];
  for (const [name, hash] of Object.entries(current)) {
    if (!(name in baseline)) added.push(name);
    else if (baseline[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(baseline)) if (!(name in current)) missing.push(name);
  return { changed: changed.sort(), added: added.sort(), missing: missing.sort() };
}

function hashesOf(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".png")) out[name.slice(0, -4)] = sha256(join(dir, name));
  }
  return out;
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("❌ 缺少 playwright。先 npm i -D playwright");
    process.exit(1);
  }

  const target = update ? BASE_DIR : CURRENT_DIR;
  mkdirSync(target, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    console.error("❌ 启动 chromium 失败。先装浏览器：npx playwright install chromium");
    console.error(`   ${String(error).split("\n")[0]}`);
    process.exit(1);
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (error) {
    await browser.close();
    console.error(`❌ 打不开 ${TARGET_URL}。先起 dev server：npm run vite:dev`);
    console.error(`   ${String(error).split("\n")[0]}`);
    process.exit(1);
  }
  // 首屏有骨架屏与字体加载，等稳定再截。
  await page.waitForTimeout(1500);

  for (const scene of SCENES) {
    await page.evaluate((s) => {
      const root = document.documentElement;
      root.dataset.uiStyle = s.style;
      root.dataset.uiDensity = s.density;
      root.classList.toggle("dark", s.dark);
    }, scene);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(target, `${scene.name}.png`), fullPage: false });
    console.log(`${update ? "写入" : "截取"} ${scene.name}.png`);
  }
  await browser.close();

  if (update) {
    console.log(`\n✅ 基线已写入 ${BASE_DIR}（${SCENES.length} 张，记得一起提交）`);
    return;
  }

  const { changed, added, missing } = diffHashes(hashesOf(BASE_DIR), hashesOf(CURRENT_DIR));
  if (!changed.length && !added.length && !missing.length) {
    console.log("\n✅ 与基线一致。");
    return;
  }
  console.log("\n⚠️ 与基线不一致（**不阻断**，请人工看是否变坏）：");
  for (const n of changed) console.log(`  - 变化：${n}`);
  for (const n of added) console.log(`  - 新增：${n}`);
  for (const n of missing) console.log(`  - 消失：${n}`);
  console.log(`\n基线：${BASE_DIR}\n当前：${CURRENT_DIR}\n确认是改进后跑 --update 刷新基线。`);
}

// 只有在直接执行时才跑采集；被单测 import 时不动浏览器。
if (process.argv[1] && process.argv[1].endsWith("visual-baseline.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
