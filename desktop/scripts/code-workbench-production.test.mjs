// Production frontend and packaged CSP. File and service operations use browser-only fixtures.
/* global window, document, localStorage, innerWidth, innerHeight, getComputedStyle, Event */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serviceFixture } from "./service-console-fixture.mjs";
import { codeFixture } from "./code-workbench-fixture.mjs";

const dist = new URL("../dist/", import.meta.url), artifacts = new URL("../../docs/代码工作台布局深化验收-2026-11-06/", import.meta.url);
const html = await readFile(new URL("index.html", dist), "utf8"), entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
assert.ok(entry);
const base = (await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8")).match(/const bootstrap=`([\s\S]*?)`;/)[1];
const mocks = await readFile(new URL("../node_modules/@tauri-apps/api/mocks.js", import.meta.url));
const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const nonce = "code-workbench-acceptance", hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash("sha256").update(m[1]).digest("base64") + "'");
const csp = config.app.security.csp.replace(/script-src ([^;]+)/, (_, value) => `script-src ${value} ${hashes.join(" ")}`).replace(/style-src ([^;]+)/, (_, value) => `style-src ${value} 'nonce-${nonce}'`);
const bootstrap = base.replace("/node_modules/@tauri-apps/api/mocks.js", "/__mocks.js")
  .replace("const tx=", `${serviceFixture}\n${codeFixture}\nconst tx=`)
  .replace(" window.dbCalls.push({cmd,args});", " window.dbCalls.push({cmd,args});const codeResult=codeMock(cmd,args);if(codeResult!==undefined)return codeResult;const serviceResult=serviceMock(cmd,args);if(serviceResult!==undefined)return serviceResult;")
  .replace("workspace_root:null", "workspace_root:serviceRoot")
  .replace("throw Error('DB acceptance IPC not configured: '+cmd);", "return null;")
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", "")
  .replace("/src/main.tsx", entry);

test("code workbench production: layouts, focused groups, saved file, tree filter and narrow themes", { timeout: 240000 }, async () => {
  await mkdir(artifacts, { recursive: true });
  const server = createServer(async (request, response) => { try {
    const path = new URL(request.url, "http://local").pathname;
    if (path === "/") { response.setHeader("Content-Type", "text/html"); response.setHeader("Content-Security-Policy", csp); response.end(html.replace(/<style>/g, `<style nonce="${nonce}">`).replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/__fixture.js"></script>')); }
    else if (path === "/__fixture.js" || path === "/__mocks.js") { response.setHeader("Content-Type", "text/javascript"); response.end(path === "/__fixture.js" ? bootstrap : mocks); }
    else if (/^\/assets\/[\w.-]+$/.test(path) || path === "/icon.png") { response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream"); response.end(await readFile(new URL(path.slice(1), dist))); }
    else { response.writeHead(404); response.end(); }
  } catch { response.writeHead(404); response.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser; const errors = [], measurements = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
    for (const theme of ["light", "dark"]) for (const material of ["glass", "classic"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      await context.addInitScript(({ theme, material }) => { localStorage.setItem("theme", theme); localStorage.setItem("ncforge.ui-style", material); window.cspViolations = []; document.addEventListener("securitypolicyviolation", event => window.cspViolations.push(event.effectiveDirective)); }, { theme, material });
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message));
      const shot = name => page.screenshot({ path: fileURLToPath(new URL(`${theme}-${material}-${name}.png`, artifacts)), animations: "disabled" });
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
        const tree = page.getByRole("tree", { name: "文件树", exact: true });
        await tree.getByText("A.java", { exact: true }).dblclick(); await page.locator('.wb-editor-group-slot[data-group="left"] .monaco-editor').waitFor();
        await page.getByRole("button", { name: "过滤资源树入口", exact: true }).click(); await page.getByLabel("过滤资源树", { exact: true }).fill("B.java");
        assert.equal(await tree.getByText("A.java", { exact: true }).count(), 0); await tree.getByText("B.java", { exact: true }).waitFor();
        await page.getByLabel("过滤资源树", { exact: true }).press("Escape"); await tree.getByText("A.java", { exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: "过滤资源树入口", exact: true }).evaluate(element => document.activeElement === element), true);
        await tree.getByText("B.java", { exact: true }).dblclick();
        await page.getByRole("button", { name: "编辑器组操作", exact: true }).click(); await page.getByRole("menuitem", { name: "在右组打开当前文件", exact: true }).click();
        const left = page.locator('.wb-editor-group-slot[data-group="left"]'), right = page.locator('.wb-editor-group-slot[data-group="right"]');
        await right.getByRole("tab", { name: "B.java", exact: true }).waitFor();
        await left.getByRole("tab", { name: "A.java", exact: true }).click(); await right.getByRole("tab", { name: "B.java", exact: true }).click();
        await right.locator(".monaco-editor").click(); await page.keyboard.press("Control+End"); await page.keyboard.type("// RIGHT_GROUP_EDIT"); await page.keyboard.press("Control+s");
        await page.waitForFunction(() => window.codeWrites.some(write => write.text.includes("RIGHT_GROUP_EDIT")));
        const write = await page.evaluate(() => window.codeWrites.at(-1)); assert.ok(write.path.endsWith("B.java")); assert.ok(!write.path.endsWith("A.java"));
        await page.getByRole("button", { name: "工作台布局", exact: true }).click(); await page.getByRole("menuitem", { name: "排错布局", exact: true }).click();
        await page.getByRole("tab", { name: "问题", exact: true }).waitFor();
        await page.getByRole("button", { name: "更多底部工具", exact: true }).click(); await page.getByRole("menuitem", { name: "待办", exact: true }).click();
        await page.getByRole("tab", { name: "待办", exact: true }).waitFor();
        await page.getByRole("button", { name: "展开阅读", exact: true }).click(); await page.getByRole("button", { name: "恢复布局", exact: true }).click();
        assert.equal(await page.locator(".monaco-editor").count(), 2, "expanding a tool preserves both editors");
        await page.getByRole("button", { name: "工作台布局", exact: true }).click(); await page.getByRole("menuitem", { name: "编码布局", exact: true }).click();
        for (const [name, width, height] of [["wide",1440,900],["normal",1366,768],["low",1024,540],["scale150",683,512],["narrow",560,700]]) {
          await page.setViewportSize({ width, height });
          const measurement = await page.locator(".wb-code-surface").evaluate(element => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, editors: Array.from(element.querySelectorAll(".wb-editor-group-slot")).filter(group => getComputedStyle(group).display !== "none").map(group => ({ ...group.getBoundingClientRect().toJSON(), readingHeight: group.querySelector(".monaco-editor")?.getBoundingClientRect().height ?? 0 })) }));
          assert.equal(measurement.overflow, false, `${theme}/${material}/${name}`); assert.ok(measurement.editors.some(rect => rect.readingHeight >= (name === "normal" ? 380 : 300)), `${name}: actual code reading height`); measurements.push({ theme, material, name, ...measurement }); await shot(name);
        }
        await page.getByRole("button", { name: "关闭资源侧栏", exact: true }).click();
        await page.getByRole("button", { name: "编译", exact: true }).waitFor();
        assert.equal(await page.locator(".monaco-editor").count(), 2, "closing the narrow sidebar retains group state");
        await shot("narrow-code");
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.getByRole("button", { name: "工作台布局", exact: true }).click(); await page.getByRole("menuitem", { name: "编码布局", exact: true }).click();
        if (theme === "light" && material === "glass") {
          // Exercise real tab selection, model sharing and menu actions with 20 files.
          await left.getByRole("tab", { name: "A.java", exact: true }).click();
          for (let i = 1; i <= 18; i++) await tree.getByText(`File${String(i).padStart(2,"0")}.java`, { exact: true }).dblclick();
          await page.waitForFunction(() => document.querySelectorAll('.wb-editor-group-slot[data-group="left"] .wb-tab').length === 20);
          assert.equal(await left.getByRole("tab").count(), 20);
          await left.getByRole("button", { name: "所有标签", exact: true }).click();
          await page.getByLabel("搜索打开的文件").fill("File18");
          await page.getByRole("menuitem", { name: /File18.java/ }).click();
          const pinned = left.getByRole("tab", { name: "File18.java", exact: true });
          await pinned.click({ button: "right" }); await page.getByRole("menuitem", { name: "钉住文件", exact: true }).click();
          assert.equal(await pinned.getAttribute("data-pinned"), "true");
          await left.getByRole("tab", { name: "A.java", exact: true }).click();
          await left.getByRole("tab", { name: "A.java", exact: true }).click({ button: "right" });
          await page.getByRole("menuitem", { name: "关闭其他", exact: true }).click();
          assert.equal(await left.getByRole("tab").count(), 2, "bulk close protects pinned files");
          await pinned.waitFor();
          await page.getByRole("button", { name: "编辑器组操作", exact: true }).click(); await page.getByRole("menuitem", { name: "在右组打开当前文件", exact: true }).click();
          await right.getByRole("tab", { name: "A.java", exact: true }).click();
          await right.locator(".monaco-editor").click(); await page.keyboard.press("Control+End"); await page.keyboard.type("// SHARED_MODEL_EDIT");
          assert.ok((await left.locator(".monaco-editor").innerText()).includes("SHARED_MODEL_EDIT"));
          await right.getByRole("button", { name: "关闭 A.java", exact: true }).click();
          assert.equal(await page.getByRole("dialog").count(), 0, "closing a shared view preserves dirty model");
          await left.getByRole("button", { name: "关闭 A.java", exact: true }).click();
          const guard = page.getByRole("dialog"); await guard.waitFor();
          await guard.getByRole("button", { name: /取消/ }).click();
          await guard.waitFor({state:"hidden"});
          await left.getByRole("tab", { name: "A.java", exact: true }).click();
          await left.locator(".monaco-editor").click(); await page.keyboard.press("Control+s");
          await page.waitForFunction(() => window.codeWrites.some(write => write.path.endsWith("A.java") && write.text.includes("SHARED_MODEL_EDIT")));

          const resize = page.getByRole("separator", { name: "调整底部面板高度", exact: true });
          await page.getByRole("tab", { name: "编译输出", exact: true }).click(); await resize.press("ArrowUp");
          const buildHeight = await resize.getAttribute("aria-valuenow");
          await page.getByRole("tab", { name: "问题", exact: true }).click(); await resize.press("ArrowDown");
          await page.getByRole("tab", { name: "编译输出", exact: true }).click(); assert.equal(await resize.getAttribute("aria-valuenow"), buildHeight);
          await page.getByRole("button", { name: "更多底部工具", exact: true }).click(); await page.getByRole("button", { name: "固定书签", exact: true }).click(); await page.keyboard.press("Escape");
          await page.getByRole("tab", { name: "书签", exact: true }).waitFor();
          await page.getByRole("button", { name: "工作台布局", exact: true }).click(); await page.getByRole("menuitem", { name: "锁定当前布局", exact: true }).click();
          await page.getByRole("button", { name: "编译", exact: true }).click();
          await page.getByText("编译未通过 · 1 个错误", { exact: true }).waitFor();
          await page.getByRole("button", { name: "工作台布局", exact: true }).click();
          await page.getByRole("menuitem", { name: "编码布局", exact: true }).evaluate(element => { if (!element.classList.contains("text-primary")) throw Error("compile failure changed locked layout"); });
          await page.getByRole("menuitem", { name: "解除布局锁定", exact: true }).click();
          await page.getByRole("tab", { name: /^问题/, exact: false }).click();
          await page.getByRole("button", { name: "预览 B.java 第 4 行上下文", exact: true }).click();
          await page.getByRole("region", { name: "源码上下文预览" }).getByText('System.out.println("B");', { exact: true }).waitFor();
          await page.getByLabel("问题范围").selectOption("file");
          await page.getByRole("button", { name: "查看工程结果", exact: true }).click();
          await page.getByRole("tab", { name: "编译输出", exact: true }).click(); await page.getByRole("button", { name: /问题定位/ }).click();
          await page.getByRole("button", { name: /验收：方法调用错误/ }).click();
          assert.equal(await left.getByRole("tab", { name: "B.java", exact: true }).getAttribute("aria-selected"), "true");
          await page.waitForFunction(() => document.querySelector('.wb-status-host')?.textContent.includes('4:1'));
          assert.equal(await page.getByText(/无法打开 B.java/).count(), 0, "problem navigation reuses the existing model across path separators");
          await page.getByRole("button", { name: /原始输出/ }).click();
          await page.evaluate(async () => { for (let i=0;i<5500;i++) await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event:'compile-log',payload:`[验收] 编译日志 ${i}` }); });
          await page.waitForFunction(() => document.querySelector('[aria-label="编译原始输出"]')?.scrollHeight > 80000);
          const raw = page.getByLabel("编译原始输出"); assert.ok(await raw.locator(".dw-build-log-line").count() < 60, "build output keeps bounded DOM");
          await raw.evaluate(element => { element.scrollTop=2200; element.dispatchEvent(new Event("scroll", {bubbles:true})); });
          const rawTop = await raw.evaluate(element => element.scrollTop);
          await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {event:'compile-log',payload:'[验收] 新增日志'}));
          await page.waitForFunction(() => document.querySelector('[aria-label="编译原始输出"]')?.scrollTop < 2200);
          assert.ok(Math.abs((await raw.evaluate(element => element.scrollTop))-rawTop)<30, "capped stream preserves reading position");
          await shot("build-raw");

          await page.getByRole("button", { name: "全工程搜索", exact: true }).click(); await page.getByLabel("搜索工程文件内容").fill("System"); await page.getByLabel("搜索工程文件内容").press("Enter");
          await page.getByRole("button", { name: "预览 A.java 第 6 行上下文", exact: true }).click();
          await page.getByRole("region", { name: "源码上下文预览" }).getByText('System.out.println("A");', { exact: true }).waitFor();
          await page.getByRole("button", { name: "展开结果", exact: true }).click();
          await page.getByRole("region", { name: "展开的搜索结果" }).waitFor();
          await page.getByRole("button", { name: "下一结果", exact: true }).click();
          await page.getByRole("region", { name: "源码上下文预览" }).getByText('System.out.println("B");', { exact: true }).waitFor();
          await shot("search-expanded"); await page.getByRole("button", { name: "恢复侧栏", exact: true }).click();
          assert.equal(await page.getByRole("region", { name: "展开的搜索结果" }).count(), 0);
          await page.getByRole("button", { name: "关闭上下文预览", exact: true }).click();

          await page.getByRole("button", { name: "工作台布局", exact: true }).click(); await page.getByRole("menuitem", { name: "调试布局", exact: true }).click();
          await page.getByRole("button", { name: "附加调试器", exact: true }).click();
          await page.getByRole("button", { name: "断开", exact: true }).waitFor();
          await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event:'debug-event',payload:{target:'server',event:'stopped',body:{threadId:1,reason:'breakpoint'}} }));
          await page.locator('.dbg-thread').filter({ hasText: 'main' }).waitFor();
          const watch = page.locator(".dbg-watch-input"); await watch.fill("name.pending");
          await page.getByRole("complementary", { name:"调试检查器",exact:true }).waitFor(); await shot("debug-docked");
          await page.setViewportSize({width:683,height:512});
          await page.getByRole("complementary", { name:"调试检查器",exact:true }).waitFor({state:"hidden"}); assert.equal(await watch.inputValue(),"name.pending");
          await page.setViewportSize({width:1440,height:900});
          await page.getByRole("complementary", { name:"调试检查器",exact:true }).waitFor(); assert.equal(await watch.inputValue(),"name.pending");
          await shot("debug-restored");
          assert.equal(await page.getByText(/无法打开 [AB].java/).count(), 0);
        }
        assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
      } catch (error) { await shot("failure"); await writeFile(new URL("失败记录.json", artifacts), JSON.stringify({ errors, text: await page.locator("body").innerText(), debug:await page.evaluate(()=>({writes:window.codeWrites,calls:window.dbCalls.slice(-30),focus:document.activeElement?.outerHTML})) }, null, 2)); throw error; }
      finally { await context.close(); }
    }
    assert.deepEqual(errors, []); await writeFile(new URL("检查记录.json", artifacts), JSON.stringify({ at: new Date().toISOString(), errors, measurements }, null, 2));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
