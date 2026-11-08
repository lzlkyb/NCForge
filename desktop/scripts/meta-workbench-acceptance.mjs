/** 真实元数据组件的隔离验收：生产构建，内存 IPC，顺序执行窗口与性能场景。 */
/* global window, document, innerWidth, innerHeight, performance, requestAnimationFrame, KeyboardEvent, PointerEvent */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { chromium } from "playwright";

const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cacheBase = join(desktop, "node_modules/.cache");
await mkdir(join(cacheBase,"meta-workbench-acceptance"), {recursive:true});
// 隔离快照复用 node_modules 的 junction；Vite 的入口与 root 必须使用同一物理路径。
const cache = await realpath(join(cacheBase,"meta-workbench-acceptance"));
const output = join(cache, "dist");
const artifacts = process.env.META_ACCEPTANCE_ARTIFACTS ? resolve(process.env.META_ACCEPTANCE_ARTIFACTS)
  : resolve(desktop, "../docs/全局内容空间优化验收-2026-11-07/元数据");
assert.ok(!relative(await realpath(cacheBase), output).startsWith(".."));
await mkdir(cache, { recursive: true });
await mkdir(artifacts, { recursive: true });
const source = (path) => JSON.stringify(join(desktop, "src", path).replaceAll("\\", "/"));
await writeFile(join(cache, "style.css"), `@import ${source("index.css")};\n@source ${JSON.stringify(join(desktop,"src").replaceAll("\\","/"))};\n`);
await writeFile(join(cache, "index.html"), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="height:100dvh"></div><script type="module" src="./entry.tsx"></script></body></html>\n');
await writeFile(join(cache, "entry.tsx"), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { MetaTab } from ${source("components/meta/MetaTab.tsx")};
import { WorkbenchFrame } from ${source("components/workspace/WorkbenchFrame.tsx")};
import { ToastProvider } from ${source("components/ui/toast.tsx")};
import { metaAttr, metaEntity, metaEntry, metaDetail } from ${source("test/metaFixtures.ts")};
import { BMF_BASE_TYPES } from ${source("lib/bmfTypes.ts")};
import { setSession } from ${source("lib/workspaceSession.ts")};
import './style.css';
import ${source("workspace.css")};
import ${source("workbench-layout.css")};
import ${source("interaction-refinements.css")};
import ${source("appearance.css")};
import ${source("glass-material.css")};
import ${source("interaction-density.css")};
import ${source("content-first.css")};

const clone = (v) => JSON.parse(JSON.stringify(v));
const type = BMF_BASE_TYPES[0];
const field = (id, name=id, overrides={}) => metaAttr(id,name,{dataType:type.id,...overrides});
const itf = { id:'itf',name:'IBill',displayName:'单据业务接口',fullClass:'nc.vo.demo.IBill',external:false,sourcePath:'',definitionSha:'',
 attrs:[{id:'ia-code',name:'code',displayName:'编码',typeName:'String',dataType:type.id,style:'SINGLE',dbType:'varchar',sequence:1}] };
let disks=new Map(), calls=[], failSave=null, generation=0;
function sample(kind) {
 const count=kind==='large'?500:kind==='drag'?50:3;
 const entities=Array.from({length:count},(_,i)=>metaEntity(i===0?'head':i===1?'body':'entity'+i,
   Array.from({length:i===0?(kind==='large'?1000:24):4},(_,j)=>field(i===0?(j===0?'billcode':'field'+j):'e'+i+'f'+j,j===0?'code':'field'+j,
   {displayName:j===0?'单据编码':j===1?'业务日期':j===2?'业务金额':'业务字段 '+j})),
   {name:i===0?'BillH':i===1?'BillB':'Entity'+i,displayName:i===0?'费用报销单':i===1?'费用明细':'业务实体 '+i,
    table:i===0?'demo_bill_h':i===1?'demo_bill_b':'demo_entity_'+i,
    ...(i===0?{interfaceIds:['itf'],mappings:[{interfaceId:'itf',interfaceAttrId:'ia-code',entityId:'head',attrId:'billcode',attrPath:'',attrPathId:''}],
    accessor:'nc.bs.demo.BillAccessor',accessorConfig:{name:'billAccessor',displayName:'单据访问器',fullClass:'nc.bs.demo.BillAccessor',properties:[{name:'pkField',displayName:'主键字段',value:'pk_bill',sequence:1}]}}:{})}));
 const relationCount=kind==='drag'||kind==='large'?100:2;
 const relations=Array.from({length:relationCount},(_,i)=>({id:'rel'+i,kind:'AggregationRelation',name:i===0?'主子聚合':'关联 '+i,
  source:entities[i%entities.length].id,target:entities[(i+1)%entities.length].id,
  srcAttrId:entities[i%entities.length].attrs[0].id,targetAttrId:entities[(i+1)%entities.length].attrs[0].id,
  sourceConstraint:'1',targetConstraint:'0..n'}));
 return metaDetail('demo',{entities,relations,issues:[],interfaces:[clone(itf)],references:[],dependencies:[],
  enums:[{id:'status',name:'BillStatus',displayName:'单据状态',typeName:'Integer',dataType:'',fullClass:'nc.vo.demo.BillStatus',raw:'',
  items:[{id:'draft',name:'draft',value:'0',display:'草稿'},{id:'approved',name:'approved',value:'1',display:'已审批'}]}]});
}
function project(path,ops,expectedSha) {
 const base=disks.get(path);
 if(!base||base.sha256!==expectedSha) throw new Error('文件已被外部修改 SHA-256');
 const result=clone(base);
 for(const op of ops) {
  const entity=result.entities.find(e=>e.id===op.entity);
  if(op.op==='setAttr') {
   const object=result.entities.flatMap(e=>[e,...e.attrs]).find(a=>a.id===op.id);
   if(!object) throw new Error('对象不存在');
   const key={fieldName:'field',isNullable:'nullable',dataTypeStyle:'style',dbtype:'dbType'}[op.name]||op.name;
   object[key]=['isNullable','isKey'].includes(op.name)?op.value==='true':['length','precision'].includes(op.name)?(op.value?Number(op.value):null):op.value;
  } else if(op.op==='addAttribute') {
   entity.attrs.push(field(op.id,op.name,{displayName:op.displayName||op.name,dataType:op.dataType,typeName:op.typeName,dbType:op.dbType,length:op.length,nullable:op.nullable}));
  } else if(op.op==='setMapping') {
   entity.mappings=entity.mappings.filter(m=>m.interfaceId!==op.interfaceId||m.interfaceAttrId!==op.interfaceAttrId);
   if(op.attrId) entity.mappings.push({interfaceId:op.interfaceId,interfaceAttrId:op.interfaceAttrId,entityId:entity.id,attrId:op.attrId,attrPath:'',attrPathId:''});
  } else if(op.op==='setAccessorProperty') {
   const item=entity.accessorConfig.properties.find(p=>p.name===op.name); if(item)item.value=op.value;
  } else throw new Error('场景未模拟操作 '+op.op);
 }
 result.sha256=ops.length?'draft-'+JSON.stringify(ops):base.sha256;
 return {detail:result,ops:clone(ops),baseSha:base.sha256,diff:ops.length?'--- demo.bmf\\n+++ demo.bmf\\n-原值\\n+草稿修改':'',blockingIssues:[]};
}
mockIPC(async (cmd,args={})=>{
 calls.push({cmd,args:clone(args)});
 if(cmd==='bmf_index_scan')return{entries:[metaEntry(),...Array.from({length:1499},(_,i)=>metaEntry('component'+i,{displayName:'组件 '+i}))],roots:[],warnings:[],cached:0,elapsedMs:2};
 if(cmd==='bmf_doc_detail')return clone(disks.get(args.path)||metaDetail(args.path.split('/').pop().replace('.bmf',''),{issues:[]}));
 if(cmd==='bmf_validate')return[];
 if(cmd==='bmf_draft_preview')return project(args.path,args.ops,args.expectedSha);
 if(cmd==='bmf_edit_save'){
  if(failSave)throw new Error(failSave);
  const p=project(args.path,args.ops,args.expectedSha);disks.set(args.path,p.detail);
  return{path:args.path,backup:'D:/backup/demo.bmf',shaBefore:args.expectedSha,shaAfter:p.detail.sha256,diff:p.diff,changed:true};
 }
 if(cmd==='bmf_node_source'){
  if(disks.get(args.path)?.sha256!==args.expectedSha)throw new Error('文件已被外部修改 SHA-256');
  return '<attribute id="'+args.id+'" />';
 }
 if(cmd==='plugin:event|listen')return 0;
 if(cmd==='plugin:event|unlisten')return null;
 throw new Error('场景未模拟 IPC '+cmd);
});
setSession({root:'D:/workspace',panelOpen:false});
const root=createRoot(document.getElementById('root'));
function reset(kind='normal'){
 const alternate=sample('normal');alternate.path=metaEntry('component0').path;
 alternate.component={...alternate.component,id:'component0',name:'component0',displayName:'component0组件'};
 alternate.entities[0].attrs[0].displayName='热切正文-B';
 disks=new Map([[metaEntry().path,sample(kind)],[alternate.path,alternate]]);calls=[];failSave=null;generation++;
 root.render(<ToastProvider><div className="app-shell h-screen overflow-hidden"><WorkbenchFrame activeTool="meta" tree={null} tabs={null} editor={null} output={null} status={null} tool={<MetaTab key={generation}/>} /></div></ToastProvider>);
}
Object.assign(window,{metaAcceptance:{reset,calls:()=>calls,fail:(msg)=>{failSave=msg;},external:()=>{const d=disks.get(metaEntry().path);d.sha256='externally-changed';d.entities[0].attrs[0].displayName='外部编码';},
 disk:()=>clone(disks.get(metaEntry().path)),unmount:()=>root.render(null)}});
reset();
`);

if (!process.argv.includes("--reuse")) {
  await build({ configFile: join(desktop, "vite.config.ts"), root: cache,
    build: { outDir: output, emptyOutDir: true, rollupOptions: { input: join(cache, "index.html") } } });
}
const htmlPath = join(output, "index.html");
const html = await readFile(htmlPath, "utf8");
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") { response.setHeader("Content-Type", "text/html"); response.end(html); }
    else if (/^\/assets\/[\w.-]+$/.test(pathname)) {
      response.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : "text/javascript");
      response.end(await readFile(join(output, pathname.slice(1))));
    } else { response.writeHead(404); response.end(); }
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser, page;
const result = { source: "production MetaTab + WorkbenchFrame + application CSS, isolated memory IPC", sourceRoot:desktop, windows: [], functional: [], performance: {}, errors: [] };
const saveResult = () => writeFile(join(artifacts, "生产联调与性能-2026-11-06.json"), JSON.stringify(result, null, 2) + "\n");
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
try {
  browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--disable-gpu", "--js-flags=--expose-gc"] });
  page = await browser.newPage({ viewport: { width: 1640, height: 960 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => result.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  const openDemo = async () => {
    const resource = page.getByRole("button", { name: "打开元数据资源", exact: true });
    if (await resource.isVisible()) await resource.click();
    await page.getByRole("textbox", { name: "搜索元数据组件", exact: true }).fill("demo组件");
    await page.locator(".meta-entry").filter({ hasText: "demo组件" }).click();
    await page.locator('.meta-field-table [data-attr="billcode"]').waitFor();
    await page.getByRole("textbox", { name: "搜索元数据组件", exact: true }).fill("");
  };
  await openDemo();
  for (const [width, height] of [[1640,960],[1280,900],[1024,768],[1024,540],[819,614],[683,512],[560,900]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
      await page.getByRole("button", { name: "字段", exact: true }).click();
      const geometry = await page.evaluate(() => {
        const rect = document.querySelector(".meta-field-scroll").getBoundingClientRect();
        const root = document.querySelector(".meta-workbench");
        return { fieldHeight: rect.height, workbenchWidth: root.clientWidth, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
          overflowY: document.documentElement.scrollHeight > innerHeight + 1, resourceRows: document.querySelectorAll(".meta-entry").length, mode: root.dataset.size };
      });
      assert.ok(geometry.fieldHeight >= 90, `${width}x${height} keeps fields usable`);
      assert.equal(geometry.overflowX, false, `${width}x${height} external horizontal overflow`);
      assert.equal(geometry.overflowY, false, `${width}x${height} external vertical overflow`);
      assert.ok(geometry.resourceRows < 80, "1500 resources remain virtualized");
      await page.screenshot({ path: join(artifacts, `完成窗口-${width}x${height}-${theme === "dark" ? "深色" : "浅色"}-2026-11-06.png`) });
      result.windows.push({ width, height, theme, ...geometry });
    }
  }
  await page.setViewportSize({ width:1640, height:960 });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.getByRole("button", { name:"联动", exact:true }).click();
  await page.screenshot({ path: join(artifacts, "完成联动界面浅色-2026-11-06.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: join(artifacts, "完成联动界面深色-2026-11-06.png") });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.locator('.meta-canvas-field[data-attr="billcode"]').click();
  assert.equal(await page.locator('.meta-field-table [data-attr="billcode"]').getAttribute("aria-selected"), "true");
  await page.getByRole("button", { name:"接口与映射", exact:true }).click();
  const mapping = page.locator('[data-mapping="head/ia-code"]');
  await mapping.getByRole("button", { name:"code", exact:true }).first().click();
  assert.ok((await page.locator(".meta-property-inspector").textContent()).includes("接口属性"));
  await mapping.getByRole("button", { name:"code", exact:true }).nth(1).click();
  await page.getByRole("button", { name:"属性字段", exact:true }).click();
  await page.locator('.meta-field-table [data-attr="billcode"]').click();
  await page.keyboard.press("F2");
  await page.getByRole("textbox", { name:"快速编辑显示名", exact:true }).fill("报销单编码");
  await page.keyboard.press("Enter");
  await page.getByLabel("当前文档草稿").waitFor();
  assert.ok((await page.locator('.meta-field-table [data-attr="billcode"]').textContent()).includes("报销单编码"));
  assert.equal(await page.evaluate(() => window.metaAcceptance.disk().entities[0].attrs[0].displayName), "单据编码");
  await page.getByRole("button", { name:"撤销", exact:true }).click();
  assert.ok((await page.locator('.meta-field-table [data-attr="billcode"]').textContent()).includes("单据编码"));
  await page.getByRole("button", { name:"重做", exact:true }).click();
  await page.getByRole("button", { name:"关闭 demo", exact:true }).click();
  await page.getByRole("dialog", { name:"关闭未保存的元数据文档", exact:true }).waitFor();
  await page.getByRole("button", { name:"继续编辑", exact:true }).click();
  await page.getByRole("button", { name:"预览保存", exact:true }).click();
  await page.evaluate(() => window.metaAcceptance.fail("模拟备份失败"));
  await page.getByRole("button", { name:"保存全部修改", exact:true }).click();
  await page.getByRole("dialog", { name:"保存元数据草稿", exact:true }).getByText("Error: 模拟备份失败", { exact:true }).waitFor();
  assert.equal(await page.getByRole("button", { name:"保存全部修改", exact:true }).isDisabled(), true);
  await page.getByRole("button", { name:"继续编辑", exact:true }).click();
  await page.evaluate(() => window.metaAcceptance.fail(null));
  await page.getByRole("button", { name:"预览保存", exact:true }).click();
  await page.getByRole("button", { name:"保存全部修改", exact:true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="待保存"]'));
  assert.equal(await page.evaluate(() => window.metaAcceptance.disk().entities[0].attrs[0].displayName), "报销单编码");
  result.functional.push("图表与接口属性定位", "快改加入草稿", "撤销重做", "关闭保护", "失败保留与重新预览重试", "严格 SHA 保存");

  await page.getByRole("button", { name:/^字段操作/ }).click();
  await page.getByRole("menuitem", { name:"粘贴字段", exact:true }).click();
  await page.getByRole("textbox", { name:"粘贴字段内容", exact:true }).fill("字段名\t长度\nnewfield\t40\nsecond\t-1");
  assert.equal(await page.getByRole("button", { name:"加入草稿", exact:true }).isDisabled(), true);
  assert.ok((await page.getByRole("alert").textContent()).includes("第 3 行"));
  await page.screenshot({ path: join(artifacts, "整批粘贴预检-2026-11-06.png") });
  await page.getByRole("button", { name:"取消", exact:true }).click();
  await page.locator('.meta-field-table [data-attr="billcode"]').click();
  await page.keyboard.press("F2");
  await page.getByRole("textbox", { name:"快速编辑显示名", exact:true }).fill("草稿编码");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name:"预览保存", exact:true }).click();
  await page.evaluate(() => window.metaAcceptance.external());
  await page.getByRole("button", { name:"保存全部修改", exact:true }).click();
  await page.getByRole("dialog", { name:"保存元数据草稿", exact:true }).getByText("Error: 文件已被外部修改 SHA-256", { exact:true }).waitFor();
  await page.screenshot({ path: join(artifacts, "外部冲突保留草稿-2026-11-06.png") });
  assert.equal(await page.evaluate(() => window.metaAcceptance.disk().entities[0].attrs[0].displayName), "外部编码");
  result.functional.push("错误粘贴整批阻断", "外部修改不覆盖");
  await page.getByRole("button", { name:"继续编辑", exact:true }).click();
  await page.evaluate(() => window.metaAcceptance.reset("large"));
  await openDemo();
  await page.getByRole("button", { name:"联动", exact:true }).click();
  const large = await page.evaluate(() => ({ nodes:document.querySelectorAll(".meta-canvas-node").length,
    fields:document.querySelectorAll(".meta-field-table tr[data-attr]").length, resources:document.querySelectorAll(".meta-entry").length }));
  assert.ok(large.nodes < 80 && large.fields < 40 && large.resources < 80, "500 entities / 1000 fields / 1500 resources mount only visible items");
  await page.screenshot({ path: join(artifacts, "大模型裁剪与长表-2026-11-06.png") });
  const feedback = await page.evaluate(async () => {
    const field = document.querySelector('.meta-field-scroll');const values=[];
    for(let i=0;i<60;i++){
      const start=performance.now();field.dispatchEvent(new KeyboardEvent('keydown',{key:i%2?'ArrowUp':'ArrowDown',bubbles:true}));
      await new Promise(requestAnimationFrame);values.push(performance.now()-start);
    } return values;
  });
  result.performance.largeModel = { ...large, entities:500, relations:100, fieldsInPrimary:1000, resourcesInIndex:1500,
    feedback:{samples:feedback.length,medianMs:percentile(feedback,.5),p95Ms:percentile(feedback,.95),method:"DOM keydown to next requestAnimationFrame, includes scheduling"} };
  assert.ok(result.performance.largeModel.feedback.p95Ms <= 100, "large-model field feedback P95 <=100ms");

  await page.evaluate(() => window.metaAcceptance.reset("drag"));await openDemo();
  await page.getByRole("button", { name:"联动", exact:true }).click();
  const cdp = await page.context().newCDPSession(page);
  const traceEvents = [];
  const collectTrace = ({ value }) => traceEvents.push(...value);
  cdp.on("Tracing.dataCollected", collectTrace);
  await cdp.send("Tracing.start", { categories:"devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing", transferMode:"ReportEvents" });
  const drag = await page.evaluate(async () => {
    const node=document.querySelector('.meta-canvas-node[data-entity="head"]');
    const initialTransform=node.getAttribute('transform');
    const handle=node.querySelector('.meta-node-surface');
    const rect=handle.getBoundingClientRect(), start=performance.now(), frames=[], work=[];
    handle.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,clientX:rect.x+30,clientY:rect.y+15,bubbles:true,button:0}));
    let previous=performance.now();
    for(let i=0;i<45;i++){
      performance.mark('meta-frame-'+i+'-start');
      const begin=performance.now();
      for(let j=0;j<4;j++)window.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:rect.x+30+i*2+j*.2,clientY:rect.y+15+i,bubbles:true}));
      await new Promise(requestAnimationFrame);work.push(performance.now()-begin);const now=performance.now();frames.push(now-previous);previous=now;
    }
    window.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,clientX:rect.x+120,clientY:rect.y+60,bubbles:true}));
    await new Promise(requestAnimationFrame);performance.mark('meta-drag-end');
    return{frames,work,elapsedMs:performance.now()-start,initialTransform,transform:node.getAttribute('transform'),dirty:!!document.querySelector('[aria-label="待保存"]')};
  });
  assert.notEqual(drag.transform,drag.initialTransform,"pointer input moves the actual model node");
  assert.equal(drag.dirty,false,"dragging is a view change");
  result.performance.drag = { entities:50,relations:100,samples:drag.frames.length,medianIntervalMs:percentile(drag.frames,.5),
    p95IntervalMs:percentile(drag.frames,.95),p95InputToFrameMs:percentile(drag.work,.95),initialTransform:drag.initialTransform,finalTransform:drag.transform,
    method:"headless Edge with GPU disabled, includes frame scheduling; does not measure native WebView render CPU time" };
  const traceFinished = new Promise(done => cdp.once("Tracing.tracingComplete", done));
  await cdp.send("Tracing.end");await traceFinished;cdp.off("Tracing.dataCollected", collectTrace);
  await writeFile(join(artifacts,"拖动主线程轨迹-2026-11-06.json.gz"), gzipSync(JSON.stringify({traceEvents})));
  const marks = traceEvents.filter(event => /^meta-frame-\d+-start$/.test(event.name)).sort((a,b) => a.ts-b.ts);
  assert.equal(marks.length,45);
  const renderer = traceEvents.find(event => event.name === "thread_name" && event.args?.name === "CrRendererMain" && event.pid === marks[0].pid && event.tid === marks[0].tid);
  assert.ok(renderer, "performance marks identify the page renderer main thread");
  assert.ok(marks.every(mark => mark.pid === renderer.pid && mark.tid === renderer.tid),"all marks belong to the sampled page thread");
  const tasks = traceEvents.filter(event => event.pid === renderer.pid && event.tid === renderer.tid && event.name === "RunTask" && event.ph === "X" && event.dur > 0).sort((a,b) => a.ts-b.ts);
  const intervals = [];
  for(const task of tasks) {
    const previous = intervals[intervals.length-1], end = task.ts+task.dur;
    if(previous && task.ts <= previous[1]) previous[1]=Math.max(previous[1],end);
    else intervals.push([task.ts,end]);
  }
  const endMark = traceEvents.find(event => event.name === "meta-drag-end");
  assert.ok(endMark && endMark.pid === renderer.pid && endMark.tid === renderer.tid);
  const end = endMark.ts;
  assert.ok(tasks.length > 0);
  const cpu = marks.map((mark,index) => intervals.reduce((sum,[start,finish]) => sum+Math.max(0,Math.min(finish,marks[index+1]?.ts??end)-Math.max(start,mark.ts)),0)/1000);
  assert.ok(cpu.filter(value => value > .01).length >= Math.floor(cpu.length*.8),"trace captures real work for the drag frames");
  result.performance.drag.mainThread = { samples:cpu.length,medianMs:percentile(cpu,.5),p95Ms:percentile(cpu,.95),tasks:tasks.length,
    method:"CDP renderer-main RunTask duration union within pointer-frame performance marks; includes scripting/layout/paint and driver overhead, excludes scheduling idle and native/GPU work" };
  assert.ok(result.performance.drag.mainThread.p95Ms <= 16.7,"50 entities / 100 relations main-thread work P95 <=16.7ms");

  await page.evaluate(() => window.metaAcceptance.reset("normal"));await openDemo();
  await page.getByRole("textbox", { name:"搜索元数据组件", exact:true }).fill("component0");
  await page.locator(".meta-entry").click();
  await page.locator('.meta-document-tab.is-active').getByRole("button",{name:"component0组件",exact:true}).waitFor();
  await page.locator('.meta-field-table [data-attr="billcode"]').waitFor();
  await page.getByRole("textbox", { name:"搜索元数据组件", exact:true }).fill("");
  const hot = await page.evaluate(async () => {
    const before=window.metaAcceptance.calls().length, values=[], paths=[];
    for(let i=0;i<30;i++) {
      const name=i%2?'component0组件':'demo组件';
      const expected=i%2?'热切正文-B':'单据编码';
      const button=[...document.querySelectorAll('.meta-document-tab > button:first-child')].find(node=>node.textContent===name);
      if(!button)throw new Error('missing warmed document '+name);
      const start=performance.now();button.click();
      const shown=()=>document.querySelector('.meta-field-table [data-attr="billcode"]')?.textContent.includes(expected);
      do{await new Promise(requestAnimationFrame);}while(!shown() && performance.now()-start<2000);
      if(!shown())throw new Error('target document body did not appear '+name);
      if(!document.querySelector('.meta-document-tab.is-active').textContent.includes(name))throw new Error('document selection drifted');
      values.push(performance.now()-start);paths.push('D:/workspace/METADATA/'+(i%2?'component0':'demo')+'.bmf');
    }
    return{values,paths,reads:window.metaAcceptance.calls().slice(before).filter(call=>call.cmd==='bmf_doc_detail').map(call=>call.args.path)};
  });
  result.performance.hotSwitch={samples:hot.values.length,medianMs:percentile(hot.values,.5),p95Ms:percentile(hot.values,.95),shaRefreshReads:hot.reads.length,
    method:"two warmed normal fixtures, document click until unique target body appears at rAF in production browser with memory IPC; excludes native file I/O and parsing"};
  assert.deepEqual(hot.reads,hot.paths,"every hot switch refreshes the matching target path");
  assert.ok(result.performance.hotSwitch.p95Ms<=200,"warmed document feedback P95 <=200ms");
  await cdp.send("HeapProfiler.enable");await cdp.send("HeapProfiler.collectGarbage");
  const baseline=(await cdp.send("Runtime.getHeapUsage")).usedSize, heap=[];
  for(let i=0;i<8;i++){
    await page.evaluate(() => window.metaAcceptance.reset("normal"));await openDemo();
    await page.evaluate(() => window.metaAcceptance.unmount());await page.waitForTimeout(50);
    await cdp.send("HeapProfiler.collectGarbage");heap.push((await cdp.send("Runtime.getHeapUsage")).usedSize);
  }
  result.performance.memory={baselineUsedBytes:baseline,closedUsedBytes:heap,closedGrowthBytes:heap[heap.length-1]-heap[0],method:"CDP forced-GC JavaScript heap for repeated mount/unmount; excludes WebView native memory"};
  assert.ok(result.performance.memory.closedGrowthBytes<5*1024*1024,"closing repeatedly does not grow retained heap by 5 MiB");
  assert.deepEqual(result.errors,[]);
  result.passed=true;
  await saveResult();
  console.log(JSON.stringify({ windows:result.windows.length,functional:result.functional,performance:result.performance,passed:true }));
} catch(error) {
  result.passed=false;result.failure=String(error);await saveResult();
  if(page)await page.screenshot({path:join(artifacts,"生产联调失败-2026-11-06.png")}).catch(()=>{});
  throw error;
} finally {
  await browser?.close();await new Promise(done=>server.close(done));
}
