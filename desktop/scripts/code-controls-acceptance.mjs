// Production UI with browser-only IPC fixtures. No real engineering file or NC process is touched.
/* global window, document, localStorage, innerWidth, innerHeight, getComputedStyle */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serviceFixture } from "./service-console-fixture.mjs";
import { codeFixture } from "./code-workbench-fixture.mjs";

const dist = new URL("../dist/", import.meta.url);
const artifacts = new URL("../../docs/代码区控件合并验收-2026-11-14/", import.meta.url);
await mkdir(artifacts, { recursive: true });
const html = await readFile(new URL("index.html", dist), "utf8");
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)[1];
const base = (await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8")).match(/const bootstrap=`([\s\S]*?)`;/)[1];
const controlsFixture = String.raw`
window.historyRestores=[];window.controlsCompiles=[];window.holdRestore=false;
const versions=[{id:'v1',ts:Date.now()-60000,size:190,sha:'aaa'},{id:'v2',ts:Date.now()-3600000,size:180,sha:'bbb'}];
const controlsMock=(cmd,args)=>{
 if(cmd.startsWith('req_'))return {reqs:[],current:null,files:[],journal:{dir:null,found:false,lastAtMs:0,more:false}};
 if(cmd==='fs_list_dir'&&args.path===serviceRoot)return [{name:'demo',isDir:true,size:0}];
 if(cmd==='local_history_list')return versions;
 if(cmd==='local_history_read')return {text:'package demo;\npublic class A {\n public String oldName() { return "OLD_VERSION"; }\n}\n',truncated:false,size:190,ts:versions[0].ts};
 if(cmd==='local_history_restore'){
  window.historyRestores.push(args);
  return new Promise(resolve=>{const finish=()=>{window.codeFiles[args.path.split(/[\\/]/).at(-1)]='public class A { public void restored() {} }\n';window.codeMtime++;resolve(null);};window.finishRestore=finish;if(!window.holdRestore)finish();});
 }
 if(cmd==='compile_module')window.controlsCompiles.push(args);
 return undefined;
};`;
const bootstrap = base.replace("/node_modules/@tauri-apps/api/mocks.js", "/__mocks.js")
  .replace("const tx=", `${serviceFixture}\n${codeFixture}\n${controlsFixture}\nconst tx=`)
  .replace(" window.dbCalls.push({cmd,args});", " window.dbCalls.push({cmd,args});const controls=controlsMock(cmd,args);if(controls!==undefined)return controls;const code=codeMock(cmd,args);if(code!==undefined)return code;const service=serviceMock(cmd,args);if(service!==undefined)return service;")
  .replace("workspace_root:null", "workspace_root:serviceRoot")
  .replace("throw Error('DB acceptance IPC not configured: '+cmd);", "return null;")
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", "")
  .replace("/src/main.tsx", entry);
const mocks = await readFile(new URL("../node_modules/@tauri-apps/api/mocks.js", import.meta.url));
const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash("sha256").update(m[1]).digest("base64") + "'");
const csp = config.app.security.csp.replace(/script-src ([^;]+)/, (_, value) => `script-src ${value} ${hashes.join(" ")}`);
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://local").pathname;
    if (path === "/") { response.setHeader("Content-Type", "text/html"); response.setHeader("Content-Security-Policy", csp); response.end(html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/__fixture.js"></script>')); }
    else if (path === "/__fixture.js" || path === "/__mocks.js") { response.setHeader("Content-Type", "text/javascript"); response.end(path === "/__fixture.js" ? bootstrap : mocks); }
    else if (/^\/(assets|fonts)\/[\w/.-]+$/.test(path) || path === "/icon.png") { response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream"); response.end(await readFile(new URL(path.slice(1), dist))); }
    else { response.writeHead(404); response.end(); }
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const measurements = [], errors = [];
let currentPage;
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    currentPage = page;
    page.on("pageerror", error => errors.push(String(error)));
    await page.addInitScript(({ theme }) => { localStorage.setItem("theme", theme); localStorage.setItem("ncforge.ui-style", "glass"); localStorage.setItem("ncforge.tree.packageView", "0"); }, { theme });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const tree = page.getByRole("tree", { name: "文件树", exact: true });
    await tree.getByText("demo", { exact: true }).click();
    await tree.getByText("A.java", { exact: true }).dblclick();
    const left = page.locator('.wb-editor-group-slot[data-group="left"]');
    await left.locator(".monaco-editor").waitFor();
    assert.equal(await page.locator(".wb-ctx").count(), 0);
    assert.equal(await page.getByRole("button", { name: "工作台布局", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "全工程搜索", exact: true }).count(), 0);
    assert.equal(await page.locator('.wb-crumb-row [data-popover="history"], .wb-crumb-row [data-popover="outline"], .wb-crumb-row .wb-minimap-toggle').count(), 0);
    await page.getByRole("button", { name: "编译 demo 模块", exact: true }).waitFor();
    const shot = async name => page.screenshot({ path: fileURLToPath(new URL(`${theme}-${name}.png`, artifacts)) });
    await shot("代码总览");
    await page.locator(".wb-global-search").click();
    await page.getByLabel("快速导航输入").fill("@");
    const dialog = page.getByRole("dialog", { name: "快速导航", exact: true });
    await dialog.getByRole("option", { name: /getName/ }).waitFor();
    await dialog.getByRole("button", { name: "只看方法", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#qp-listbox [role="option"]').length === 2);
    assert.equal(await dialog.getByRole("option").count(), 2);
    await shot("顶部符号");
    await dialog.getByLabel("快速导航输入").press("Escape");
    await left.locator(".monaco-editor").click(); await page.keyboard.press("Control+End"); await page.keyboard.type("\n// UNSAVED_SYMBOL\n");
    await page.locator(".wb-global-search").click(); await page.getByLabel("快速导航输入").fill("@");
    await dialog.getByRole("option", { name: /getName/ }).waitFor();
    await dialog.getByRole("button", { name: "固定到侧栏", exact: true }).click();
    await page.getByRole("region", { name: "文件结构", exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑器布局", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "固定文件结构", exact: true }).click();
    await page.getByRole("tab", { name: "改动", exact: true }).click();
    await page.getByRole("button", { name: "本地版本", exact: true }).click();
    await page.getByRole("region", { name: "本地历史", exact: true }).waitFor();
    await page.getByText("与当前编辑内容的差异", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "恢复此版本", exact: true }).count(), 0);
    await left.locator(".monaco-editor").click(); await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.codeWrites.length > 0);
    await page.getByRole("button", { name: "恢复此版本", exact: true }).waitFor();
    await shot("本地版本");
    await page.evaluate(() => { window.holdRestore = true; });
    await page.getByRole("button", { name: "恢复此版本", exact: true }).click();
    await page.getByRole("button", { name: /确认恢复/ }).click();
    await page.getByText("恢复中…", { exact: true }).waitFor();
    assert.equal(await page.getByRole("tab", { name: "编译输出", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "关闭面板", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "隐藏面板", exact: true }).isDisabled(), true);
    await tree.getByText("B.java", { exact: true }).dblclick();
    await page.getByText(/正在恢复：demo.*A.java/).waitFor();
    await page.evaluate(() => window.finishRestore());
    await page.waitForFunction(() => !document.querySelector('[aria-label="关闭面板"]').disabled);
    assert.ok((await page.evaluate(() => window.historyRestores[0])).expectedMtimeMs > 0);
    await left.getByRole("tab", { name: "A.java", exact: true }).click();
    await page.getByRole("button", { name: "编辑器布局", exact: true }).click();
    await shot("布局菜单");
    await page.getByRole("menuitem", { name: "在右组打开当前文件", exact: true }).click();
    await page.getByRole("button", { name: "运行 NC 任务", exact: true }).click(); await shot("编译菜单"); await page.keyboard.press("Escape");
    for (const [width, height] of [[1280,840], [1024,640], [683,512]]) {
      await page.setViewportSize({ width, height });
      const info = await page.locator(".wb-code-surface").evaluate(element => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
        reading: [...element.querySelectorAll('.wb-editor-group-slot')].filter(group => getComputedStyle(group).display !== "none").map(group => group.querySelector('.monaco-editor')?.getBoundingClientRect().height ?? 0),
        tabs: element.querySelector('.wb-editor-group-slot:not([hidden]) .wb-tabs')?.getBoundingClientRect().height, path: element.querySelector('.wb-editor-group-slot:not([hidden]) .wb-crumb-row')?.getBoundingClientRect().height }));
      assert.equal(info.overflow, false); assert.ok(info.reading.some(height => height >= 220)); measurements.push({ theme, ...info }); await shot(`${width}x${height}`);
    }
    await page.setViewportSize({ width:1280, height:840 });
    await page.getByRole("button", { name: "编译 demo 模块", exact: true }).click();
    await page.waitForFunction(() => window.controlsCompiles.length > 0);
    assert.match((await page.evaluate(() => window.controlsCompiles.at(-1))).path.replace(/\\/g, "/"), /\/demo\/A\.java$/);
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(new URL("界面检查.json", artifacts), JSON.stringify({ measurements, errors }, null, 2));
  console.log("PASS: consolidated controls, local symbols, dirty comparison, restore locks, compile target, split and narrow themes");
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: fileURLToPath(new URL("失败现场.png", artifacts)) });
    await writeFile(new URL("失败现场.json", artifacts), JSON.stringify(await currentPage.evaluate(() => ({ text: document.body.innerText, writes: window.codeWrites, restores: window.historyRestores, historyCalls: window.dbCalls.filter(call => /local_history|fs_read_file/.test(call.cmd)) })), null, 2));
  }
  throw error;
} finally { await browser.close(); server.close(); }
