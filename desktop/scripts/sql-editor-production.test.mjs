// Real production assets plus Tauri's build-time CSP nonce behavior; database IPC stays mocked.
/* global window, document, getComputedStyle */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dist = new URL("../dist/", import.meta.url);
const artifacts = new URL("../../docs/sql-editor-fix-20261105/", import.meta.url);
const html = await readFile(new URL("index.html", dist), "utf8");
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
assert.ok(entry, "Run npm run vite:build before production acceptance");
const fixture = await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
const raw = fixture.match(/const bootstrap=`([\s\S]*?)`;/)?.[1];
assert.ok(raw);
const bootstrap = `window.cspViolations=[]; document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));\n` + raw
  .replace("/node_modules/@tauri-apps/api/mocks.js", "/__tauri_mocks.js")
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'',results:[],output:[]}")
  .replace("if(cmd==='db_exec_bound')", "if(cmd==='db_exec' || cmd==='db_exec_bound')")
  .replace("ms:10,tx:tx()", "ms:10,output:[],tx:tx()")
  .replace("if(cmd==='db_tx')", "if(cmd==='db_slot_acquire') return {slot:'sql-1',tx:tx()}; if(cmd==='db_tx')")
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", "localStorage.setItem('ncforge.ui-style','glass');localStorage.setItem('ncforge-db-result-height','300');")
  .replace("/src/main.tsx", entry);
assert.ok(!bootstrap.includes("/src/"), "Production acceptance must never fall back to dev modules");
const mocks = await readFile(new URL("../node_modules/@tauri-apps/api/mocks.js", import.meta.url));
const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
// Tauri adds a nonce to HTML <style> tags and appends it to style-src. Browsers then ignore unsafe-inline.
const nonce = "sql-acceptance-nonce";
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash("sha256").update(m[1]).digest("base64") + "'");
const csp = config.app.security.csp
  .replace(/script-src ([^;]+)/, (_, sources) => `script-src ${sources} ${scripts.join(" ")}`)
  .replace(/style-src ([^;]+)/, (_, sources) => `style-src ${sources} 'nonce-${nonce}'`);
const body = html.replace(/<style>/g, `<style nonce="${nonce}">`)
  .replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/__sql_fixture.js"></script>');

test("production SQL editor renders and executes under the packaged CSP", async () => {
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(!csp.includes("unsafe-eval") && !/script-src[^;]*'unsafe-inline'/.test(csp));
  await mkdir(artifacts, { recursive: true });
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (path === "/") { response.setHeader("Content-Type", "text/html"); response.setHeader("Content-Security-Policy", csp); response.end(body); }
      else if (path === "/__sql_fixture.js" || path === "/__tauri_mocks.js") {
        response.setHeader("Content-Type", "text/javascript"); response.end(path === "/__sql_fixture.js" ? bootstrap : mocks);
      } else if (/^\/assets\/[\w.-]+$/.test(path)) {
        response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        response.end(await readFile(new URL(path.slice(1), dist)));
      } else if (path === "/icon.png") {
        response.setHeader("Content-Type", "image/png"); response.end(await readFile(new URL("icon.png", dist)));
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  const errors = [];
  let page;
  try {
    browser = await chromium.launch({ headless: true, channel: "msedge" });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click();
    const input = page.locator(".dbx-editor textarea");
    await input.focus();
    const style = await input.evaluate(el => { const s = getComputedStyle(el); return { border: s.borderWidth, outline: s.outlineStyle, color: s.color }; });
    await page.screenshot({ path: fileURLToPath(new URL("production-empty.png", artifacts)) });
    assert.equal(style.border, "0px");
    assert.equal(style.outline, "none");
    assert.equal(style.color, "rgba(0, 0, 0, 0)");
    const contentLeft = await page.locator(".dbx-editor .view-lines").evaluate(el => el.getBoundingClientRect().left - el.closest(".dbx-editor").getBoundingClientRect().left);
    assert.ok(contentLeft >= 30, "Line numbers and code must retain their gutter under packaged CSP");
    await page.keyboard.type("select 1 from dual;");
    await page.keyboard.press("Control+Enter");
    await page.getByRole("gridcell", { name: "甲", exact: true }).waitFor();
    await page.locator(".app-side").getByRole("button", { name: /^代码$/ }).click();
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click();
    assert.ok((await page.locator(".dbx-editor .view-lines").textContent()).includes("select"));
    await page.setViewportSize({ width: 1024, height: 540 });
    await page.waitForFunction(() => {
      const main = document.querySelector(".dbx-console-main").getBoundingClientRect();
      const editor = document.querySelector(".dbx-editor").getBoundingClientRect();
      const result = document.querySelector(".dbx-res").getBoundingClientRect();
      return editor.height >= 140 && result.bottom <= main.bottom + 1;
    });
    await page.screenshot({ path: fileURLToPath(new URL("production-query-low.png", artifacts)) });
    await page.evaluate(() => {
      const start = document.startViewTransition?.bind(document);
      window.themeFinished = Promise.resolve();
      if (start) document.startViewTransition = (...args) => {
        const transition = start(...args);
        window.themeFinished = transition.finished.catch(() => {});
        return transition;
      };
    });
    await page.getByRole("button", { name: "切换深色", exact: true }).click();
    await page.evaluate(() => window.themeFinished);
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.screenshot({ path: fileURLToPath(new URL("production-dark-low.png", artifacts)) });
    const violations = await page.evaluate(() => window.cspViolations);
    assert.deepEqual(violations, [], "Production CSP must permit editor styles without weakening script policy");
    assert.deepEqual(errors, []);
    await writeFile(new URL("production.json", artifacts), JSON.stringify({ csp, style, contentLeft, violations, errors, passed: ["Production CSS", "Packaged CSP nonces", "Input and execution", "Navigation draft", "Low window layout", "Dark theme"] }, null, 2));
  } catch (error) {
    await writeFile(new URL("production-failure.json", artifacts), JSON.stringify({ errors, violations: page ? await page.evaluate(() => window.cspViolations) : [], error: String(error) }, null, 2));
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
