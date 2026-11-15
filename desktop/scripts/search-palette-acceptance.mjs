// Real production frontend, browser-only IPC fixtures: no workspace file is written.
/* global window, document, localStorage, Event, innerWidth, innerHeight */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serviceFixture } from "./service-console-fixture.mjs";
import { codeFixture } from "./code-workbench-fixture.mjs";

const dist = new URL("../dist/", import.meta.url);
const artifacts = new URL("../../docs/工程搜索顶部浮层验收-2026-11-14/", import.meta.url);
await mkdir(artifacts, { recursive: true });
const html = await readFile(new URL("index.html", dist), "utf8");
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)[1];
const base = (await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8")).match(/const bootstrap=`([\s\S]*?)`;/)[1];
const searchFixture = String.raw`
window.searchRequests=[];window.searchCancels=[];window.searchRoot=serviceRoot;
const otherRoot='D:/关联工程';
const searchMock=(cmd,args)=>{
 if(cmd==='search_list_files')return {files:[...Object.keys(window.codeFiles),'purp/src/client/nc/ui/pp/m28/editor/card/afteredit/CardBodyAfterEditEventHandler.java','pu/src/client/nc/ui/pu/m25/editor/card/afteredit/CardBodyAfterEditEventHandler.java'],truncated:false};
 if(cmd==='search_types')return {workspace:[],jars:[],jarsPending:true,indexing:true,elapsedMs:1};
 if(cmd==='search_library_files')return {items:!args.names&&window.jarSearchContent?[{source:'D:/NC/modules/pp/hyext/lib/same.jar',entry:'config/a.xml',archive:true,class:false,line:12,text:'System 配置',ranges:[{start:0,end:6}]},{source:'D:/NC/modules/pp/hyext/lib/same.jar',entry:'messages.properties',archive:true,class:false,line:24,text:'System 单据',ranges:[{start:0,end:6}]}]:[],building:false,stale:false,cancelled:false,truncated:false,scanned:20,skipped:0,error:null};
 if(cmd==='library_search_cancel')return null;
 if(cmd==='read_library_file')return {text:'<config>\n'+Array.from({length:30},(_,i)=>'  <name>System '+(i+1)+'</name>').join('\n')+'\n</config>',decompiled:false};
 if(cmd==='get_workspace')return window.searchRoot;
 if(cmd==='set_workspace'){window.searchRoot=args.path;return args.path;}
 if(cmd==='tree_projects')return [window.searchRoot,otherRoot].map((root,i)=>({name:i?'关联工程':'验收工程',root,origin:i?'classpath':'primary',depth:i,exported:true,classDirs:[],disabled:false,hasClasspath:true}));
 if(cmd==='nc_manifest')return {components:[{name:'bill',dispname:'票据',roots:['src/public']}],notes:[]};
 if(cmd==='nc_manifest_audit')return {unregistered:[],missing:[]};
 if(cmd==='search_pack_status')return {ready:true,building:false,root:window.searchRoot,files:20,pending:0,packedRoots:2};
 if(cmd==='search_jar_symbols'||cmd==='search_src_notes')return {items:window.jarSearchContent?(cmd==='search_jar_symbols'?[{term:'System',score:2,places:[{jar:'D:/依赖.jar',class:'nc.demo.System'}]}]:[{jar:'D:/依赖_src.jar',path:'nc/demo/System.java',line:4,text:'System 源码注释'}]):[],total:window.jarSearchContent?1:0,truncated:false,building:false,stale:false,elapsedMs:1};
 if(cmd==='search_cancel'){window.searchCancels.push(args.source);return null;}
 if(cmd==='search_workspace_stream'||cmd==='search_projects'){
  const hits=args.options.text==='large'?Array.from({length:10000},(_,i)=>({path:'A.java',line:i+1,text:'large match '+(i+1),ranges:[{start:0,end:5}]})):codeSearch.hits;
  const outcome={...codeSearch,hits};
  const result=cmd==='search_projects'?{projects:[{project:'验收工程',root:window.searchRoot,outcome},{project:'关联工程',root:otherRoot,outcome:{...codeSearch,filesMatched:1,hits:[{...codeSearch.hits[0],line:4}]}}],errors:[],truncated:false,elapsedMs:300}:outcome;
  return new Promise(resolve=>{
   const request={cmd,args,result,finish:()=>resolve(result)};window.searchRequests.push(request);
   setTimeout(()=>window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:cmd==='search_projects'?'search:projects-batch':'search:batch',payload:{stream:args.stream,hits:hits.slice(0,50),project:'验收工程',root:window.searchRoot}}),30);
   if(!window.holdSearch)setTimeout(request.finish,350);
  });
 }
 return undefined;
};
`;
const bootstrap = base.replace("/node_modules/@tauri-apps/api/mocks.js", "/__mocks.js")
  .replace("const tx=", `${serviceFixture}\n${codeFixture}\n${searchFixture}\nconst tx=`)
  .replace(" window.dbCalls.push({cmd,args});", " window.dbCalls.push({cmd,args});const search=searchMock(cmd,args);if(search!==undefined)return search;const code=codeMock(cmd,args);if(code!==undefined)return code;const service=serviceMock(cmd,args);if(service!==undefined)return service;")
  .replace("workspace_root:null", "workspace_root:serviceRoot")
  .replace("throw Error('DB acceptance IPC not configured: '+cmd);", "return null;")
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", "")
  .replace("/src/main.tsx", entry);
const mocks = await readFile(new URL("../node_modules/@tauri-apps/api/mocks.js", import.meta.url));
const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash("sha256").update(m[1]).digest("base64") + "'");
const csp = config.app.security.csp.replace(/script-src ([^;]+)/, (_, value) => `${"script-src"} ${value} ${hashes.join(" ")}`);
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://local").pathname;
    if (path === "/") {
      response.setHeader("Content-Type", "text/html"); response.setHeader("Content-Security-Policy", csp);
      response.end(html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/__fixture.js"></script>'));
    } else if (path === "/__fixture.js" || path === "/__mocks.js") {
      response.setHeader("Content-Type", "text/javascript"); response.end(path === "/__fixture.js" ? bootstrap : mocks);
    } else if (/^\/(assets|fonts)\/[\w/.-]+$/.test(path) || path === "/icon.png") {
      response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream");
      response.end(await readFile(new URL(path.slice(1), dist)));
    } else { response.writeHead(404); response.end(); }
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const errors = [], measurements = [];
let browser, page;
try {
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(theme => { localStorage.setItem("theme", theme); localStorage.setItem("ncforge.ui-style", "classic"); }, theme);
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tree", { name: "文件树", exact: true }).getByText("A.java", { exact: true }).dblclick();
    const editor = page.locator('.wb-editor-group-slot[data-group="left"] .monaco-editor'); await editor.waitFor();
    await editor.click(); await page.locator(".wb-global-search").click();
    const dialog = page.getByRole("dialog", { name: "快速导航", exact: true });
    await page.getByLabel("快速导航输入", { exact: true }).waitFor();
    assert.equal(await dialog.locator('.qp-mode[aria-pressed="true"] .qp-mode-label').innerText(), "文件");
    const fullClass = 'nc.ui.pp.m28.editor.card.afteredit.CardBodyAfterEditEventHandler';
    const gotoInput = page.getByLabel("快速导航输入", { exact: true });
    await gotoInput.fill(fullClass);
    await dialog.locator('.qp-list[aria-busy="false"] .qp-li').waitFor();
    assert.equal(await dialog.locator('.qp-li').count(), 1);
    assert.ok((await dialog.locator('.qp-h').innerText()).includes('purp/src/client/nc/ui/pp/m28'));
    await page.screenshot({ path: fileURLToPath(new URL(`${theme}-完整类名-文件.png`, artifacts)) });
    await dialog.locator('.qp-mode').filter({ has: page.locator('.qp-mode-label', { hasText: /^类型$/ }) }).click();
    await gotoInput.fill(fullClass);
    await dialog.locator('.qp-list[aria-busy="false"] .qp-li').waitFor();
    assert.equal(await dialog.locator('.qp-li').count(), 1);
    assert.equal(await dialog.locator('.qp-title').innerText(), 'CardBodyAfterEditEventHandler');
    assert.ok((await dialog.locator('.qp-h').innerText()).includes('purp/src/client/nc/ui/pp/m28'));
    await page.screenshot({ path: fileURLToPath(new URL(`${theme}-完整类名-类型.png`, artifacts)) });
    await page.keyboard.press("Control+k");
    const input = page.getByLabel("搜索工程文件内容", { exact: true });
    await input.waitFor(); await page.keyboard.press("Escape");
    await editor.click(); await page.keyboard.press("Control+k");
    await input.waitFor();
    await dialog.getByRole("button", { name: "组件", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: /bill/ }).click();
    await dialog.getByRole("button", { name: "组件 bill", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "组件 bill", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: /bill/ }).waitFor();
    await page.keyboard.press("Escape"); assert.equal(await input.isVisible(), true);
    assert.equal(await page.getByRole("menu").count(), 0);
    await dialog.getByRole("button", { name: "当前工程", exact: true }).click();
    await input.fill("large"); await input.press("Enter");
    await page.getByText("搜索中… · 正在扫描，命中分批显示", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll("[data-hit-key]").length > 0);
    await page.waitForFunction(() => document.querySelector('[aria-label="搜索结果列表"]')?.textContent.includes("large match"));
    await page.waitForFunction(() => document.querySelector(".wb-search-tool")?.textContent.includes("10000 处"));
    assert.ok(await dialog.locator("[data-hit-key]").count() < 40);
    const list = dialog.getByLabel("搜索结果列表");
    await list.focus(); await page.keyboard.press("ArrowUp");
    await dialog.locator('[data-selected="true"]').filter({ hasText: "10000" }).waitFor();
    const saved = await list.evaluate(element => { element.scrollTop = 150000; element.dispatchEvent(new Event("scroll")); return element.scrollTop; });
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".monaco-editor")), true);
    await page.keyboard.press("Control+k"); await input.waitFor(); assert.equal(await input.inputValue(), "large");
    await page.waitForFunction(saved => Math.abs(document.querySelector('[aria-label="搜索结果列表"]').scrollTop - saved) < 1, saved);
    assert.equal(await page.evaluate(() => window.searchRequests.length), 1, "reopening does not scan again");
    await dialog.getByRole("button", { name: "全部折叠", exact: true }).click();
    await page.keyboard.press("Escape"); await page.keyboard.press("Control+k"); await input.waitFor();
    assert.equal(await dialog.locator("[data-hit-key]").count(), 0, "reopening keeps file folding");
    await dialog.getByRole("button", { name: "全部展开", exact: true }).click();
    await dialog.getByRole("button", { name: "更多", exact: true }).click(); await dialog.getByLabel("文件过滤").fill("*.java");
    await page.keyboard.press("Escape"); await page.keyboard.press("Control+p");
    await page.getByLabel("快速导航输入", { exact: true }).fill("#System"); await input.waitFor(); assert.equal(await input.inputValue(), "System");
    assert.equal(await dialog.locator('input[aria-label="搜索工程文件内容"]').count(), 1);
    await input.press("Enter"); await page.waitForFunction(() => window.searchRequests.length === 2);
    await page.waitForFunction(() => !document.querySelector(".qp-sec")?.textContent.includes("搜索中…"));
    for (const [name, width, height] of [["wide",1440,900],["low",1024,540],["scale150",683,512],["narrow",560,700]]) {
      await page.setViewportSize({ width, height });
      const measure = await dialog.evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight }, listHeight: element.querySelector('[aria-label="搜索结果列表"]').clientHeight, overflow: element.scrollWidth > element.clientWidth }));
      assert.equal(measure.overflow, false); assert.ok(measure.listHeight >= 80, `${theme}-${name}: result viewport ${measure.listHeight}px`); assert.ok(measure.rect.bottom <= height);
      measurements.push({ theme, name, ...measure });
      await page.screenshot({ path: fileURLToPath(new URL(`${theme}-${name}.png`, artifacts)), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await input.focus(); await input.press("ArrowDown"); await page.keyboard.press("Enter"); await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".monaco-editor")), true);
    await editor.click(); await page.keyboard.press("Control+f"); assert.equal(await dialog.count(), 0); await page.keyboard.press("Escape");
    await page.keyboard.press("Control+End"); await page.keyboard.type("// UNSAVED_SEARCH_TEXT");
    await page.keyboard.press("Control+h"); await input.waitFor(); await input.fill("UNSAVED"); await input.press("Enter");
    await page.waitForFunction(() => window.searchRequests.some(request => request.args.options.overlay?.some(doc => doc.text.includes("UNSAVED_SEARCH_TEXT"))));
    await dialog.getByRole("button", { name: /^全部工程/ }).click(); await input.fill("System"); await input.press("Enter");
    await dialog.locator('[data-hit-key]').filter({ hasText: "System" }).last().waitFor();
    await page.waitForFunction(() => document.querySelector('.wb-search-tool')?.textContent.includes("关联工程"));
    await dialog.locator('[data-hit-key][title^="D:/关联工程"]').click();
    await page.getByRole("dialog").filter({ hasText: "切换" }).waitFor();
    assert.equal(await page.evaluate(() => window.dbCalls.filter(call => call.cmd === "set_workspace").length), 0, "associated result waits for confirmation");
    await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.keyboard.press("Control+k"); await input.waitFor();
    await page.evaluate(() => { window.holdSearch = true; }); await input.fill("old"); await input.press("Enter");
    await page.waitForFunction(() => window.searchRequests.at(-1).args.options.text === "old");
    const oldSource = await page.evaluate(() => window.searchRequests.at(-1).args.source);
    await page.keyboard.press("Escape");
    await page.waitForFunction(source => window.searchCancels.includes(source), oldSource);
    await page.evaluate(() => { window.searchRequests.at(-1).finish(); window.holdSearch = false; });
    await page.keyboard.press("Control+k"); await input.waitFor(); assert.equal(await input.inputValue(), "old");
    assert.equal(await dialog.locator("[data-hit-key]").count(), 0, "obsolete completion cannot restore cancelled results");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".wb-code-context").count(), 0, "duplicate code context search entry removed");
    await page.locator(".wb-global-search").click();
    await dialog.locator(".qp-mode").filter({ hasText: "工程搜索" }).click();
    await input.waitFor(); await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Shift+p");
    await page.getByLabel("快速导航输入", { exact: true }).fill("全工程搜索");
    await dialog.getByRole("option").filter({ hasText: "全工程搜索" }).click(); await input.waitFor();
    await page.evaluate(() => { window.jarSearchContent = true; }); await input.fill("System"); await input.press("Enter");
    await dialog.getByLabel("依赖 jar 内的符号", { exact: true }).waitFor();
    await dialog.getByLabel("依赖 jar 内的源码注释", { exact: true }).waitFor();
    await dialog.getByLabel("库文件内容", { exact: true }).getByText("a.xml : 12", { exact: true }).waitFor();
    await page.setViewportSize({ width: 683, height: 512 });
    const jarListHeight = await list.evaluate(element => element.clientHeight);
    assert.ok(jarListHeight >= 80, `JAR and source-note results: ${jarListHeight}px`);
    measurements.push({ theme, name: "jar-low", listHeight: jarListHeight });
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await dialog.getByText("System 源码注释", { exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: fileURLToPath(new URL(`${theme}-jar-low.png`, artifacts)), animations: "disabled" });
    const libraryResults = dialog.getByLabel("库文件内容", { exact: true });
    await libraryResults.getByRole("button").filter({ hasText: "a.xml : 12" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("库文件内容 · 只读", { exact: true }).waitFor();
    await page.getByText('D:/NC/modules/pp/hyext/lib/same.jar ! config/a.xml', { exact: true }).waitFor();
    await editor.click(); await page.keyboard.type('LIBRARY_READONLY_PROBE');
    assert.equal((await editor.locator('.view-lines').innerText()).includes('LIBRARY_READONLY_PROBE'), false, 'Library text is read-only');
    await page.screenshot({ path: fileURLToPath(new URL(`${theme}-JAR文本只读打开.png`, artifacts)), animations: "disabled" });
    await context.close();
  }
  for (const test of [{ name: "idea", chord: "Control+Shift+f", keymap: "idea" }, { name: "custom", chord: "Control+Alt+Shift+k", keymap: "eclipse", binding: "ctrl+alt+shift+k" }]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(test => {
      localStorage.setItem("ncforge-keymap", test.keymap);
      if (test.binding) localStorage.setItem("ncforge-keybindings", JSON.stringify({ "search.workspace": test.binding }));
    }, test);
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tree", { name: "文件树", exact: true }).getByText("A.java", { exact: true }).dblclick();
    await page.locator('.wb-editor-group-slot[data-group="left"] .monaco-editor').click();
    await page.keyboard.press(test.chord); await page.getByLabel("搜索工程文件内容", { exact: true }).waitFor();
    await page.keyboard.press("Control+p"); await page.getByLabel("快速导航输入", { exact: true }).waitFor();
    await page.keyboard.press(test.chord); await page.getByLabel("搜索工程文件内容", { exact: true }).waitFor();
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(new URL("验收数据.json", artifacts), JSON.stringify({ errors, measurements }, null, 2));
  process.stdout.write(`PASS: search palette, ${measurements.length} viewport checks, 10000 hits, entry shortcuts, focus, restore, cancel, overlay, JAR and cross-project confirmation\n`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: fileURLToPath(new URL("失败现场.png", artifacts)) }); await writeFile(new URL("失败现场.txt", artifacts), await page.locator("body").innerText()); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
