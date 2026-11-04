// 验收正式前端的浏览器布局；IPC 隔离，避免测试改动真实工作区或数据库。
/* global document, innerWidth, requestAnimationFrame, getComputedStyle, localStorage */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.GLASS_PREVIEW_URL || "http://localhost:1420";
const artifacts = new URL("../../docs/glass-acceptance-20261104/", import.meta.url);
const bootstrap = `
import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
mockWindows('main');
window.acceptanceCommands = [];
mockIPC((cmd) => {
  window.acceptanceCommands.push(cmd);
  if (cmd === 'get_config') return {workspace_root:null,nc_home:null,autostart_enabled:false,lang_enabled:false,lang_auto_start:false,lang_xmx_mb:null,linked_overrides:[],auto_compile:false,deploy_on_start:false};
  if (cmd === 'get_app_info') return {version:'0.1.0',platform:'windows',running:false};
  if (cmd === 'get_autostart') return false;
  if (cmd === 'resources_status') return [];
  if (cmd === 'db_cached_tables') return {tables:[],fetchedAt:0};
  if (cmd === 'db_connections' || cmd === 'workspace_recent') return [];
  if (cmd === 'plugin:window|is_visible') return true;
  if (cmd === 'plugin:window|is_maximized') return false;
  if (cmd.startsWith('plugin:')) return null;
  throw new Error('验收 IPC 未配置：' + cmd);
}, {shouldMockEvents:true});
await import('/src/main.tsx');
`;

test("正式设置页在 560px、明暗玻璃、键盘切换与无障碍回退下可用", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  const measurements = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`${origin}/`, async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, `<script type="module">${bootstrap}</script>`);
    assert.ok(html.includes("mockWindows"), "必须在正式前端挂载前隔离 IPC");
    await route.fulfill({ response, body: html });
  });
  try {
    await page.goto(origin);
    await page.locator(".app-side").getByRole("button", { name: /^设置(?:，|$)/ }).click({ timeout: 30_000 });
    await page.getByRole("radiogroup", { name: "界面材质", exact: true }).waitFor();
    const material = page.getByRole("radiogroup", { name: "界面材质", exact: true });
    await material.getByRole("radio", { name: "柔光玻璃" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.uiStyle === "glass" && !document.documentElement.hasAttribute("data-material-transitions"));
    for (const [name, width, dark] of [["browser-light-narrow", 560, false], ["browser-dark-narrow", 560, true]]) {
      await page.setViewportSize({ width, height: 800 });
      // 小窗口分类抽屉有直接的关闭入口，不必先找到布局菜单。
      if (await page.locator(".wb-tree").isVisible()) {
        await page.getByRole("button", { name: "关闭设置分类", exact: true }).click();
        await page.locator(".wb-tree").waitFor({ state: "hidden" });
      }
      await page.getByRole("button", { name: "工作台布局", exact: true }).click();
      await page.getByRole("menuitem", { name: "设置分类", exact: true }).click();
      await page.locator(".wb-settings-nav").getByRole("button", { name: "编辑器", exact: true }).click();
      await page.locator(".wb-tree").waitFor({ state: "hidden" });
      await page.locator('[role="menu"]').waitFor({ state: "hidden" });
      assert.equal(await page.getByRole("heading", { name: "编辑器", exact: true }).evaluate(n => n === document.activeElement), true);
      await page.getByRole("button", { name: "工作台布局", exact: true }).click();
      await page.getByRole("menuitem", { name: "设置分类", exact: true }).click();
      await page.getByRole("button", { name: "关闭设置分类", exact: true }).focus();
      await page.keyboard.press("Escape");
      await page.locator(".wb-tree").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "工作台布局", exact: true }).click();
      await page.getByRole("menuitem", { name: "设置分类", exact: true }).click();
      await page.locator(".wb-side-backdrop").click({ position: { x: 450, y: 80 } });
      await page.locator(".wb-tree").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "工作台布局", exact: true }).click();
      await page.getByRole("menuitem", { name: "设置分类", exact: true }).click();
      await page.locator(".wb-settings-nav").getByRole("button", { name: "外观与常规", exact: true }).click();
      await page.locator(".wb-tree").waitFor({ state: "hidden" });
      await page.locator('[role="menu"]').waitFor({ state: "hidden" });
      await page.getByRole("radiogroup", { name: "明暗主题", exact: true }).getByRole("radio", { name: dark ? "深色" : "浅色" }).click();
      await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark && !document.documentElement.classList.contains("theme-transition"), dark);
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        body: [...document.querySelectorAll('.wb-settings-body')].map(n => ({ client: n.clientWidth, scroll: n.scrollWidth })),
        controls: [...document.querySelectorAll('[data-settings-section]:not([hidden]) [role="radiogroup"]')].map(n => {
          const r = n.getBoundingClientRect();
          return {label:n.getAttribute('aria-label'),left:r.left,right:r.right};
        }),
      }));
      measurements.push({ name, ...layout });
      assert.equal(layout.overflow, false, `${name} 外层不能横向溢出`);
      assert.ok(layout.body.every(n => n.scroll <= n.client + 1), `${name} 设置正文不能横向溢出`);
      assert.ok(layout.controls.every(n => n.left >= 0 && n.right <= width), `${name} 外观控件必须在视口内`);
      // 等快照动画完成再取证，不能把切换中间的叠色当成最终主题。
      await page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(document.getAnimations().filter(a => a.effect?.pseudoElement?.startsWith("::view-transition")).map(a => a.finished.catch(() => {})));
      });
      await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, artifacts)), fullPage: true });
    }
    await material.getByRole("radio", { name: "柔光玻璃" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.documentElement.dataset.uiStyle === "classic");
    assert.equal(await material.getByRole("radio", { name: "经典" }).evaluate(n => n === document.activeElement), true);
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.documentElement.dataset.uiStyle === "glass" && !document.documentElement.hasAttribute("data-material-transitions"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await material.getByRole("radio", { name: "经典" }).click();
    await material.getByRole("radio", { name: "柔光玻璃" }).click();
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-material-transitions")), false);
    await page.emulateMedia({ forcedColors: "active" });
    assert.equal(await page.locator(".app-shell").evaluate(n => getComputedStyle(n).backgroundImage), "none");
    await page.emulateMedia({ forcedColors: "none" });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.uiStyle === "glass");
    assert.equal(await page.evaluate(() => localStorage.getItem("ncforge.ui-style")), "glass");
    assert.equal(await page.locator("html").getAttribute("data-ui-style"), "glass");
    assert.deepEqual(errors, [], "正式前端不能有未处理的运行时错误");
    await writeFile(new URL("browser-results.json", artifacts), JSON.stringify({ measurements, errors, ipc: "Tauri mocks; no real workspace or database commands" }, null, 2));
  } catch (error) {
    await page.screenshot({ path: fileURLToPath(new URL("browser-failure.png", artifacts)) });
    const active = await page.evaluate(() => ({ active: {tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label')}, headings: [...document.querySelectorAll('.wb-settings-pages h1')].map(n => ({text:n.textContent, visible:!!n.getClientRects().length})), sidebar: document.querySelector('.wb-tree')?.getAttribute('data-closed') }));
    await writeFile(new URL("browser-failure.json", artifacts), JSON.stringify({ errors, message: String(error), ...active }, null, 2));
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
});
