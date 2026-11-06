// Production assets with packaged CSP; all database responses are local fixtures.
/* global window,document,getComputedStyle,innerWidth,localStorage,Event */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile,mkdir,writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dist=new URL("../dist/",import.meta.url);
const artifacts=new URL("../../docs/数据库视觉升级-2026-11-06/正式-production/",import.meta.url);
const html=await readFile(new URL("index.html",dist),"utf8");
const entry=html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
assert.ok(entry,"Build production frontend before running acceptance");
const source=await readFile(new URL("db-workbench-acceptance.test.mjs",import.meta.url),"utf8");
const raw=source.match(/const bootstrap=`([\s\S]*?)`;/)?.[1];
assert.ok(raw);
const mocks=await readFile(new URL("../node_modules/@tauri-apps/api/mocks.js",import.meta.url));
const config=JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json",import.meta.url),"utf8"));
const nonce="database-visual-acceptance";
const hashes=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>"'sha256-"+createHash("sha256").update(m[1]).digest("base64")+"'");
const csp=config.app.security.csp.replace(/script-src ([^;]+)/,(_,v)=>`script-src ${v} ${hashes.join(" ")}`).replace(/style-src ([^;]+)/,(_,v)=>`style-src ${v} 'nonce-${nonce}'`);
const bootstrap=raw.replace("/node_modules/@tauri-apps/api/mocks.js","/__tauri_mocks.js")
  .replace("const tx=()=>({autoCommit:false,statements:0,rows:0,since:0});","const tx=()=>window.fixtureTx || {autoCommit:false,statements:0,rows:0,since:0};")
  .replace("mockWindows('main');",`mockWindows('main');window.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));
   window.fixtureRows=Array.from({length:1200},(_,i)=>[i+1,'NC-'+String(i+1).padStart(4,'0'),'物料名称 '+(i+1)]);`)
  .replace("name:'NC测试库'","name:'NC 测试环境 · 数据核对工作台'")
  .replace("env:'test'","env:window.fixtureProd?'prod':'test'")
  .replace("if(cmd==='db_tx')","if(cmd==='db_tx' && args.action!=='status')window.fixtureTx=null; if(cmd==='db_tx')")
  .replace("if(cmd==='db_exec_bound')",`if(cmd==='db_slot_acquire')return {slot:'sql-1',tx:tx()};
   if(cmd==='db_cancel'){window.dbHold=false;window.dbReject?.(Error('ORA-01013: 用户请求取消操作'));return;}
   if((cmd==='db_exec' || cmd==='db_exec_bound') && window.dbHold)return new Promise((resolve,reject)=>{window.dbReject=reject;});
   if((cmd==='db_exec' || cmd==='db_exec_bound') && window.dbError)throw Error('ORA-00942: 表或视图不存在');
   if(cmd==='db_exec' || cmd==='db_exec_bound')`)
  .replace("kind:'rows',columns,rows:[[1,'A','甲'],[2,'B','乙'],[3,'C','丙']]","kind:'rows',columns:window.fixtureColumns || columns,rows:window.dbEmpty?[]:window.fixtureRows")
  .replace("ms:10,tx:tx()","ms:10,output:[],tx:tx()")
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", "localStorage.setItem('ncforge-db-result-height','310');")
  .replace("/src/main.tsx",entry);
assert.ok(!bootstrap.includes("/src/"),"Never fall back to dev modules in production acceptance");
const sqlBootstrap=bootstrap.replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}","{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'select * from TEST_TABLE;',results:[],output:[]}");

test("database visual upgrade: themes, materials, geometry, compact layouts and packaged CSP",async()=>{
  await mkdir(artifacts,{recursive:true});
  const server=createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,"http://localhost").pathname;
      if(path==="/" || path==="/table") {
        res.setHeader("Content-Type","text/html");res.setHeader("Content-Security-Policy",csp);
        res.end(html.replace(/<style>/g,`<style nonce="${nonce}">`).replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/,`<script type="module" src="/__fixture_${path==="/table"?"table":"sql"}.js"></script>`));
      } else if(path==="/__fixture_sql.js" || path==="/__fixture_table.js" || path==="/__tauri_mocks.js") {
        res.setHeader("Content-Type","text/javascript");res.end(path==="/__tauri_mocks.js"?mocks:path.includes("_sql")?sqlBootstrap:bootstrap);
      } else if(/^\/assets\/[\w.-]+$/.test(path)) {
        res.setHeader("Content-Type",path.endsWith(".css")?"text/css":path.endsWith(".js")?"text/javascript":"application/octet-stream");res.end(await readFile(new URL(path.slice(1),dist)));
      } else if(path==="/icon.png"){res.setHeader("Content-Type","image/png");res.end(await readFile(new URL("icon.png",dist)));}
      else {res.writeHead(404);res.end();}
    } catch {res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser,page;
  const errors=[],measurements=[];
  const shot=name=>page.screenshot({path:fileURLToPath(new URL(name+".png",artifacts)),animations:"disabled"});
  const runQuery=async()=>{await page.locator(".dbx-editor textarea").focus();await page.keyboard.press("Control+Enter");};
  try {
    browser=await chromium.launch({headless:true,channel:"msedge"});
    for(const mode of ["sql","table"]) {
      for(const theme of ["light","dark"]) for(const material of ["glass","classic"]) {
        const context=await browser.newContext({viewport:{width:1280,height:840},reducedMotion:"reduce"});
        await context.addInitScript(({theme,material})=>{window.fixtureProd=theme==="dark" && material==="glass";localStorage.setItem("theme",theme);localStorage.setItem("ncforge.ui-style",material);localStorage.setItem("ncforge.ui-density","comfortable");},{theme,material});
        page=await context.newPage();page.setDefaultTimeout(12000);page.on("pageerror",e=>errors.push(e.message));
        await page.goto(origin+(mode==="table"?"/table":"/"),{waitUntil:"domcontentloaded"});
        await page.locator(".app-side").getByRole("button",{name:/^数据库/}).click();
        await page.locator("#dbx-conn-c").click();
        if(mode==="sql")await runQuery();
        await page.locator("#dbx-cell-0-1").waitFor();
        assert.equal(await page.locator(".dbx-grow").first().evaluate(el=>el.getBoundingClientRect().height),30);
        assert.equal(await page.locator(".dbx-ghead").evaluate(el=>el.getBoundingClientRect().height),44);
        assert.ok(await page.locator(".dbx-grow").count()<70,"1200 rows remain virtualized");
        const contrast=await page.evaluate(()=>{
          const rgb=color=>color.match(/[\d.]+/g).slice(0,3).map(Number);
          const luminance=color=>rgb(color).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
          return [".dbx-gc:not(.rn)",".dbx-context-account",".dbx-context-status"].map(selector=>{const el=document.querySelector(selector);let parent=el;while(getComputedStyle(parent).backgroundColor==="rgba(0, 0, 0, 0)")parent=parent.parentElement;const fg=luminance(getComputedStyle(el).color),bg=luminance(getComputedStyle(parent).backgroundColor);return {selector,ratio:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)};});
        });
        contrast.forEach(c=>assert.ok(c.ratio>=4.5,`${theme} ${c.selector} contrast ${c.ratio}`));
        if(mode==="sql") {
          assert.equal(await page.locator(".dbx-connpick").count(),1);
          assert.equal(await page.locator(".dbx-context .dbx-connpick").count(),1);
          assert.ok(await page.locator(".dbx-scope").textContent());
        }
        for(const [label,width,height] of [["wide",1280,840],["low",1024,540],["narrow",560,700],["scale150",683,512]]) {
          await page.setViewportSize({width,height});
          if(width===560 && await page.locator(".wb-tree").isVisible())await page.getByRole("button",{name:"关闭资源侧栏",exact:true}).click();
          if(mode==="sql")await page.waitForFunction(()=>{const body=document.querySelector(".dbx-console-main").getBoundingClientRect();return document.querySelector(".dbx-res").getBoundingClientRect().bottom<=body.bottom+1;});
          if(mode==="table" && label!=="wide") {
            await page.getByRole("button",{name:"展开筛选",exact:true}).click();
            await page.getByRole("button",{name:"添加条件",exact:true}).click();
          }
          const m=await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,grid:document.querySelector(".dbx-grid").getBoundingClientRect().height,editor:document.querySelector(".dbx-editor")?.getBoundingClientRect().height,body:document.querySelector(".dbx-console-main")?.getBoundingClientRect().toJSON(),result:document.querySelector(".dbx-res")?.getBoundingClientRect().toJSON(),vars:{theme:document.documentElement.classList.contains("dark"),material:document.documentElement.dataset.uiStyle}}));
          measurements.push({mode,theme,material,label,...m,contrast});assert.equal(m.overflow,false,`${mode} ${theme} ${material} ${label} overflow`);assert.ok(m.grid>60,`${mode} ${label} readable grid`);
          if(mode==="sql"){assert.ok(m.editor>=140);assert.ok(m.result.bottom<=m.body.bottom+1);}
          else {
            assert.ok(await page.getByRole("button",{name:"查询",exact:true}).isVisible());
            if(label!=="wide")await page.getByRole("button",{name:"收起筛选",exact:true}).click();
          }
          if(label==="wide" || material==="glass")await shot(`${mode}-${theme}-${material}-${label}`);
        }
        // Density changes preserve the anchor and keep keyboard navigation aligned.
        await page.setViewportSize({width:1280,height:840});
        await page.locator(".dbx-grid").evaluate(el=>{el.scrollTop=1500;el.dispatchEvent(new Event("scroll",{bubbles:true}));});
        const anchor=await page.locator(".dbx-grow").first().getAttribute("aria-rowindex");
        await page.evaluate(()=>{document.documentElement.dataset.uiDensity="standard";window.dispatchEvent(new Event("ui-density-change"));});
        assert.equal(await page.locator(".dbx-grid").evaluate(el=>el.scrollTop),1300);
        assert.equal(await page.locator(".dbx-grow").first().getAttribute("aria-rowindex"),anchor);
        assert.equal(await page.locator(".dbx-grow").first().evaluate(el=>el.getBoundingClientRect().height),26);
        await page.evaluate(()=>{document.documentElement.dataset.uiDensity="comfortable";window.dispatchEvent(new Event("ui-density-change"));});
        const bottom=await page.locator(".dbx-grid").evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event("scroll",{bubbles:true}));return el.scrollTop;});
        await page.evaluate(()=>{document.documentElement.dataset.uiDensity="standard";window.dispatchEvent(new Event("ui-density-change"));});
        const compact=await page.locator(".dbx-grid").evaluate(el=>({top:el.scrollTop,max:el.scrollHeight-el.clientHeight}));
        assert.ok(Math.abs(compact.top-Math.min(bottom/30*26,compact.max))<=1,"Bottom density switch scales only once");
        await page.evaluate(()=>{document.documentElement.dataset.uiDensity="comfortable";window.dispatchEvent(new Event("ui-density-change"));});
        if(theme==="light" && material==="glass") {
          // Use one fixture per workflow to exercise additional views and recovery.
          await page.locator(".dbx-grid").evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event("scroll",{bubbles:true}));});
          if(mode==="sql") {
            await page.getByRole("button",{name:"执行历史",exact:true}).click();await page.getByLabel("搜索历史").fill("TEST_TABLE");await shot("sql-history");await page.getByRole("button",{name:"关闭历史",exact:true}).click();
            await page.getByRole("button",{name:"SQL 片段",exact:true}).click();await shot("sql-snippets");await page.getByRole("button",{name:"关闭片段",exact:true}).click();
            await page.evaluate(()=>{window.dbHold=true;});await runQuery();await page.getByRole("button",{name:"停止",exact:true}).waitFor();await shot("sql-waiting");await page.getByRole("button",{name:"停止",exact:true}).click();await page.getByText(/ORA-01013/).first().waitFor();
            await page.evaluate(()=>{window.dbError=true;});await runQuery();await page.locator(".dbx-err").filter({hasText:"ORA-00942"}).waitFor();await shot("sql-error");
            await page.evaluate(()=>{window.dbError=false;window.dbEmpty=true;});await runQuery();await page.getByText("没有匹配的行",{exact:false}).waitFor();await shot("sql-empty");
            await page.evaluate(()=>{window.dbEmpty=false;window.fixtureTx={autoCommit:false,statements:2,rows:3,since:Date.now()-120000};});await runQuery();await page.locator(".dbx-txbar").waitFor();await shot("sql-pending-transaction");await page.getByRole("button",{name:"回滚",exact:true}).click();await page.locator(".dbx-txbar").waitFor({state:"hidden"});
            await page.evaluate(()=>{window.fixtureColumns=Array.from({length:52},(_,i)=>({name:"FIELD_"+String(i).padStart(2,"0"),type:"VARCHAR2",precision:100,scale:0}));window.fixtureRows=Array.from({length:1200},(_,r)=>window.fixtureColumns.map((_,c)=>`值 ${r+1}-${c+1}`));});await runQuery();await page.locator('[role="grid"][aria-colcount="53"]').waitFor();await page.locator(".dbx-grid").evaluate(el=>{el.scrollLeft=el.scrollWidth;});await shot("sql-wide-columns");assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,"Wide columns scroll inside grid");
          } else {
            for(const sub of ["结构","索引","DDL"]) {await page.locator(".dbx-subtabs").getByRole("tab",{name:sub,exact:true}).click();await shot(`table-${sub}`);}
            await page.locator(".dbx-subtabs").getByRole("tab",{name:"数据",exact:true}).click();await page.locator("#dbx-cell-0-1").waitFor();
            await page.getByRole("button",{name:"结果列布局",exact:true}).click();await shot("columns-dialog");await page.keyboard.press("Escape");await page.getByRole("dialog",{name:"结果列布局"}).waitFor({state:"hidden"});
            if(!await page.getByRole("button",{name:"新建连接",exact:true}).isVisible()){await page.getByRole("button",{name:"工作台布局",exact:true}).click();await page.getByRole("menuitem",{name:"资源侧栏",exact:true}).click();}
            await page.getByRole("button",{name:"新建连接",exact:true}).click();const dlg=page.getByRole("dialog",{name:"数据库连接"});await dlg.waitFor();await page.setViewportSize({width:560,height:540});await shot("connection-dialog-low");
            const surface=await dlg.evaluate(el=>{const s=getComputedStyle(el);return {background:s.backgroundColor,blur:s.backdropFilter};});assert.ok(!surface.background.startsWith("rgba("),"Glass form keeps opaque reading surface");assert.equal(surface.blur,"none");
            const footer=await dlg.locator(".ft").boundingBox();assert.ok(footer.y+footer.height<540,"Connection footer stays visible");
            for(let i=0;i<16;i++){await page.keyboard.press("Tab");assert.equal(await dlg.evaluate(el=>el.contains(document.activeElement)),true,"Dialog traps keyboard focus");}
            await page.keyboard.press("Escape");await dlg.waitFor({state:"hidden"});
            assert.equal(await page.evaluate(()=>document.activeElement.getAttribute("aria-label")),"新建连接","Dialog restores trigger focus");
            await page.setViewportSize({width:1280,height:840});await page.locator("#dbx-conn-c").click({button:"right"});await page.getByRole("menuitem",{name:"数据字典",exact:true}).click();await page.locator(".md-page").waitFor();await shot("dictionary-page");
          }
        }
        assert.deepEqual(await page.evaluate(()=>window.cspViolations),[],`${mode} ${theme} ${material} CSP`);
        await context.close();
      }
    }
    assert.deepEqual(errors,[]);await writeFile(new URL("measurements.json",artifacts),JSON.stringify(measurements,null,2));
  } catch(error) {
    await writeFile(new URL("failure.json",artifacts),JSON.stringify({error:String(error),errors,measurements,text:await page?.locator("body").innerText().catch(()=>"")},null,2));
    await shot("failure").catch(()=>{});throw error;
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
