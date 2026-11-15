// Identical packaged-fixture workloads before/after; no database, filesystem or service writes.
/* global window, document, requestAnimationFrame, performance, MutationObserver, PerformanceObserver */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const phase = process.argv[2] || "after";
const trace = process.argv.includes("--trace-log");
assert.ok(["before", "after"].includes(phase));
const dist = new URL("../dist/", import.meta.url);
const artifacts = new URL("../../docs/工作台滚动优化验收-2026-11-13/", import.meta.url);
const html = await readFile(new URL("index.html", dist), "utf8");
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1];
assert.ok(entry, "A production build is required");
const dbFixture = await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
const raw = dbFixture.match(/const bootstrap=\x60([\s\S]*?)\x60;/)?.[1];
const material = await readFile(new URL("material-workbench-acceptance.mjs", import.meta.url), "utf8");
const memory = material.match(/\.replace\('mockIPC\(\(cmd,args\)=>\{', \x60([\s\S]*?)\x60\)/)?.[1];
assert.ok(raw && memory, "Existing memory fixtures are required");
const overrides = [
  "if(cmd==='fs_list_dir')return Array.from({length:3000},(_,i)=>({name:'Demo'+String(i).padStart(4,'0')+'.java',isDir:false,size:120}));",
  "if(cmd==='service_log_tail'||cmd==='service_log_read'){const text=cmd==='service_log_tail'?window.scrollLog:'';return {text,startOffset:cmd==='service_log_tail'?0:window.scrollLog.length,offset:window.scrollLog.length,fileId:'scroll-log',size:window.scrollLog.length,eof:true,reset:false,truncated:false,lineOffsets:window.scrollLogOffsets};}",
].join("\n");
let bootstrap = raw.replace("/node_modules/@tauri-apps/api/mocks.js", "/mocks.js")
  .replace("mockWindows('main');", [
    "mockWindows('main');window.scrollViolations=[];document.addEventListener('securitypolicyviolation',e=>window.scrollViolations.push(e.effectiveDirective));",
    "window.scrollColumns=Array.from({length:100},(_,i)=>({name:'FIELD_'+i,type:'VARCHAR2',precision:30,scale:0,pk:i===0}));",
    "window.scrollRows=Array.from({length:10000},(_,r)=>Array.from({length:100},(_,c)=>'R'+r+'-C'+c));",
    "window.scrollLogOffsets=[];let logOffset=0;window.scrollLog=Array.from({length:10000},(_,i)=>{window.scrollLogOffsets.push(logOffset);const line='2026-11-13 20:00:00 INFO [main] demo.Service - output '+i+' '+'.'.repeat(160)+'\\n';logOffset+=line.length;return line;}).join('');",
    "localStorage.setItem('theme','light');localStorage.setItem('ncforge.ui-style','classic');localStorage.setItem('ncforge.ui-density','standard');localStorage.setItem('ncforge-rail-expanded','0');",
  ].join("\n"))
  .replace("mockIPC((cmd,args)=>{", memory.replace("mockIPC((cmd,args)=>{", "mockIPC((cmd,args)=>{\n" + overrides))
  .replace("workspace_root:null", "workspace_root:fixtureRoot")
  .replace("if(cmd==='db_exec_bound')", "if(cmd==='db_slot_acquire')return {slot:'scroll-slot',tx:tx()};if(['db_exec','db_exec_result','db_exec_bound'].includes(cmd))")
  .replace("kind:'rows',columns,rows:[[1,'A','甲'],[2,'B','乙'],[3,'C','丙']]", "kind:'rows',columns:window.scrollColumns,rows:window.scrollRows")
  .replace("ms:10,tx:tx()", "ms:10,output:[],tx:tx()")
  .replace("throw Error('DB acceptance IPC not configured: '+cmd);", "return null;")
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'select * from TEST_TABLE',maxRows:10000,timeoutSec:60}")
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", "")
  .replace("/src/main.tsx", entry);
assert.ok(!bootstrap.includes("/src/"), "No development module fallback");
const mocks = await readFile(new URL("../node_modules/@tauri-apps/api/mocks.js", import.meta.url));
const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash("sha256").update(m[1]).digest("base64") + "'");
const csp = config.app.security.csp.replace(/script-src ([^;]+)/, (_, v) => "script-src " + v + " " + hashes.join(" "));
await mkdir(artifacts, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/") {
      res.setHeader("Content-Type", "text/html"); res.setHeader("Content-Security-Policy", csp);
      res.end(html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/fixture.js"></script>'));
    } else if (pathname === "/fixture.js" || pathname === "/mocks.js") {
      res.setHeader("Content-Type", "text/javascript"); res.end(pathname === "/fixture.js" ? bootstrap : mocks);
    } else if (/^\/(assets|fonts)\/[\w/.-]+$/.test(pathname) || pathname === "/icon.png") {
      res.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "application/octet-stream");
      res.end(await readFile(new URL(pathname.slice(1), dist)));
    } else { res.writeHead(404); res.end(); }
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser, page;
const errors = [], measurements = [];
try {
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000); page.on("pageerror", e => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "domcontentloaded" });
  const navigate = name => page.locator(".app-side").getByRole("button", { name: new RegExp("^" + name) }).click();
  const sample = async (name, selector, axis) => {
    await page.locator(selector).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const reading = await page.locator(selector).evaluate(async (el, { axis, steps }) => {
      el.scrollTop = 0; el.scrollLeft = 0;
      for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame);
      const frames = [], longTasks = [];
      let mutations = 0, previous = performance.now(), blanks = 0;
      const observer = new MutationObserver(records => { mutations += records.filter(r => r.type === "childList" || r.type === "characterData").length; });
      observer.observe(el, { subtree: true, childList: true, characterData: true });
      const tasks = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
      tasks.observe({ type: "longtask", buffered: false });
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight), maxLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      for (let i = 0; i < steps; i++) {
        const now = await new Promise(requestAnimationFrame); frames.push(now - previous); previous = now;
        const half = steps / 2, p = (i % half) / (half - 1), sweep = i < half ? p : 1 - p;
        if (axis !== "x") el.scrollTop = Math.min(maxTop, 20000) * sweep;
        if (axis !== "y") el.scrollLeft = Math.min(maxLeft, 10000) * sweep;
        // Check on the following paint; browser scroll is continuous even when React only updates window boundaries.
        if (el.classList.contains("dbx-grid") && i > 0 && i % 15 === 0) {
          const box = el.getBoundingClientRect(), y = Math.min(box.bottom - 30, box.top + 90);
          const hit = document.elementFromPoint(box.left + 80, y);
          if (!hit?.closest(".dbx-gc,.dbx-gh")) blanks++;
        }
      }
      for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
      observer.disconnect(); tasks.disconnect();
      const sorted = frames.slice(1).sort((a, b) => a - b), percentile = p => Math.round(sorted[Math.floor((sorted.length - 1) * p)] * 100) / 100;
      return { p50: percentile(.5), p95: percentile(.95), max: sorted.at(-1), slowFrames: sorted.filter(v => v > 25).length, frames: sorted.length, longTasks: longTasks.length, mutations, blanks, maxTop, maxLeft, loadedRows: el.classList.contains("dbx-grid") ? Number(el.getAttribute("aria-rowcount")) - 1 : undefined, logFooter: el.classList.contains("sc-log-body") ? el.closest(".sc-log")?.querySelector(".sc-log-footer")?.textContent : undefined, renderedRows: el.querySelectorAll(".dbx-grow,.sc-log-row").length, headers: el.querySelectorAll(".dbx-gh").length };
    }, { axis, steps: trace ? 24 : 180 });
    measurements.push({ name, axis, ...reading });
    console.log(JSON.stringify({ phase, name, ...reading }));
    if (phase === "after" && selector === ".dbx-grid") {
      assert.ok(reading.renderedRows < 85 && reading.headers < 30, "Grid DOM stays bounded");
      assert.equal(reading.blanks, 0, name + " has no missing visible cells");
    }
  };
  await navigate("数据库"); await page.locator("#dbx-conn-c").click();
  await page.getByRole("textbox", { name: "SQL 查询编辑器", exact: true }).focus(); await page.keyboard.press("Control+Enter");
  await page.locator(".dbx-grow [role=gridcell]").first().waitFor();
  if (!trace) {
  await sample("wide-grid-horizontal", ".dbx-grid", "x");
  await sample("wide-grid-vertical", ".dbx-grid", "y");
  await sample("wide-grid-diagonal", ".dbx-grid", "xy");
  if (phase === "after") {
    const box = await page.locator(".dbx-grid").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.wheel(320, 480);
    await page.waitForFunction(() => { const el = document.querySelector(".dbx-grid"); return el.scrollTop > 0 && el.scrollLeft > 0; });
    await page.locator(".dbx-grid").focus(); await page.keyboard.press("Control+End");
    const count = await page.locator(".dbx-grid").getAttribute("aria-rowcount");
    await page.locator('[role="row"][aria-rowindex="' + count + '"]').waitFor();
    await page.keyboard.press("Control+Home"); await page.locator('.dbx-grow[aria-rowindex="2"]').waitFor();
  }
  }
  await navigate("代码"); await page.locator(".wb-tree-list .wb-row").first().waitFor();
  if (!trace) await sample("file-tree", ".wb-tree-list", "y");
  await page.locator(".wb-service-entry").click(); await page.locator(".sc-log-row").first().waitFor();
  const session = trace ? await page.context().newCDPSession(page) : null, events = [];
  if (session) {
    session.on("Tracing.dataCollected", ({ value }) => events.push(...value));
    await session.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" });
  }
  await sample("service-log", ".sc-log-pane:not([hidden]) .sc-log-body", "y");
  if (session) {
    const done = new Promise(resolve => session.once("Tracing.tracingComplete", resolve));
    await session.send("Tracing.end"); await done;
    await writeFile(new URL("log-trace.json", artifacts), JSON.stringify({ traceEvents: events }));
  }
  if (phase === "after") await page.screenshot({ path: fileURLToPath(new URL("日志与整体外壳.png", artifacts)), animations: "disabled" });
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.scrollViolations), []);
  await writeFile(new URL((trace ? "trace-sample" : phase) + ".json", artifacts), JSON.stringify({ phase, entry, measurements, errors }, null, 2) + "\n");
} catch (error) {
  if (page) console.log(JSON.stringify({ error: error.message, errors, body: (await page.locator("body").innerText()).slice(0, 2500), calls: await page.evaluate(() => window.dbCalls?.slice(-8)) }));
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
