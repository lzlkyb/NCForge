// Production assets + packaged CSP; fixtures never contact a business database.
/* global window, document, navigator, localStorage, getComputedStyle, innerWidth */
import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";
const dist=new URL("../dist/",import.meta.url), artifacts=new URL("../../docs/数据库性能验收-2026-11-08/复制导出/",import.meta.url);
const html=await readFile(new URL("index.html",dist),"utf8"),entry=html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
assert.ok(entry,"Build production assets first");
const base=(await readFile(new URL("db-workbench-acceptance.test.mjs",import.meta.url),"utf8")).match(/const bootstrap=`([\s\S]*?)`;/)[1];
const mocks=await readFile(new URL("../node_modules/@tauri-apps/api/mocks.js",import.meta.url));
const config=JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json",import.meta.url),"utf8"));
const nonce="db-transfer-acceptance",hashes=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>"'sha256-"+createHash("sha256").update(m[1]).digest("base64")+"'");
const csp=config.app.security.csp.replace(/script-src ([^;]+)/,(_,v)=>`script-src ${v} ${hashes.join(" ")}`).replace(/style-src ([^;]+)/,(_,v)=>`style-src ${v} 'nonce-${nonce}'`);
const bootstrap=base.replace("/node_modules/@tauri-apps/api/mocks.js","/__mocks.js")
 .replace("mockWindows('main');",`mockWindows('main');window.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push(e.effectiveDirective));
 window.fixtureRows=Array.from({length:800},(_,i)=>['00012345678901234567890',i===0?'0012':i===1?'=SUM(A1)':'NC-'+i,i===0?'中文\\t引号"\\n第二行':'物料 '+i]);`)
 .replace("type:'NUMBER',full:'NUMBER'","type:'CHAR',full:'CHAR(20)'")
 .replace("const conn=",`columns.push(...Array.from({length:9},(_,i)=>({name:'EXTRA_'+i,type:'VARCHAR2',full:'VARCHAR2(100)',pk:false,nullable:true,zh:'扩展字段 '+i})));window.fixtureRows=window.fixtureRows.map(r=>[...r,...Array.from({length:9},(_,i)=>'附加值 '+i)]);const conn=`)
 .replace(" if(cmd==='get_config')",` if(cmd==='db_transfer_pick') {if(window.pickCancel)return null;if(window.pickError)throw Error('目录不可写');return {token:'native-choice',path:'D:/验收/'+args.fileName};}
 if(cmd==='db_transfer_open')return;
 if(cmd==='db_transfer_file')return new Promise((resolve,reject)=>{const req=args.req;window.transferRequest=req;window.transferReject=reject;window.transferProgress=p=>window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'db:export-progress',payload:{id:req.id,exportId:req.exportId,rows:0,bytes:0,elapsedMs:0,rowsPerSec:0,bytesPerSec:0,phase:'preparing',totalRows:req.data?.rows.length,...p}});window.transferResolve=partial=>resolve({path:'D:/验收/'+req.fileName,fileName:req.fileName,rows:partial?2:req.data?.rows.length||100000,bytes:12345,truncated:false,canceled:!!partial,ms:1400,warnings:partial?['导出已停止，文件是部分结果']:[],destinationToken:'saved-native'});window.transferProgress({});});
 if(cmd==='db_export_cancel'){window.transferResolve(true);return;}
 if(cmd==='get_config')`)
 .replace("rows:[[1,'A','甲'],[2,'B','乙'],[3,'C','丙']]","rows:window.fixtureRows")
 .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');","")
 .replace("/src/main.tsx",entry);
assert.ok(!bootstrap.includes("/src/"));
test("database transfer production: themes, scopes, formats, workers, native save, progress and recovery",async()=>{
 await mkdir(artifacts,{recursive:true});
 const server=createServer(async(req,res)=>{try{const p=new URL(req.url,"http://local").pathname;
  if(p==="/"){res.setHeader("Content-Type","text/html");res.setHeader("Content-Security-Policy",csp);res.end(html.replace(/<style>/g,`<style nonce="${nonce}">`).replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/,'<script type="module" src="/__fixture.js"></script>'));}
  else if(p==="/__fixture.js"||p==="/__mocks.js"){res.setHeader("Content-Type","text/javascript");res.end(p==="/__fixture.js"?bootstrap:mocks);}
  else if(/^\/assets\/[\w.-]+$/.test(p)||p==="/icon.png"){res.setHeader("Content-Type",p.endsWith(".css")?"text/css":p.endsWith(".js")?"text/javascript":"application/octet-stream");res.end(await readFile(new URL(p.slice(1),dist)));}
  else {res.writeHead(404);res.end();}
 }catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,"127.0.0.1",r));const origin=`http://127.0.0.1:${server.address().port}`;
 let browser;const errors=[],measurements=[];
 try{
  browser=await chromium.launch({headless:true,executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"});
  for(const theme of ["light","dark"])for(const material of ["glass","classic"]){
   const context=await browser.newContext({viewport:{width:1280,height:840},permissions:["clipboard-read","clipboard-write"],reducedMotion:"reduce"});
   await context.addInitScript(({theme,material})=>{localStorage.setItem("theme",theme);localStorage.setItem("ncforge.ui-style",material);},{theme,material});
   const page=await context.newPage();page.setDefaultTimeout(15000);page.on("pageerror",e=>errors.push(e.message));
   const shot=name=>page.screenshot({path:fileURLToPath(new URL(`${theme}-${material}-${name}.png`,artifacts)),animations:"disabled"});
   await page.goto(origin,{waitUntil:"domcontentloaded"});await page.locator(".app-side").getByRole("button",{name:/^数据库/}).click();await page.locator("#dbx-conn-c").click();await page.locator("#dbx-cell-0-1").waitFor();
   await page.locator("#dbx-cell-0-1").click();await page.keyboard.press("Control+c");assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),"0012");
   await page.keyboard.press("Shift+ArrowDown");await page.keyboard.press("Shift+ArrowRight");await page.getByRole("button",{name:"复制为",exact:true}).click();await page.getByRole("menuitem",{name:"高级复制…",exact:true}).click();
   const copy=page.getByRole("dialog",{name:"高级复制",exact:true});await copy.getByLabel("输出格式",{exact:true}).selectOption("json");assert.match(await copy.locator(".dbx-transfer-summary").textContent(),/2 行 × 2 列/);await copy.getByRole("button",{name:"复制",exact:true}).click();
   await page.waitForFunction(async()=>{try{return JSON.parse(await navigator.clipboard.readText()).length===2;}catch{return false;}});
   const copied=JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()));assert.deepEqual(Object.keys(copied[0]),["CODE","NAME"]);assert.equal(copied[0].NAME,'中文\t引号"\n第二行');await shot("copy-json");
   await copy.getByRole("button",{name:"关闭",exact:true}).click();await copy.waitFor({state:"hidden"});
   await page.getByRole("button",{name:"导出",exact:true}).click();const dlg=page.getByRole("dialog",{name:"导出查询结果",exact:true});
   for(const [name,width,height]of [["wide",1280,840],["low",1024,540],["narrow",560,700],["scale150",683,512]]){
    await page.setViewportSize({width,height});const m=await dlg.evaluate(el=>{const r=el.getBoundingClientRect(),foot=el.querySelector(".dbx-transfer-foot").getBoundingClientRect(),scroll=el.querySelector(".dbx-transfer-scroll");return {width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,footBottom:foot.bottom,scrollHeight:scroll.clientHeight,overflow:document.documentElement.scrollWidth>innerWidth,background:getComputedStyle(el).backgroundColor};});
    measurements.push({theme,material,name,...m});assert.equal(m.overflow,false);assert.ok(m.left>=0&&m.right<=width+1&&m.top>=0&&m.bottom<=height+1);assert.ok(m.footBottom<=height&&m.scrollHeight>80);assert.ok(!m.background.includes("rgba"));await shot(name);
    if(width<740){await dlg.getByRole("button",{name:"查看预览",exact:true}).click();assert.equal(await dlg.evaluate(el=>document.activeElement===el.querySelector(".dbx-transfer-preview")),true);const bounds=await dlg.locator(".dbx-transfer-foot").boundingBox();assert.ok(bounds.y+bounds.height<=height+1);await dlg.locator(".dbx-transfer-scroll").evaluate(el=>{el.scrollTop=0;});}
   }
   await page.setViewportSize({width:1280,height:840});await dlg.getByLabel("输出格式",{exact:true}).selectOption("xlsx");
   await dlg.getByRole("button",{name:"选择位置",exact:true}).click();assert.match(await dlg.getByLabel("保存位置",{exact:true}).inputValue(),/D:\/验收\//);
   await page.evaluate(()=>{window.pickCancel=true;});await dlg.getByRole("button",{name:"选择位置",exact:true}).click();assert.match(await dlg.getByLabel("保存位置",{exact:true}).inputValue(),/D:\/验收\//);await page.evaluate(()=>{window.pickCancel=false;});
   await dlg.getByRole("button",{name:"保存文件",exact:true}).click();await page.waitForFunction(()=>!!window.transferRequest);assert.equal(await page.evaluate(()=>window.transferRequest.data.rows.length),2);assert.deepEqual(await page.evaluate(()=>window.transferRequest.options.columnIndices),[1,2]);
   await page.evaluate(()=>window.transferProgress({phase:"writing",rows:1,totalRows:2,processedBytes:1234,bytesKind:"buffered",elapsedMs:500,rowsPerSec:2}));await dlg.getByRole("progressbar").waitFor();assert.equal(await dlg.getByRole("progressbar").getAttribute("aria-valuenow"),"50");await shot("progress-known");
   await dlg.getByRole("button",{name:"后台运行",exact:true}).click();await dlg.waitFor({state:"hidden"});
   await page.getByRole("button",{name:"复制为",exact:true}).click();await page.getByRole("menuitem",{name:"高级复制…",exact:true}).click();await copy.waitFor();
   await page.evaluate(()=>window.transferProgress({phase:"finalizing",rows:2,totalRows:2}));assert.equal(await copy.getByRole("button",{name:"复制",exact:true}).isEnabled(),true);await copy.getByRole("button",{name:"复制",exact:true}).click();await copy.getByRole("status").filter({hasText:"已复制"}).waitFor();await copy.getByRole("button",{name:"关闭",exact:true}).click();await page.evaluate(()=>window.transferProgress({phase:"writing",rows:1,totalRows:2}));
   await page.getByRole("button",{name:"查看导出任务",exact:true}).click();await dlg.waitFor();
   await dlg.getByRole("button",{name:"停止导出",exact:true}).click();await dlg.getByText("部分结果，请勿作为全量数据使用",{exact:true}).waitFor();await shot("partial");await dlg.getByRole("button",{name:"所在文件夹",exact:true}).click();assert.equal(await page.evaluate(()=>window.dbCalls.filter(c=>c.cmd==='db_transfer_open').at(-1).args.token),"saved-native");
   await dlg.getByRole("button",{name:"再次导出",exact:true}).click();await dlg.getByLabel("输出格式",{exact:true}).selectOption("jsonl");await dlg.locator('input[type="radio"]').nth(3).check();await dlg.getByRole("button",{name:"保存文件",exact:true}).click();await page.waitForFunction(()=>window.transferRequest.format==='jsonl');assert.equal(await page.evaluate(()=>window.transferRequest.data),undefined);assert.ok(!(await page.evaluate(()=>window.transferRequest.sql)).includes("RN__"));
   await page.evaluate(()=>window.transferProgress({phase:"writing",rows:100,totalRows:undefined,bytes:4500,elapsedMs:500,rowsPerSec:200,bytesPerSec:9000}));assert.equal(await dlg.getByRole("progressbar").getAttribute("aria-valuenow"),null);await shot("progress-unknown");
   await page.evaluate(()=>window.transferReject(Error("写入文件失败：目录不可写")));await dlg.getByRole("alert").filter({hasText:"目录不可写"}).waitFor();await shot("error");await dlg.getByRole("button",{name:"修改设置并重试",exact:true}).click();assert.equal(await dlg.getByLabel("输出格式",{exact:true}).inputValue(),"jsonl");
   const failedId=await page.evaluate(()=>window.transferRequest.exportId);await dlg.getByRole("button",{name:"保存文件",exact:true}).click();await page.waitForFunction(id=>window.transferRequest.exportId!==id,failedId);await page.evaluate(()=>window.transferResolve(false));await dlg.getByText("文件已保存",{exact:true}).waitFor();await shot("success");await dlg.getByRole("button",{name:"关闭",exact:true}).click();
   // Large copy uses the production Worker under the exact installed CSP.
   await page.getByRole("button",{name:"复制为",exact:true}).click();await page.getByRole("menuitem",{name:"高级复制…",exact:true}).click();await copy.locator('input[type="radio"]').nth(1).check();await copy.locator('.dbx-transfer-column-settings > summary').click();await copy.getByRole("button",{name:"全部列",exact:true}).click();await copy.getByLabel("输出格式",{exact:true}).selectOption("json");await copy.getByRole("button",{name:"复制",exact:true}).click();await page.waitForFunction(async()=>{try{return JSON.parse(await navigator.clipboard.readText()).length===200;}catch{return false;}});await copy.getByRole("button",{name:"关闭",exact:true}).click();
   assert.deepEqual(await page.evaluate(()=>window.cspViolations),[]);await context.close();
  }
  assert.deepEqual(errors,[]);await writeFile(new URL("检查记录.json",artifacts),JSON.stringify({at:new Date().toISOString(),errors,measurements},null,2));
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
