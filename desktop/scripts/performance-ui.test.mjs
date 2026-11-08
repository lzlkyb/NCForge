// Production-only performance regression: real workers and a wide virtualized grid.
/* global Event, document, getComputedStyle, window */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dist = new URL("../dist/", import.meta.url);
const artifacts = new URL("../../docs/数据库性能验收-2026-11-08/", import.meta.url);
test("production worker filtering and bounded wide-grid DOM", async () => {
  const html = await readFile(new URL("index.html", dist), "utf8");
  const entry = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1];
  assert.ok(entry);
  const source = await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
  let bootstrap = source.match(/const bootstrap=`([\s\S]*?)`;/)?.[1];
  assert.ok(bootstrap);
  bootstrap = bootstrap.replace("/node_modules/@tauri-apps/api/mocks.js", "/mocks.js")
    .replace("mockWindows('main');", `mockWindows('main');
      window.wideColumns=Array.from({length:80},(_,i)=>({name:'C'+i,type:'VARCHAR2',precision:30,scale:0}));
      window.wideRows=Array.from({length:3000},(_,r)=>Array.from({length:80},(_,c)=>c===0?'KEY-'+r:'R'+r+'-C'+c));`)
    .replace("if(cmd==='db_exec_bound')", "if(cmd==='db_slot_acquire')return {slot:'1',tx:tx()}; if(cmd==='db_exec' || cmd==='db_exec_bound')")
    .replace("if(cmd==='db_caps')", "if(cmd==='db_set_schema'){window.fixtureSchema=args.schema || 'NC_TEST';return {schema:window.fixtureSchema};} if(cmd==='db_caps')")
    .replace("if(args.kind==='tables')", "if(args.kind==='schemas')return {schemas:['NC_TEST','OTHER'],current:window.fixtureSchema || 'NC_TEST',user:'NC_TEST'};if(args.kind==='tables')")
    .replace("kind:'rows',columns,rows:[[1,'A','甲'],[2,'B','乙'],[3,'C','丙']]", "kind:'rows',columns:window.wideColumns,rows:window.wideRows")
    .replace("ms:10,tx:tx()", "ms:10,output:[],tx:tx()")
    .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'select * from test_table',maxRows:5000,timeoutSec:30}")
    .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", "")
    .replace("/src/main.tsx", entry);
  const mocks = await readFile(new URL("../node_modules/@tauri-apps/api/mocks.js", import.meta.url));
  const csp = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).app.security.csp;
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname === "/") {
        res.setHeader("Content-Type", "text/html"); res.setHeader("Content-Security-Policy", csp);
        // Production bootstrap scripts are not needed for the fixed-theme fixture.
        res.end(html.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/fixture.js"></script>'));
      } else if (pathname === "/fixture.js" || pathname === "/mocks.js") {
        res.setHeader("Content-Type", "text/javascript"); res.end(pathname === "/fixture.js" ? bootstrap : mocks);
      } else if (/^\/assets\/[\w.-]+$/.test(pathname) || pathname === "/icon.png") {
        res.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "application/octet-stream");
        res.end(await readFile(new URL(pathname.slice(1), dist)));
      } else { res.writeHead(404); res.end(); }
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  const errors = [], measurements = {};
  try {
    browser = await chromium.launch({ headless: true, channel: "msedge" });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click();
    await page.locator("#dbx-conn-c").click();
    await page.getByRole("textbox", { name: "SQL 查询编辑器", exact: true }).focus();
    await page.keyboard.press("Control+f");
    await page.locator(".dbx-editor .find-widget.visible").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("textbox", { name: "SQL 查询编辑器", exact: true }).focus(); await page.keyboard.press("Control+Enter");
    await page.locator("#dbx-cell-0-0").waitFor();
    measurements.rows = await page.locator(".dbx-grow").count();
    measurements.headers = await page.locator(".dbx-gh").count();
    assert.ok(measurements.rows < 60); assert.ok(measurements.headers < 25);
    await page.setViewportSize({width:1920,height:1020});
    await page.waitForFunction(()=>{
      const context=document.querySelector('.dbx-command-header .dbx-context'),tools=document.querySelector('.dbx-command-header .dbx-sqlbar');
      if (!context || !tools) return false;
      const a=context.getBoundingClientRect(),b=tools.getBoundingClientRect();
      return a.y < b.bottom && b.y < a.bottom;
    });
    measurements.commandHeader=await page.locator('.dbx-command-header').evaluate(el=>({height:el.getBoundingClientRect().height,overflow:el.scrollWidth>el.clientWidth+1}));
    assert.equal(measurements.commandHeader.overflow,false);
    // Inspect actual packaged CSS after lazy database styles have loaded.
    await page.locator("#dbx-cell-0-1").click();
    await page.locator("#dbx-cell-5-6").click({modifiers:["Shift"]});
    assert.equal(await page.locator('.dbx-gc[data-cell]').count(),36);
    const inspect = () => page.evaluate(() => {
      const interior=document.querySelector('#dbx-cell-2-3'),active=document.querySelector('#dbx-cell-5-6'),edge=document.querySelector('#dbx-cell-0-1');
      return {interiorOutline:getComputedStyle(interior).outlineStyle,interiorBorder:getComputedStyle(interior,'::after').borderTopWidth,
        activeBorder:getComputedStyle(active,'::after').borderTopWidth,edgeBorder:getComputedStyle(edge,'::after').borderTopWidth,
        fill:getComputedStyle(interior).backgroundColor};
    });
    const focused=await inspect();assert.equal(focused.interiorOutline,'none');assert.equal(focused.interiorBorder,'0px');assert.equal(focused.edgeBorder,'1px');assert.equal(focused.activeBorder,'2px');
    const contentArtifacts=artifacts;await mkdir(contentArtifacts,{recursive:true});
    await page.screenshot({path:fileURLToPath(new URL('数据库-宽屏.png',contentArtifacts))});
    const selectionArtifacts=new URL('选择态/',artifacts);await mkdir(selectionArtifacts,{recursive:true});
    await page.locator('.dbx-schema-chip').click();
    const input=page.getByRole('combobox',{name:'筛选 schema',exact:true});await input.waitFor();
    const field=await input.evaluate(el=>({outline:getComputedStyle(el).outlineStyle,parentBorder:getComputedStyle(el.parentElement).borderTopWidth,parentRadius:getComputedStyle(el.parentElement).borderTopLeftRadius}));
    assert.equal(field.outline,'none');assert.equal(field.parentBorder,'1px');assert.notEqual(field.parentRadius,'0px');
    const inactive=await inspect();assert.notEqual(inactive.fill,focused.fill);assert.equal(inactive.activeBorder,'1px');
    await page.screenshot({path:fileURLToPath(new URL('搜索框-浅色.png',selectionArtifacts))});
    await input.fill('oth');await input.press('ArrowDown');await input.press('Enter');
    await page.waitForFunction(()=>document.activeElement?.classList.contains('dbx-schema-chip'));
    assert.match(await page.locator('.dbx-schema-name').textContent(),/OTHER/);
    measurements.selection={focused,inactive,field,variants:[]};
    for(const dark of [false,true])for(const material of ['classic','glass'])for(const density of ['standard','comfortable']) {
      await page.evaluate(({dark,material,density})=>{document.documentElement.classList.toggle('dark',dark);document.documentElement.dataset.uiStyle=material;document.documentElement.dataset.uiDensity=density;window.dispatchEvent(new window.CustomEvent('themechange',{detail:dark?'dark':'light'}));window.dispatchEvent(new Event('ui-density-change'));},{dark,material,density});
      await page.locator('.dbx-grid').focus();const result=await inspect();assert.equal(result.interiorBorder,'0px');assert.equal(result.activeBorder,'2px');
      measurements.selection.variants.push({dark,material,density,...result});
      if(material==='classic'&&density==='comfortable')await page.screenshot({path:fileURLToPath(new URL(dark?'选区-深色.png':'选区-浅色.png',selectionArtifacts))});
    }
    await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});await page.locator('.dbx-grid').focus();assert.equal((await inspect()).activeBorder,'2px');await page.emulateMedia({forcedColors:'none',reducedMotion:'no-preference'});
    await page.locator(".dbx-grid").evaluate(el => { el.scrollLeft = el.scrollWidth; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await page.locator("#dbx-cell-0-79").waitFor();
    assert.equal(await page.locator("#dbx-cell-0-0").count(), 0);
    await page.getByRole("button", { name: "筛选结果", exact: true }).click();
    const start = Date.now(); await page.getByRole("textbox", { name: "在结果中筛选", exact: true }).fill("KEY-2999");
    await page.locator("#dbx-cell-2999-79").waitFor();
    measurements.workerFilterMs = Date.now() - start;
    assert.equal(await page.locator(".dbx-grow").count(), 1);
    const refilterStart=Date.now();
    await page.getByRole("textbox", { name: "在结果中筛选", exact: true }).fill("no-match");
    await page.getByText("筛选后没有匹配的行", { exact: true }).waitFor();
    measurements.workerRefilterMs=Date.now()-refilterStart;
    await page.getByRole("button", { name: "清除结果筛选", exact: true }).click();
    await page.locator("#dbx-cell-0-79").waitFor();
    await page.getByRole("button", { name: "释放查询结果", exact: true }).click();
    assert.equal(await page.locator(".dbx-grid").count(), 0);
    assert.equal(errors.length, 0, errors.join("\n"));
    await mkdir(artifacts, { recursive: true });
    await writeFile(new URL("生产界面检查.json", artifacts), JSON.stringify({ passed: true, measurements, errors }, null, 2));
    await writeFile(new URL("选择态界面检查.json", selectionArtifacts), JSON.stringify({ passed: true, selection: measurements.selection, errors }, null, 2));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
