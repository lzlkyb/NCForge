// 补全质量探针：真实规模（15k 表）+ 模拟 Oracle 往返延迟（冷读 180ms）。
// 六场景断言回归：冷点号/列前缀/拼音/中文 IME/裸表名 Enter/点触发排序；前后基线在 docs 目录。
/* global document, window */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const origin = process.env.GLASS_PREVIEW_URL || "http://localhost:1420";
const artifacts = new URL(process.env.UI_ARTIFACT_DIR || "../../docs/sql-assist-quality-20261119/", import.meta.url);
const COLD_MS = Number(process.env.COLD_MS || 180);
const bootstrap = `
import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
mockWindows('main'); window.dbCalls=[];
const cold=${COLD_MS};
const seen=new Set();
const delay=(ms)=>new Promise(r=>setTimeout(r,ms));
const prefixes=['po_','bd_','org_','sm_','scm_','arap_','ic_','pu_'];
const tables=[];
for(let i=0;i<15000;i++){const p=prefixes[i%8];tables.push({name:p+'table_'+i,kind:i%37===0?'VIEW':'TABLE'});}
tables.push({name:'po_arriveorder',kind:'TABLE'},{name:'po_arriveorder_b',kind:'TABLE'},{name:'po_order',kind:'TABLE'},{name:'bd_psndoc',kind:'TABLE'},{name:'org_purchaseorg',kind:'TABLE'});
const zh={'po_arriveorder':'到货单','po_order':'采购订单','bd_psndoc':'人员基本档案','org_purchaseorg':'采购组织'};
const colsFor=(t)=>{
 const base=[{name:'PK_'+t.slice(0,12).toUpperCase(),type:'VARCHAR2',full:'VARCHAR2(20)',pk:true,nullable:false,zh:'主键'},
  {name:'VBILLCODE',type:'VARCHAR2',full:'VARCHAR2(40)',pk:false,nullable:true,zh:'单据号'},
  {name:'DBILLDATE',type:'VARCHAR2',full:'VARCHAR2(10)',pk:false,nullable:true,zh:'单据日期'},
  {name:'PK_ORG',type:'VARCHAR2',full:'VARCHAR2(20)',pk:false,nullable:true,zh:'组织'},
  {name:'PK_PSNDOC',type:'VARCHAR2',full:'VARCHAR2(20)',pk:false,nullable:true,zh:'人员'},
  {name:'NMONEY',type:'NUMBER',full:'NUMBER(28,8)',pk:false,nullable:true,zh:'金额'},
  {name:'BFLAG',type:'CHAR',full:'CHAR(1)',pk:false,nullable:true,zh:'标志'},
  {name:'CREATIONTIME',type:'VARCHAR2',full:'VARCHAR2(19)',pk:false,nullable:true,zh:'创建时间'}];
 // 表体带主表主键列（NC 真实形态：无物理外键、md 也不登记类引用）
 if(/_b\\d*$/.test(t)) base.push({name:'PK_'+t.replace(/_b\\d*$/,'').slice(0,12).toUpperCase(),type:'VARCHAR2',full:'VARCHAR2(20)',pk:false,nullable:false,zh:'主表主键'});
 return base;
};
const conn={id:'c',name:'NC测试库',env:'test',source:'manual',url:'jdbc:oracle:thin:@localhost:1521/test',user:'NC_TEST',autoCommit:false,engine:'rust',hasPassword:true};
const tx=()=>({autoCommit:false,statements:0,rows:0,since:0});
mockIPC(async (cmd,args)=>{
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
 if(cmd==='db_slot_acquire') return {slot:'1'};
 if(cmd==='db_slot_release') return null;
 if(cmd==='db_meta'){
  if(args.kind==='tables'){await delay(60);return {tables};}
  if(args.kind==='columns'){const key=args.arg??args.table;const first=!seen.has(key);seen.add(key);if(first)await delay(cold);return {columns:colsFor(key)};}
  if(args.kind==='ncNames') return {names:zh};
  if(args.kind==='indexes') return {indexes:[]};
  return {names:{}};
 }
 if(cmd==='db_relations'){await delay(cold);return {foreign:{kind:'rows',columns:['RELATION','SOURCE_TABLE','SOURCE_COLUMN','TARGET_TABLE','TARGET_COLUMN','POSITION'].map(name=>({name,type:'VARCHAR2'})),rows:[['FK1','po_arriveorder','PK_ORG','org_purchaseorg','PK_ORG',1],['FK2','po_arriveorder','PK_PSNDOC','bd_psndoc','PK_PSNDOC',1]],hasMore:false},references:{kind:'rows',columns:[],rows:[]},notes:[],sharedSession:false};}
 if(cmd==='nc_md_dict') return {tables:[],missing:[],tableCount:0,columnCount:0};
 if(cmd==='db_exec_bound') return {kind:'rows',columns:[],rows:[],hasMore:false,ms:5,tx:tx()};
 if(cmd==='plugin:window|is_visible') return true;
 if(cmd==='plugin:window|is_maximized') return false;
 if(cmd.startsWith('plugin:')) return null;
 throw Error('assist quality IPC not configured: '+cmd);
},{shouldMockEvents:true});
localStorage.setItem('ncforge-db-tabs',JSON.stringify({tabs:[{kind:'sql',id:'q',title:'SQL 1',connId:'c',sql:'',maxRows:500,timeoutSec:60,results:[],view:null}],active:'q'}));
await import('/src/main.tsx');
`;
const popup = page => page.evaluate(() => {
  const w = document.querySelector(".monaco-editor .suggest-widget");
  if (!w || !w.classList.contains("visible")) return { visible: false };
  const rows = [...w.querySelectorAll(".monaco-list-row")].slice(0, 10).map(r => ({
    label: r.querySelector(".label-name")?.textContent ?? r.textContent?.slice(0, 40),
    focused: r.classList.contains("focused"),
  }));
  return { visible: true, rows, docs: !!w.querySelector(".details") };
});
const type = async (page, text, delay = 35) => { for (const ch of text) { await page.keyboard.type(ch, { delay: 5 }); await page.waitForTimeout(delay); } };
test("补全质量探针", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const consoleMsgs = [];
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") consoleMsgs.push(m.type() + ": " + m.text().slice(0, 200)); });
  await page.route(origin + "/", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, '<script type="module">' + bootstrap + '</script>');
    assert.ok(body.includes("mockWindows"));
    await route.fulfill({ response, body });
  });
  const report = {};
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click({ timeout: 30000 });
    await page.evaluate(async () => { const s = await import("/src/lib/dbStore.ts"); await s.connect("c"); });
    await page.locator(".monaco-editor .view-line").first().click();
    await page.waitForTimeout(800); // 表清单加载
    // 场景1：冷列读（180ms RTT > 120ms 自动预算）。点触发后不再敲任何键：
    // 加载中行必须出现，且字段到达后必须自动刷新（不许要求用户手动 Ctrl+空格）。
    await type(page, "SELECT * FROM po_arriveorder a");
    await page.keyboard.press(".");
    await page.waitForTimeout(150);
    report.coldDotAt150 = await popup(page);
    await page.waitForTimeout(550);
    report.coldDotAt700 = await popup(page);
    await page.keyboard.press("Control+Space");
    await page.waitForTimeout(400);
    report.coldDotInvoke = await popup(page);
    // 场景2：热缓存下列前缀过滤 + 首行焦点
    await type(page, "v");
    await page.waitForTimeout(250);
    report.columnPrefix = await popup(page);
    // 场景3：拼音首字母找中文表（采购订单 → cgdd）
    await page.keyboard.press("Control+a"); await page.keyboard.press("Delete");
    await type(page, "cgdd");
    await page.waitForTimeout(300);
    report.pinyinInitials = await popup(page);
    // 场景4：中文全名找表。真 IME 走 composition 事件（Playwright insertText 不走键盘源，
    // 会绕过 quick-suggest 的光标判据）——用 CDP imeSetComposition 模拟真实输入法。
    await page.keyboard.press("Control+a"); await page.keyboard.press("Delete");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "采购订单", selectionStart: 4, selectionEnd: 4 });
    await page.waitForTimeout(120);
    await cdp.send("Input.insertText", { text: "采购订单" });
    await page.waitForTimeout(300);
    report.chineseName = await popup(page);
    await page.keyboard.press("Control+Space");
    await page.waitForTimeout(400);
    report.chineseInvoke = await popup(page);
    // 场景5：裸表名唯一命中 → 模板预选 → 首行必须有焦点，Enter 必须接受
    await page.keyboard.press("Control+a"); await page.keyboard.press("Delete");
    await type(page, "po_arriveorder");
    await page.waitForTimeout(700);
    report.bareTable = await popup(page);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    report.afterEnter = await page.evaluate(() => document.querySelector(".monaco-editor .view-lines")?.textContent?.slice(0, 120));
    // 场景6：空前缀点触发排序——主键必须排在字母序之前
    await page.keyboard.press("Control+a"); await page.keyboard.press("Delete");
    await type(page, "SELECT * FROM po_order b WHERE b.");
    await page.waitForTimeout(400);
    report.dotOrder = await popup(page);
    // 场景7：真 NC 形态——表体无物理外键、md 无类引用，只有命名+主键列证据。
    // 联查菜单必须给出「单据明细」组与 _b 表（用户真机报「主子表关联没出来」）。
    await page.keyboard.press("Control+a"); await page.keyboard.press("Delete");
    await type(page, "SELECT * FROM po_arriveorder");
    await page.keyboard.press("Escape");
    const chip = page.getByRole("button", { name: /^主子表联查 ·/ });
    await chip.waitFor({ timeout: 20000 });
    await chip.click();
    await page.locator(".dbx-sql-action-view").waitFor();
    await page.waitForTimeout(300);
    report.bodyMenu = await page.evaluate(() => [...document.querySelectorAll(".dbx-sql-action-view .monaco-list-row")].map(t => t.textContent));
    await page.keyboard.press("Escape");
    // 场景8：键盘主键。光标在词中间（写完一句回看的姿态）Alt+Enter 必须出菜单
    // （Ctrl+. 被中文 IME 标点切换吞掉）；同姿态 Ctrl+空格 必须有整词锚定的追加 LEFT JOIN。
    await page.keyboard.press("End");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(600);
    await page.keyboard.press("Alt+Enter");
    await page.locator(".dbx-sql-action-view").waitFor({ timeout: 20000 });
    await page.waitForTimeout(300);
    report.midWordAltEnter = await page.evaluate(() => [...document.querySelectorAll(".dbx-sql-action-view .monaco-list-row")].map(t => t.textContent));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+Space");
    await page.waitForTimeout(400);
    report.midWordSuggest = await popup(page);
    await page.keyboard.press("Escape");
    report.errors = errors;
    await writeFile(new URL("report.json", artifacts), JSON.stringify(report, null, 2));
    const labels = r => (r?.visible ? r.rows : []).map(x => x.label);
    // 冷点号：FROM 打全表名时已预读字段，150ms 内必须有真候选（不许空白/加载中挂到手动刷新）
    assert.ok(report.coldDotAt150.visible, "cold dot blank at 150ms: " + JSON.stringify(report.coldDotAt150));
    assert.ok(labels(report.coldDotAt700).some(l => l === "vbillcode"), "cold dot never surfaced columns: " + JSON.stringify(report.coldDotAt700));
    assert.ok(labels(report.coldDotAt700)[0]?.startsWith("pk"), "pk not first on empty prefix: " + JSON.stringify(labels(report.coldDotAt700)));
    assert.equal(labels(report.columnPrefix)[0], "vbillcode");
    assert.ok(report.columnPrefix.rows[0].focused, "column list lost initial focus");
    // 拼音首字母与中文全名都要自动弹出并命中 po_order
    assert.ok(report.pinyinInitials.visible && labels(report.pinyinInitials).includes("po_order"), "pinyin initials missing: " + JSON.stringify(report.pinyinInitials));
    assert.ok(report.chineseName.visible && labels(report.chineseName).includes("po_order"), "chinese auto trigger missing: " + JSON.stringify(report.chineseName));
    assert.ok(report.chineseName.rows[0].focused, "explicit auto popup withheld focus");
    // 裸表名唯一命中：首行有焦点，Enter 接受预选模板
    assert.ok(report.bareTable.rows[0].focused, "bare table list withheld focus: " + JSON.stringify(report.bareTable.rows?.slice(0, 3)));
    assert.ok(String(report.afterEnter).replace(/\u00a0/g, " ").includes("SELECT * FROM po_arriveorder"), "Enter did not accept preselected template: " + report.afterEnter);
    assert.ok(labels(report.dotOrder)[0]?.startsWith("pk"), "pk buried on dot trigger: " + JSON.stringify(labels(report.dotOrder)));
    // 主子表约定证据：无外键/类引用时菜单仍须给明细组与 _b 表
    assert.ok(report.bodyMenu.some(t => t.includes("单据明细")), "detail group missing: " + JSON.stringify(report.bodyMenu));
    assert.ok(report.bodyMenu.some(t => t.includes("po_arriveorder_b")), "body table missing: " + JSON.stringify(report.bodyMenu));
    // 词中姿态：Alt+Enter 出明细组；Ctrl+空格 有整词锚定的联查候选
    assert.ok(report.midWordAltEnter.some(t => t.includes("单据明细")), "Alt+Enter mid-word menu missing detail group: " + JSON.stringify(report.midWordAltEnter));
    assert.ok(labels(report.midWordSuggest).some(l => String(l).includes("追加 LEFT JOIN")), "mid-word Ctrl+Space missing join snippet: " + JSON.stringify(report.midWordSuggest));
    assert.deepEqual(errors, []);
    console.log("REPORT", JSON.stringify(report, null, 1));
  } catch (error) {
    await writeFile(new URL("report.json", artifacts), JSON.stringify({ ...report, errors, consoleMsgs: consoleMsgs.slice(0, 12), fatal: String(error), calls: await page.evaluate(() => (window.dbCalls ?? []).slice(-12).map(c => c.cmd)).catch(() => []) }, null, 2)).catch(() => {});
    await page.screenshot({ path: fileURLToPath(new URL("failure.png", artifacts)) }).catch(() => {});
    throw error;
  } finally { await context.close(); await browser.close(); }
});
