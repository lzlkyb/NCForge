// 主子表联查菜单：上下键导航时浮层位置必须稳定（2026-11-19 用户报「乱跳」）。
// 真浏览器 + mock IPC，不连业务库。记录每次按键后 context-view 的坐标与尺寸。
/* global document */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const origin = process.env.GLASS_PREVIEW_URL || "http://localhost:1420";
const artifacts = new URL(process.env.UI_ARTIFACT_DIR || "../../docs/sql-action-menu-20261119/", import.meta.url);
const joins = [
  ["po_arriveorder_b", "pk_arriveorder", "pk_arriveorder"],
  ["org_purchaseorg_v", "pk_purchaseorg", "pk_purchaseorg"],
  ["org_stockorg_v", "pk_stockorg", "pk_stockorg"],
  ["org_dept_v", "pk_dept", "pk_dept"],
  ["org_group", "pk_group", "pk_group"],
  ["sm_user", "cuserid", "cuserid"],
  ["bd_psndoc", "pk_psndoc", "pk_psndoc"],
  ["bd_supplier", "pk_supplier", "pk_supplier"],
  ["bd_billtype", "pk_billtype", "pk_billtype"],
  ["bd_busitype", "pk_busitype", "pk_busitype"],
  ["bd_transporttype", "pk_transporttype", "pk_transporttype"],
  ["bd_freecustom", "pk_freecustom", "pk_freecustom"],
  ["scm_backreason", "pk_backreason", "pk_backreason"],
  ["org_purchaseorg", "pk_purchaseorg", "pk_purchaseorg"],
  ["org_stockorg", "pk_stockorg", "pk_stockorg"],
  ["org_dept", "pk_dept", "pk_dept"],
];
const names = Object.fromEntries(joins.map(([t]) => [t, t.toUpperCase()]));
const bootstrap = `
import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
mockWindows('main'); window.dbCalls=[];
const joins=${JSON.stringify(joins)};
const tables=['po_arriveorder',...joins.map(j=>j[0])];
const columns=[{name:'PK_ARRIVEORDER',type:'VARCHAR2',full:'VARCHAR2(20)',pk:true,nullable:false,zh:'主键'},{name:'VBILLCODE',type:'VARCHAR2',full:'VARCHAR2(40)',pk:false,nullable:true,zh:'单据号'}];
const conn={id:'c',name:'NC测试库',env:'test',source:'manual',url:'jdbc:oracle:thin:@localhost:1521/test',user:'NC_TEST',autoCommit:false,engine:'rust',hasPassword:true};
const tx=()=>({autoCommit:false,statements:0,rows:0,since:0});
mockIPC((cmd,args)=>{
 window.dbCalls.push({cmd,args});
 if(cmd==='get_config') return {workspace_root:null,nc_home:null,autostart_enabled:false,lang_enabled:false,lang_auto_start:false,lang_xmx_mb:null,linked_overrides:[],auto_compile:false,deploy_on_start:false};
 if(cmd==='get_app_info') return {version:'0.1.0',platform:'windows',running:false};
 if(cmd==='get_autostart') return false;
 if(cmd==='resources_status'||cmd==='workspace_recent') return [];
 if(cmd==='db_conn_list') return [conn];
 if(cmd==='db_schema_cache') return null;
 if(cmd==='db_cached_tables') return {tables:[],fetchedAt:0};
 if(cmd==='db_connect') return {url:conn.url,user:conn.user,autoCommit:false};
 if(cmd==='db_caps') return {engine:'rust',connected:true,cancel:true,stats:true};
 if(cmd==='db_read_only') return {readOnly:false,tx:tx()};
 if(cmd==='db_tx') return {tx:tx()};
 if(cmd==='db_meta'){
  if(args.kind==='tables') return {tables:tables.map(name=>({name,kind:'TABLE'}))};
  if(args.kind==='columns') return {columns};
  if(args.kind==='ncNames') return {names:${JSON.stringify(names)}};
  if(args.kind==='indexes') return {indexes:[]};
  return {names:{}};
 }
 if(cmd==='db_relations') return {foreign:{kind:'rows',columns:['RELATION','SOURCE_TABLE','SOURCE_COLUMN','TARGET_TABLE','TARGET_COLUMN','POSITION'].map(name=>({name,type:'VARCHAR2'})),rows:joins.map(([t,f,to],i)=>['FK_'+i,'po_arriveorder',f,t,to,1]),hasMore:false},references:{kind:'rows',columns:[],rows:[]},notes:[],sharedSession:false};
 if(cmd==='nc_md_dict') return {tables:[],missing:[],tableCount:0,columnCount:0};
 if(cmd==='db_exec_bound') return {kind:'rows',columns,rows:[],hasMore:false,ms:5,tx:tx()};
 if(cmd==='db_slot_acquire') return {slot:'1'};
 if(cmd==='db_slot_release') return null;
 if(cmd==='plugin:window|is_visible') return true;
 if(cmd==='plugin:window|is_maximized') return false;
 if(cmd.startsWith('plugin:')) return null;
 throw Error('menu jump IPC not configured: '+cmd);
},{shouldMockEvents:true});
localStorage.setItem('ncforge-db-tabs',JSON.stringify({tabs:[{kind:'sql',id:'jump',title:'SQL 1',connId:'c',sql:'SELECT * FROM po_arriveorder;',maxRows:500,timeoutSec:60,results:[],view:null}],active:'jump'}));
await import('/src/main.tsx');
`;
const box = page => page.evaluate(() => {
  const view = document.querySelector(".dbx-sql-action-view");
  const widget = view?.querySelector(".action-widget");
  const panel = view?.querySelector(".dbx-sql-action-preview");
  const focused = view?.querySelector(".monaco-list-row.focused .title")?.textContent ?? "";
  if (!view) return null;
  const r = view.getBoundingClientRect();
  return { top: Math.round(r.top), left: Math.round(r.left), h: Math.round(r.height), w: Math.round(r.width),
    widgetH: widget ? Math.round(widget.getBoundingClientRect().height) : 0,
    panelHidden: panel ? panel.style.visibility === "hidden" : null, panelOpen: panel ? panel.open : null, focused };
});
test("主子表联查菜单：上下键导航浮层不跳", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route(origin + "/", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, '<script type="module">' + bootstrap + '</script>');
    assert.ok(body.includes("mockWindows"));
    await route.fulfill({ response, body });
  });
  const trace = [];
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click({ timeout: 30000 });
    await page.evaluate(async () => { const s = await import("/src/lib/dbStore.ts"); await s.connect("c"); });
    await page.locator(".monaco-editor .view-line").getByText("po_arriveorder").click();
    const chip = page.locator(".monaco-editor .contentWidgets").getByText("主子表联查", { exact: true });
    await chip.waitFor({ timeout: 20000 });
    await chip.click();
    await page.locator(".dbx-sql-action-view").waitFor();
    trace.push({ key: 'show', ...(await box(page)) });
    for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowDown"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(120);
      trace.push({ key, ...(await box(page)) });
    }
    // 鼠标悬停（含标题行）：Monaco mouseover 直接 setFocus，焦点扫过标题行不得改 widget
    // 高度/位置——否则浮层在鼠标下移位、悬停行随之改变，形成来回跳动的反馈环。
    const spread = rows => ({ top: Math.max(...rows.map(r => r.top)) - Math.min(...rows.map(r => r.top)), left: Math.max(...rows.map(r => r.left)) - Math.min(...rows.map(r => r.left)) });
    const hoverBoxes = [];
    for (const idx of [2, 4, 1, 6, 3, 2]) {
      const p = await page.evaluate(i => {
        const r = [...document.querySelectorAll(".dbx-sql-action-view .monaco-list-row")][i]?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      }, idx);
      if (!p) continue;
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(120);
      const b = await box(page);
      hoverBoxes.push(b);
      trace.push({ key: "hover row" + idx, ...b });
    }
    const hs = spread(hoverBoxes);
    const hSpread = Math.max(...hoverBoxes.map(b => b.h)) - Math.min(...hoverBoxes.map(b => b.h));
    console.log("hover spread", hs, "height spread", hSpread);
    assert.ok(hoverBoxes.length >= 4 && hs.top <= 1 && hs.left <= 1 && hSpread <= 1, `hover moved/resized menu: ${JSON.stringify(hoverBoxes)}`);
    // 打开预览后再导航：预览文本逐行不同，高度变化不得拖动浮层
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    trace.push({ key: "ArrowRight(open)", ...(await box(page)) });
    for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowDown", "ArrowDown"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(150);
      trace.push({ key: "open+" + key, ...(await box(page)) });
    }
    await page.screenshot({ path: fileURLToPath(new URL("menu-open.png", artifacts)) });
    // 上游重复 layout 路径（resize 时 onDidLayoutContainer → service.layout()）：
    // 连调两次模拟。不走真 resize——headless resize 会触发上游 focus-blur 关菜单，测不到位置。
    const relayout = () => page.evaluate(async () => {
      const { monaco } = await import("/src/lib/monacoSetup.ts");
      const editor = monaco.editor.getEditors()[0];
      const svc = editor.getContribution("editor.contrib.findController")._contextViewService;
      svc.layout(); svc.layout();
    });
    const beforeRelayout = await box(page);
    await relayout();
    await page.waitForTimeout(120);
    const afterRelayout = await box(page);
    trace.push({ key: "service.layout x2(open)", ...afterRelayout });
    assert.ok(afterRelayout.h > 0 && Math.abs(afterRelayout.top - beforeRelayout.top) <= 1 && Math.abs(afterRelayout.left - beforeRelayout.left) <= 1,
      `repeated layout moved open menu: ${JSON.stringify({ beforeRelayout, afterRelayout })}`);
    await page.keyboard.press("Escape");
    await page.locator(".dbx-sql-action-view").waitFor({ state: "hidden" });
    await writeFile(new URL("trace.json", artifacts), JSON.stringify(trace, null, 2));
    const closed = trace.filter(t => t.panelOpen === false);
    const open = trace.filter(t => t.panelOpen === true);
    assert.ok(trace.every(t => t && t.h > 0), "menu not laid out: " + JSON.stringify(trace[0]));
    assert.ok(closed.length >= 8 && open.length >= 6, `trace missing panel states: closed=${closed.length} open=${open.length}`);
    const cs = spread(closed), os = spread(open);
    console.log("closed spread", cs, "open spread", os);
    assert.deepEqual(errors, []);
    assert.ok(cs.top <= 1 && cs.left <= 1, `closed-panel navigation moved: ${JSON.stringify(cs)}`);
    assert.ok(os.top <= 1 && os.left <= 1, `open-panel navigation moved: ${JSON.stringify(os)}`);
  } catch (error) {
    await writeFile(new URL("trace.json", artifacts), JSON.stringify(trace, null, 2)).catch(() => {});
    await page.screenshot({ path: fileURLToPath(new URL("failure.png", artifacts)) }).catch(() => {});
    throw error;
  } finally { await context.close(); await browser.close(); }
});