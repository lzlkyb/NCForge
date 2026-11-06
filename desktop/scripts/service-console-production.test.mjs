// Real production assets under the packaged CSP; service and file IPC are fixtures.
/* global window, document, navigator, localStorage, innerWidth, innerHeight, getComputedStyle, Event */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serviceFixture } from "./service-console-fixture.mjs";
const dist = new URL("../dist/", import.meta.url), artifacts = new URL("../../docs/NC服务与控制台实施验收-2026-11-06/", import.meta.url);
const html = await readFile(new URL("index.html", dist), "utf8"), entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
assert.ok(entry);
const base = (await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8")).match(/const bootstrap=`([\s\S]*?)`;/)[1];
const mocks = await readFile(new URL("../node_modules/@tauri-apps/api/mocks.js", import.meta.url));
const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const nonce = "service-console-acceptance", hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash("sha256").update(m[1]).digest("base64") + "'");
const csp = config.app.security.csp.replace(/script-src ([^;]+)/, (_, v) => `script-src ${v} ${hashes.join(" ")}`).replace(/style-src ([^;]+)/, (_, v) => `style-src ${v} 'nonce-${nonce}'`);
const bootstrap = base.replace("/node_modules/@tauri-apps/api/mocks.js", "/__mocks.js")
  .replace("const tx=", `${serviceFixture}\nconst tx=`)
  .replace(" window.dbCalls.push({cmd,args});", " window.dbCalls.push({cmd,args});const serviceResult=serviceMock(cmd,args);if(serviceResult!==undefined)return serviceResult;")
  .replace("workspace_root:null", "workspace_root:serviceRoot")
  .replace("throw Error('DB acceptance IPC not configured: '+cmd);", "return null;")
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", "")
  .replace("/src/main.tsx", entry);
assert.ok(!bootstrap.includes("import('/src/"));
test("service console production: four themes, dock/expand, 4000 lines, scopes, cancellation and flow", { timeout: 240000 }, async () => {
  await mkdir(artifacts, { recursive: true });
  const server = createServer(async (req, res) => { try {
    const p = new URL(req.url, "http://local").pathname;
    if (p === "/") { res.setHeader("Content-Type", "text/html"); res.setHeader("Content-Security-Policy", csp); res.end(html.replace(/<style>/g, `<style nonce="${nonce}">`).replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/__fixture.js"></script>')); }
    else if (p === "/__fixture.js" || p === "/__mocks.js") { res.setHeader("Content-Type", "text/javascript"); res.end(p === "/__fixture.js" ? bootstrap : mocks); }
    else if (/^\/assets\/[\w.-]+$/.test(p) || p === "/icon.png") { res.setHeader("Content-Type", p.endsWith(".css") ? "text/css" : p.endsWith(".js") ? "text/javascript" : "application/octet-stream"); res.end(await readFile(new URL(p.slice(1), dist))); }
    else { res.writeHead(404); res.end(); }
  } catch { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  let browser; const errors = [], measurements = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
    for (const theme of ["light", "dark"]) for (const material of ["glass", "classic"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
      await context.addInitScript(({ theme, material }) => { localStorage.setItem("theme", theme); localStorage.setItem("ncforge.ui-style", material); window.cspViolations = []; document.addEventListener("securitypolicyviolation", e => window.cspViolations.push(e.effectiveDirective)); }, { theme, material });
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", e => errors.push(e.message));
      const shot = name => page.screenshot({ path: fileURLToPath(new URL(`${theme}-${material}-${name}.png`, artifacts)), animations: "disabled" });
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("tab", { name: "NC 服务", exact: true }).click();
        const panel = page.locator(".sc-console"), log = panel.locator(".sc-log-pane:not([hidden])"), body = log.locator(".sc-log-body");
        await panel.getByText("已加载 4000 行", { exact: true }).waitFor();
        for (const [name, width, height] of [["wide",1440,900],["low",1024,540],["scale150",683,512],["narrow",560,700]]) {
          await page.setViewportSize({ width, height });
          const m = await panel.evaluate(el => ({ width: innerWidth, height: innerHeight, body: el.querySelector('.sc-log-pane:not([hidden]) .sc-log-body').getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth, panel: el.getBoundingClientRect().toJSON(), background: getComputedStyle(el.querySelector('.sc-log-pane:not([hidden]) .sc-log')).backgroundColor }));
          measurements.push({ theme, material, name, ...m }); assert.equal(m.overflow, false, name); assert.ok(m.body >= 220, `${name}: body ${m.body}`); assert.ok(m.background.startsWith('rgb('), 'stable opaque console surface'); await shot(name);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        const before = await page.locator(".wb-bottom").boundingBox();
        await page.getByRole("button", { name: "展开阅读", exact: true }).click();
        assert.ok((await body.boundingBox()).height > before.height); await shot("expanded");
        await page.getByRole("button", { name: "恢复布局", exact: true }).click(); assert.equal(Math.round((await page.locator(".wb-bottom").boundingBox()).height), Math.round(before.height));
        await panel.getByRole("button", { name: "跟随最新", exact: true }).click();
        await body.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
        await body.getByText("===== 普通启动输出 =====", { exact: true }).waitFor();
        assert.ok(await body.locator(".sc-log-row").count() < 70, "bounded DOM");
        const indent = await body.getByText("===== 普通启动输出 =====", { exact: true }).evaluate(el => el.getBoundingClientRect().left - el.closest(".sc-log-body").getBoundingClientRect().left); assert.ok(indent < 20);
        await body.getByRole("button", { name: /启动命令/ }).click(); await body.getByRole("button", { name: "复制完整命令", exact: true }).click(); assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes("-D参数149"));
        await body.focus(); await page.keyboard.press("Control+f"); await log.getByLabel("查找日志内容").fill("端口冲突");
        await body.locator("mark").filter({ hasText: "端口冲突" }).first().waitFor(); assert.equal(await panel.getByText("已加载 4000 行", { exact: true }).count(), 1);
        await body.getByRole("button", { name: "Start.java:42", exact: true }).waitFor(); await panel.getByRole("button", { name: "关闭查找", exact: true }).click();
        await panel.getByRole("button", { name: "换行", exact: true }).click();
        await page.locator("#sc-service-client").click(); await panel.getByText("已加载 2 行", { exact: true }).waitFor(); assert.equal(await panel.getByRole("button", { name: "换行", exact: true }).getAttribute("aria-pressed"), "true");
        await page.locator("#sc-service-middleware").click(); assert.equal(await panel.getByRole("button", { name: "换行", exact: true }).getAttribute("aria-pressed"), "false");
        await log.getByLabel("选择运行日志").selectOption("previous"); await body.getByText("上次运行中文日志", { exact: true }).waitFor();
        await log.getByTitle('打开上次运行日志位置').click(); assert.equal(await page.evaluate(() => window.serviceCalls.filter(c => c.cmd === 'server_reveal_log').at(-1).args.previous), true);
        const archivedLog = await page.evaluate(() => { const text = window.serviceLogs.middleware[1]; window.serviceLogs.middleware[1] = ''; return text; });
        await panel.getByRole("button", { name: "更多日志操作", exact: true }).click(); await page.getByRole("menuitem", { name: "重新读取当前日志", exact: true }).click();
        await body.getByText("没有上次运行日志", { exact: true }).waitFor(); assert.equal(await log.getByTitle('打开上次运行日志位置').textContent(), '文件 0 B', 'empty archive must not inherit current file size');
        await page.evaluate(text => { window.serviceLogs.middleware[1] = text; }, archivedLog); await body.getByRole("button", { name: "重新读取日志", exact: true }).click(); await body.getByText("上次运行中文日志", { exact: true }).waitFor();
        await log.getByLabel("选择运行日志").selectOption("current");
        await panel.getByRole("button", { name: "更多日志操作", exact: true }).click(); await page.getByRole("menuitem", { name: /^导出完整日志文件…/ }).click();
        await panel.getByRole("status").filter({ hasText: "导出日志中" }).waitFor(); await panel.getByRole("button", { name: "取消", exact: true }).click(); await page.waitForFunction(() => window.serviceCalls.some(c => c.cmd === 'service_log_cancel_export'));
        await panel.getByRole("status").filter({ hasText: "导出日志中" }).waitFor({ state: "hidden" });
        await panel.getByRole("button", { name: "更多日志操作", exact: true }).click(); await page.getByRole("menuitem", { name: "清屏 · 磁盘文件保留", exact: true }).click(); await body.getByText("尚无控制台输出", { exact: true }).waitFor(); assert.ok(await page.evaluate(() => window.serviceLogs.middleware[0].includes('普通启动输出')));
        await page.evaluate(() => { window.holdStart = true; }); await panel.getByRole("button", { name: "启动", exact: true }).click(); await panel.getByText("准备 classpath", { exact: true }).first().waitFor(); await panel.getByRole("button", { name: "取消启动", exact: true }).click(); await page.waitForFunction(() => window.serviceStatus.middleware.state === 'stopped');
        await page.evaluate(() => { window.holdStart = false; window.deployError = true; }); await page.getByRole("button", { name: "开始开发", exact: true }).click(); await panel.getByText(/投送失败.*后续步骤未执行/).waitFor(); assert.equal(await page.evaluate(() => window.serviceCalls.filter(c => c.cmd === 'client_start').length), 0);
        await shot("flow-failure");
        if (theme === 'light' && material === 'glass') {
          await panel.getByRole('button', { name: '关闭开发流程结果' }).click();
          await page.evaluate(() => { window.deployError = false; });
          await page.getByRole('button', { name: '开始开发', exact: true }).click();
          await page.waitForFunction(() => window.serviceStatus.client.state === 'running');
          await page.getByRole('button', { name: '开始开发', exact: true }).waitFor();
          assert.equal(await page.evaluate(() => window.serviceCalls.filter(c => c.cmd === 'server_start').at(-1).args.skipDeploy), true);
          const serverRun = await page.evaluate(() => window.serviceStatus.middleware.runId);
          await page.locator('#sc-service-client').click(); await panel.getByRole('button', { name: '停止', exact: true }).click();
          await page.getByRole('dialog', { name: '停止 NC 客户端？' }).getByRole('button', { name: '停止', exact: true }).click();
          await page.waitForFunction(() => window.serviceStatus.client.state === 'stopped');
          assert.equal(await page.evaluate(() => window.serviceStatus.middleware.runId), serverRun);
          assert.equal(await page.evaluate(() => window.serviceStatus.middleware.state), 'running');
          await page.locator('.sc-side-tools').getByRole('button', { name: '运行详情', exact: true }).click();
          await page.locator('.sc-drawer').getByText('10.0.0.8:9080', { exact: true }).waitFor(); await page.locator('.sc-drawer').getByText('未验证', { exact: true }).waitFor();
          await page.keyboard.press('Escape'); assert.equal(await page.locator('.sc-side-tools').getByRole('button', { name: '运行详情', exact: true }).evaluate(el => document.activeElement === el), true);
          await page.locator('#sc-service-middleware').click();
          await page.evaluate(() => { window.serviceErrors = true; }); await panel.getByText('状态未知', { exact: true }).waitFor(); assert.equal(await panel.getByText('端口监听中', { exact: true }).count(), 0); await shot('status-error');
          await page.evaluate(() => { window.serviceErrors = false; }); await panel.locator('.sc-run-toolbar').getByRole('button', { name: '重试状态', exact: true }).click(); await panel.getByText('端口监听中', { exact: true }).waitFor();
          await page.evaluate(() => { window.logReadError = true; }); await panel.getByRole('alert').filter({ hasText: '读取日志失败' }).waitFor(); await panel.getByText('已加载 4000 行', { exact: true }).waitFor();
          await page.evaluate(() => { window.logReadError = false; }); await panel.locator('.sc-log-error').getByRole('button', { name: '重试', exact: true }).click(); await panel.locator('.sc-log-error').waitFor({ state: 'hidden' });
          await body.evaluate(el => { el.scrollTop = 2000; el.dispatchEvent(new Event('scroll', { bubbles: true })); }); const top = await body.evaluate(el => el.scrollTop);
          await page.evaluate(() => { window.serviceLogs.middleware[0] += '12:06:00 [main] INFO nc.demo.Logger - 新增运行日志\n'; });
          await panel.getByRole('button', { name: /新增.*回到最新/ }).waitFor(); assert.ok(Math.abs(await body.evaluate(el => el.scrollTop) - top) < 30, 'appending preserves reading position');
          const callsBefore = await page.evaluate(() => window.serviceCalls.filter(c => c.cmd === 'client_start').length);
          await page.evaluate(() => { window.serviceStatus.client.serverReachable = false; }); await page.getByRole('button', { name: '开始开发', exact: true }).click();
          await panel.getByText(/等待客户端连接目标 10.0.0.8:9080 可达/).waitFor(); await panel.getByRole('button', { name: '取消流程', exact: true }).click(); await panel.getByText(/已取消开发流程/).waitFor();
          assert.equal(await page.evaluate(() => window.serviceCalls.filter(c => c.cmd === 'client_start').length), callsBefore); assert.equal(await page.evaluate(() => window.serviceStatus.middleware.state), 'running'); await shot('flow-cancel');
        }
        assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
      } catch (error) { await writeFile(new URL("失败记录.json", artifacts), JSON.stringify(await page.evaluate(() => ({ text: document.body.innerText, calls: window.serviceCalls, errors: window.cspViolations })), null, 2)); await shot("failure"); throw error; }
      finally { await context.close(); }
    }
    assert.deepEqual(errors, []); await writeFile(new URL("检查记录.json", artifacts), JSON.stringify({ at: new Date().toISOString(), errors, measurements }, null, 2));
  } finally { await browser?.close(); await new Promise(r => server.close(r)); }
});
