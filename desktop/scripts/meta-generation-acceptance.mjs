/** 真实生成工作台与编辑器的隔离验收；业务 IPC 使用内存夹具，落盘契约另由 Rust 测试验证。 */
/* global window, document, innerWidth, innerHeight, performance, requestAnimationFrame, getComputedStyle */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium } from "playwright";

const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cacheBase = join(desktop, "node_modules/.cache");
await mkdir(join(cacheBase, "meta-generation-acceptance"), { recursive: true });
const cache = await realpath(join(cacheBase, "meta-generation-acceptance"));
const output = join(cache, "dist");
assert.ok(!relative(cache, output).startsWith(".."));
const artifacts = resolve(desktop, "../docs/元数据生成工作台实施验收-2026-11-06");
await mkdir(artifacts, { recursive: true });
const source = (path) => JSON.stringify(join(desktop, "src", path).replaceAll("\\", "/"));
await writeFile(join(cache, "style.css"), "@import " + source("index.css") + ";\n@source " + JSON.stringify(join(desktop, "src").replaceAll("\\", "/")) + ";\n");
await writeFile(join(cache, "index.html"), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="height:100dvh"></div><script type="module" src="./entry.tsx"></script></body></html>\n');
await writeFile(join(cache, "entry.tsx"), [
  "import React from 'react'; import {createRoot} from 'react-dom/client'; import {mockIPC} from '@tauri-apps/api/mocks';",
  "import {MetaTab} from " + source("components/meta/MetaTab.tsx") + ";",
  "import {WorkbenchFrame} from " + source("components/workspace/WorkbenchFrame.tsx") + ";",
  "import {ToastProvider} from " + source("components/ui/toast.tsx") + ";",
  "import {metaEntry,metaDetail,metaEntity,metaAttr} from " + source("test/metaFixtures.ts") + ";",
  "import {metaGenerationPlan} from " + source("test/metaGenerationFixture.ts") + ";",
  "import {generationFixture,generationResult} from " + source("test/generationWorkbenchFixture.ts") + ";",
  "import {setSession} from " + source("lib/workspaceSession.ts") + ";",
  "import {applyTheme} from " + source("lib/theme.ts") + ";",
  "import './style.css';",
  ...["workspace.css", "workbench-layout.css", "interaction-refinements.css", "appearance.css", "glass-material.css", "interaction-density.css"].map((path) => "import " + source(path) + ";"),
  "const clone=v=>JSON.parse(JSON.stringify(v)); let kind='normal',calls=[],written=new Set(),failId=null,ledgerError=null,holdWrite=false,writeDone=null,holdSql=false,sqlDone=null,targetVersion=0;",
  "window.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push(e.effectiveDirective));",
  "const names=['DemoHeadVO','DemoBodyVO','DemoAggVO','BillStatus','DemoQueryVO','DemoTest'];",
  "function plan(profile=metaGenerationPlan.profile){",
  " const java=Array.from({length:kind==='large'?1000:6},(_,i)=>({...metaGenerationPlan.artifacts[0],id:'vo'+i,name:(names[i]||'Entity'+i+'VO')+'.java',encoding:'GBK',eol:'CRLF',",
  "  pathHint:profile.publicSrcRoot+'/nc/vo/demo/'+(names[i]||'Entity'+i+'VO')+'.java',sha256:'generated-'+i,sourceRefs:['head'],dependsOn:i===2?['vo0','vo1']:[],",
  "  text:'package '+(profile.basePackage?profile.basePackage+'.demo':'nc.vo.demo')+';\\n\\npublic class '+(names[i]||'Entity'+i+'VO')+' {\\n'+Array.from({length:50},(_,n)=>'    private String field'+n+'; // 业务字段 '+n).join('\\n')+'\\n}\\n'}));",
  " const db={...metaGenerationPlan.artifacts[0],id:'ddl',name:'demo.oracle.sql',pathHint:'db/demo.oracle.sql',family:'db',kind:'ddl',sourceRefs:['head','body'],text:'CREATE TABLE demo_h (pk_demo CHAR(20));\\nCREATE TABLE demo_b (pk_demo CHAR(20));'};",
  " const registry={...metaGenerationPlan.artifacts[0],id:'registry',name:'registry.json',pathHint:'meta/registry.json',family:'meta',kind:'registry',sourceRefs:[],text:'{\"component\":\"demo\",\"status\":\"suggestion\"}'};",
  " return {...metaGenerationPlan,profile,artifacts:kind==='large'?java:[...java,...(profile.options.generateDdl?[db]:[]),registry]};}",
  "function statuses(){return Object.fromEntries(plan().artifacts.map((a,i)=>[a.id,written.has(a.id)?'unchanged':i===0?'modified':i===1?'outdated':i===2?'unchanged':i===3?'conflict':'new']));}",
  "function checked(description,root){ const p=plan();const check=generationFixture(root,p,statuses()).check;check.snapshot={...description,root,targets:description.targets.map(t=>({...t,resolvedPath:root+'\\\\'+t.path.replaceAll('/','\\\\'),targetSha256:statuses()[t.id]==='unchanged'?t.generatedSha256:statuses()[t.id]!=='new'?'original-'+targetVersion:null}))};",
  " check.items.push({id:'orphan:old',path:'src/public/nc/vo/demo/UnusedVO.java',family:'java',status:'orphan',detail:'旧清单产物，保留文件'});",
  " if(root.includes('invalid'))return {...check,snapshot:null,error:'输出目录不可用，请选择工作区内的目录'};return check;}",
  "const detail=metaDetail('demo',{issues:[],entities:[metaEntity('head',Array.from({length:24},(_,i)=>metaAttr(i===0?'billcode':'field'+i)),{displayName:'费用报销单'}),metaEntity('body',[metaAttr('item')],{displayName:'费用明细'})]});",
  "function perform(args){const p=plan(args.profile),s=statuses();const items=p.artifacts.filter(a=>args.selected.includes(a.id)).map(a=>{const protectedFile=['modified','conflict'].includes(s[a.id]);let status=a.id===failId?'failed':s[a.id]==='unchanged'||protectedFile&&!args.overrides.includes(a.id)?'skipped':s[a.id]==='new'?'written':'replaced';if(['written','replaced'].includes(status))written.add(a.id);return{relPath:a.pathHint,kind:a.kind,status,detail:status==='failed'?'模拟文件占用':status==='skipped'?'已保留或已一致':status==='written'?'已创建':'已更新并备份'};});",
  " return {...generationResult(args.root,p),items,written:items.filter(i=>['written','replaced'].includes(i.status)).length,skipped:items.filter(i=>i.status==='skipped').length,failed:items.filter(i=>i.status==='failed').length,backups:Object.fromEntries(items.filter(i=>i.status==='replaced').map(i=>[i.relPath,'D:/config/bmf_backup/gen/'+i.relPath])),manifest:ledgerError?'':'D:/config/generation/demo.json',manifestError:ledgerError};}",
  "mockIPC(async(cmd,args={})=>{calls.push({cmd,args:clone(args)});",
  " if(cmd==='plugin:event|listen')return 0;if(cmd==='plugin:event|unlisten')return null;",
  " if(cmd==='bmf_index_scan')return {entries:[metaEntry('demo',{displayName:'费用报销单组件'})],roots:[],warnings:[],cached:1,elapsedMs:1};",
  " if(cmd==='bmf_doc_detail')return clone(detail);if(cmd==='bmf_validate')return [];",
  " if(cmd==='bmf_gen_preview'){const p=plan(args.profile||undefined),f=generationFixture(args.root,p,statuses());f.check=checked(f.description,args.root);return f;}",
  " if(cmd==='bmf_gen_check')return checked(args.description,args.root);",
  " if(cmd==='bmf_gen_target'){const a=plan().artifacts.find(a=>a.id===args.id);return a.text.replace('private String field0;','private String handwritten'+targetVersion+';');}",
  " if(cmd==='bmf_gen_apply'){if(holdWrite)return new Promise(resolve=>{writeDone=()=>resolve(perform(args));});return perform(args);}",
  " if(cmd==='bmf_gen_reveal')return null;",
  " if(cmd==='db_conn_list')return [{id:'test',name:'隔离测试连接',env:'test',source:'manual',autoCommit:true}];",
  " if(cmd==='db_exec'){if(holdSql)return new Promise(resolve=>{sqlDone=()=>resolve({kind:'update',updateCount:0,ms:2});});return {kind:'update',updateCount:0,ms:2};}",
  " throw Error('未模拟 IPC '+cmd);});",
  "Object.assign(window,{generationAcceptance:{calls:()=>calls,setKind:k=>{kind=k;written.clear();},theme:applyTheme,externalTarget:()=>{targetVersion++;},failure:(id,error)=>{failId=id;ledgerError=error;},holdWrite:()=>{holdWrite=true;},finishWrite:()=>{holdWrite=false;writeDone();},holdSql:()=>{holdSql=true;},finishSql:()=>{holdSql=false;sqlDone();},models:async()=>{const m=await import(" + source("lib/monacoSetup.ts") + ");return m.monaco.editor.getModels().length;},unmount:()=>root.render(null)}});",
  "setSession({root:'D:/workspace',panelOpen:false});const root=createRoot(document.getElementById('root'));",
  "root.render(<ToastProvider><div className='app-shell h-screen overflow-hidden'><WorkbenchFrame activeTool='meta' tree={null} tabs={null} editor={null} output={null} status={null} tool={<MetaTab/>}/></div></ToastProvider>);"
].join("\n"));

if (!process.argv.includes("--reuse")) {
  await build({ configFile: join(desktop, "vite.config.ts"), root: cache,
    build: { outDir: output, emptyOutDir: true, rollupOptions: { input: join(cache, "index.html") } } });
}
const config = JSON.parse(await readFile(join(desktop, "src-tauri/tauri.conf.json"), "utf8"));
const html = await readFile(join(output, "index.html"), "utf8");
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/") { res.setHeader("Content-Type", "text/html"); res.setHeader("Content-Security-Policy", config.app.security.csp); res.end(html); }
    else if (/^\/assets\/[\w.-]+$/.test(path)) { res.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript"); res.end(await readFile(join(output, path.slice(1)))); }
    else { res.writeHead(404); res.end(); }
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const result = { at: new Date().toISOString(), source: "production MetaTab + MetaGenerate + WorkbenchFrame + Monaco, memory IPC, packaged CSP",
  windows: [], modalWindows: [], functional: [], performance: {}, models: [], errors: [], cspViolations: [] };
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--disable-gpu"] });
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "networkidle" });
    await page.evaluate((theme) => window.generationAcceptance.theme(theme), theme);
    const resource = page.getByRole("button", { name: "打开元数据资源", exact: true });
    if (await resource.isVisible()) await resource.click();
    await page.locator(".meta-entry").filter({ hasText: "费用报销单组件" }).click();
    const enter = async () => { await page.getByRole("button", { name: "工具", exact: true }).click(); await page.getByRole("menuitem", { name: /生成中心/ }).click(); await page.locator(".gen-files").waitFor(); };
    await enter();
    await page.locator(".gen-monaco .view-lines").waitFor();
    const workbench = page.locator(".gen-workbench");
    const search = () => page.getByRole("textbox", { name: "搜索生成产物", exact: true });
    const update = () => page.locator(".gen-workbench-head").getByRole("button", { name: "更新产物", exact: true });
    const commandCount = (name) => page.evaluate((name) => window.generationAcceptance.calls().filter(c => c.cmd === name).length, name);
    const shot = (name) => page.screenshot({ path: join(artifacts, name + "-" + (theme === "dark" ? "深色" : "浅色") + "-2026-11-06.png"), animations: "disabled" });
    const modalFit = async (modal,name) => {
      for(const [width,height] of [[1024,480],[683,512]]){
        await page.setViewportSize({width,height});const box=await modal.boundingBox();
        assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1);
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1||document.documentElement.scrollHeight>innerHeight+1);
        assert.equal(overflow,false);result.modalWindows.push({theme,name,width,height,...box});
        await shot(name+"-"+width+"x"+height);
      }
      await page.setViewportSize({width:1366,height:768});
    };
    if (!process.argv.includes("--functions-only")) {
      for (const [width, height] of [[1920,1080],[1366,768],[1280,720],[1024,640],[1024,480],[819,614],[683,512],[560,700]]) {
        await page.setViewportSize({ width, height });
        const m = await workbench.evaluate(el => {
          const r=el.getBoundingClientRect(),f=el.querySelector(".gen-workbench-foot").getBoundingClientRect(),e=el.querySelector(".gen-monaco").getBoundingClientRect();
          return { mode:el.dataset.layout, workspaceWidth:r.width, editorHeight:e.height, footerBottom:f.bottom,
            overflowX:document.documentElement.scrollWidth>innerWidth+1,overflowY:document.documentElement.scrollHeight>innerHeight+1,
            background:getComputedStyle(el).backgroundColor,editorBackground:getComputedStyle(el.querySelector(".monaco-editor")).backgroundColor };
        });
        assert.equal(m.overflowX,false);assert.equal(m.overflowY,false);assert.ok(m.footerBottom<=height+1);assert.ok(m.editorHeight>=90);
        const refresh=page.locator('.gen-workbench-head > button[title="重新读取 BMF 并更新产物"] svg');
        assert.equal(await refresh.isVisible(),true);
        result.windows.push({ theme,width,height,...m });await shot("工作台-" + width + "x" + height);
        if(width===1024||width===683){await page.locator(".gen-workbench-head").getByRole("button",{name:"配置",exact:true}).click();
          const modal=page.getByRole("dialog",{name:"生成配置",exact:true}),box=await modal.boundingBox();
          assert.ok(box.y>=0&&box.y+box.height<=height+1);await shot("配置抽屉-"+width+"x"+height);await modal.getByRole("button",{name:"关闭生成配置",exact:true}).click();}
      }
    }
    await page.setViewportSize({width:1366,height:768});
    assert.equal(await commandCount("bmf_gen_preview"),1);
    await search().fill("Head");await page.locator('[data-file-id="vo0"]').waitFor();assert.equal(await commandCount("bmf_gen_preview"),1);
    await search().fill("");await page.getByRole("button",{name:"全选",exact:true}).click();await page.getByRole("button",{name:"全不选",exact:true}).click();
    assert.equal(await page.getByRole("button",{name:"检查并确认写入",exact:true}).isDisabled(),true);assert.equal(await commandCount("bmf_gen_apply"),0);
    await page.getByRole("button",{name:"全选",exact:true}).click();
    const packageInput=page.getByRole("textbox",{name:"生成包根",exact:true});await packageInput.fill("nc");await packageInput.fill("nc.vo");
    assert.equal(await commandCount("bmf_gen_preview"),1);assert.equal(await packageInput.isEnabled(),true);await update().click();
    await page.waitForFunction(()=>!document.querySelector(".gen-workbench").getAttribute("aria-busy")?.includes("true"));
    assert.equal(await commandCount("bmf_gen_preview"),2);
    const checks=await commandCount("bmf_gen_check"),directory=page.getByLabel("输出目录",{exact:true});
    await directory.fill("D:/workspace/first");await directory.fill("D:/workspace/final");
    await page.waitForFunction(()=>document.querySelector(".gen-config-fields [role=status]")?.textContent==="目录已检查");
    assert.equal(await commandCount("bmf_gen_check"),checks+1);
    await page.locator('[data-file-id="vo0"]').click();await page.getByRole("button",{name:"与现有文件比较",exact:true}).click();
    const override=page.getByRole("checkbox",{name:"覆盖这个文件并备份",exact:true});
    await page.waitForFunction(()=>{const c=[...document.querySelectorAll(".gen-protection input")][0];return c&&!c.disabled;});
    assert.equal(await page.locator(".gen-monaco .monaco-diff-editor").count(),1);assert.equal(await page.evaluate(()=>window.generationAcceptance.models()),2);
    await override.check();await page.evaluate(()=>window.generationAcceptance.externalTarget());
    await page.getByRole("button",{name:"重新检查",exact:true}).click();await page.waitForFunction(()=>{const c=document.querySelector(".gen-protection input");return c&&!c.checked&&!c.disabled;});
    await override.check();await shot("逐文件差异与覆盖");
    await page.evaluate(()=>window.generationAcceptance.failure("vo4","模拟清单不可写"));
    await page.evaluate(()=>window.generationAcceptance.holdWrite());await page.getByRole("button",{name:"检查并确认写入",exact:true}).click();
    const review=page.getByRole("dialog",{name:"确认写入生成产物",exact:true});await modalFit(review,"写入确认");
    await review.getByRole("button",{name:"确认写入",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector(".gen-workbench").getAttribute("aria-busy")==="true");
    await page.keyboard.press("Escape");assert.equal(await review.isVisible(),true);assert.equal(await review.getByRole("button",{name:"关闭写入确认",exact:true}).isDisabled(),true);
    await page.evaluate(()=>window.generationAcceptance.finishWrite());
    const outcome=page.getByRole("dialog",{name:"生成写入结果",exact:true});await outcome.waitFor();assert.ok((await outcome.textContent()).includes("模拟文件占用"));
    assert.ok((await outcome.textContent()).includes("模拟清单不可写"));assert.ok((await outcome.textContent()).includes("已更新"));await modalFit(outcome,"写入结果");await shot("部分失败保留结果");
    await outcome.getByRole("button",{name:"完成",exact:true}).click();await page.evaluate(()=>window.generationAcceptance.failure(null,null));await update().click();
    await page.waitForFunction(()=>document.querySelector(".gen-config-fields [role=status]")?.textContent==="目录已检查");
    await page.getByRole("button",{name:"检查并确认写入",exact:true}).click();await review.getByRole("button",{name:"确认写入",exact:true}).click();await outcome.waitFor();
    assert.ok(!(await outcome.textContent()).includes("清单保存失败"));await outcome.getByRole("button",{name:"定位清单",exact:true}).click();
    assert.ok((await page.evaluate(()=>window.generationAcceptance.calls().filter(c=>c.cmd==="bmf_gen_reveal").at(-1).args.path)).includes("generation/demo.json"));
    await outcome.getByRole("button",{name:"完成",exact:true}).click();await search().fill(".sql");await page.locator('[data-file-id="ddl"]').click();
    assert.equal(await commandCount("db_conn_list"),0);await page.getByRole("button",{name:"测试库执行…",exact:true}).click();
    const sql=page.getByRole("dialog",{name:"生成脚本测试库执行",exact:true});await sql.getByLabel("选择执行连接",{exact:true}).selectOption("test");
    await sql.getByRole("checkbox").check();await sql.getByRole("textbox",{name:"输入组件名确认 DDL 执行",exact:true}).fill("demo");
    await page.evaluate(()=>window.generationAcceptance.holdSql());await sql.getByRole("button",{name:"执行 DDL",exact:true}).click();
    assert.equal(await sql.getByRole("button",{name:"关闭脚本执行",exact:true}).isDisabled(),true);await page.keyboard.press("Escape");assert.equal(await sql.isVisible(),true);
    await modalFit(sql,"脚本执行中");
    assert.equal(await commandCount("db_exec"),1);await page.evaluate(()=>window.generationAcceptance.finishSql());await sql.getByText(/全部语句执行成功/).waitFor();
    assert.equal(await commandCount("db_exec"),2);await shot("独立脚本执行");await sql.getByRole("button",{name:"关闭脚本执行",exact:true}).click();
    await search().fill("");await page.locator('[data-file-id="vo0"]').click();await page.getByRole("button",{name:"来源与依赖",exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector(".gen-monaco"));assert.equal(await page.evaluate(()=>window.generationAcceptance.models()),0);
    await page.getByRole("button",{name:"费用报销单",exact:true}).click();await page.locator(".meta-field-table").waitFor();assert.equal(await page.evaluate(()=>window.generationAcceptance.models()),0);
    await enter();assert.equal(await page.locator('[data-file-id="vo0"]').getAttribute("aria-pressed"),"true");
    await page.getByRole("button",{name:"生成内容",exact:true}).click();await page.locator(".gen-monaco .view-lines").waitFor();
    await page.evaluate(()=>window.generationAcceptance.setKind("large"));await update().click();
    await page.waitForFunction(()=>document.querySelector(".gen-files-head")?.textContent?.includes("1000"));
    await page.waitForFunction(()=>document.querySelector(".gen-monaco .view-lines")?.textContent?.includes("DemoHeadVO"));
    const planCalls=await commandCount("bmf_gen_preview");
    const perf=await page.evaluate(async()=>{
      const clickMs=[];for(let i=0;i<30;i++){const id="vo"+i%5,b=document.querySelector('[data-file-id="'+id+'"]'),start=performance.now();b.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));if(b.getAttribute("aria-pressed")!=="true")throw Error("文件切换未呈现");clickMs.push(performance.now()-start);}
      const scroll=document.querySelector(".gen-file-scroll");scroll.scrollTop=scroll.scrollHeight;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      return {clickMs,renderedRows:scroll.querySelectorAll("[data-file-id]").length,lastVisible:!!scroll.querySelector('[data-file-id="vo999"]')};
    });
    assert.ok(perf.renderedRows<40);assert.equal(perf.lastVisible,true);assert.equal(await commandCount("bmf_gen_preview"),planCalls);
    result.performance[theme]={...perf,clickP95Ms:p95(perf.clickMs),targetP95Ms:100,meetsTarget:p95(perf.clickMs)<=100};
    assert.ok(p95(perf.clickMs)<=100,"1000 项清单的文件切换 P95 需小于 100ms");
    await shot("千项清单可见区");
    const modelCount=await page.evaluate(()=>window.generationAcceptance.models());assert.equal(modelCount,1);
    result.models.push({theme,after30FileSwitches:modelCount});
    await page.getByRole("button",{name:"返回元数据",exact:true}).click();await page.locator(".meta-field-table").waitFor();
    assert.equal(await page.evaluate(()=>window.generationAcceptance.models()),0);
    result.cspViolations.push(...await page.evaluate(()=>window.cspViolations));
    result.functional.push({theme,checks:["空选择不写入","配置草稿统一更新","目录防抖","真实差异与旧授权撤销","写入确认锁定","部分失败与清单错误保留","重试与定位清单","独立 SQL 顺序执行与关闭保护","来源定位与会话恢复","千项虚拟清单","单编辑器模型释放"]});
    await page.close();
  }
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.cspViolations,[]);
  result.passed=true;console.log(JSON.stringify({passed:true,windows:result.windows.length,performance:result.performance,models:result.models},null,2));
} finally {
  await writeFile(join(artifacts,"真实组件联调与性能-2026-11-06.json"),JSON.stringify(result,null,2)+"\n");
  await browser?.close();await new Promise(done=>server.close(done));
}
