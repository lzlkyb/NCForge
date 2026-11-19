// Packaged assets and memory-only IPC: no workspace writes, database or service starts.
/* global window, document, performance, requestAnimationFrame, MutationObserver, PerformanceObserver, getComputedStyle */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const phase=process.argv[2] || 'after', dist=new URL('../dist/',import.meta.url);
const tracing=process.argv.includes('--trace');
assert.ok(['before','after'].includes(phase));
const artifacts=new URL(process.env.NCFORGE_PERF_ARTIFACTS ?? '../../docs/切页与骨架屏验收-2026-11-14/',import.meta.url);
await mkdir(artifacts,{recursive:true});
const html=await readFile(new URL('index.html',dist),'utf8'), entry=html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1];
const db=await readFile(new URL('db-workbench-acceptance.test.mjs',import.meta.url),'utf8');
const raw=db.match(/const bootstrap=\x60([\s\S]*?)\x60;/)?.[1];
const material=await readFile(new URL('material-workbench-acceptance.mjs',import.meta.url),'utf8');
const memory=material.match(/\.replace\('mockIPC\(\(cmd,args\)=>\{', \x60([\s\S]*?)\x60\)/)?.[1];
assert.ok(entry && raw && memory);
const bootstrap=raw.replace('/node_modules/@tauri-apps/api/mocks.js','/mocks.js')
  .replace("mockWindows('main');",`mockWindows('main');window.switchTransitions=[];window.switchViolations=[];
    document.addEventListener('securitypolicyviolation',e=>window.switchViolations.push(e.effectiveDirective));
    const native=document.startViewTransition?.bind(document);
    if(native)document.startViewTransition=update=>{const item={started:performance.now()};window.switchTransitions.push(item);const t=native(update);t.ready.then(()=>item.ready=performance.now(),()=>{});t.finished.then(()=>item.finished=performance.now(),()=>{});return t;};
    localStorage.setItem('theme','light');localStorage.setItem('ncforge.ui-style','classic');localStorage.setItem('ncforge.ui-density','standard');localStorage.setItem('ncforge-rail-expanded','0');`)
  .replace('mockIPC((cmd,args)=>{',memory.replace('mockIPC((cmd,args)=>{',"mockIPC((cmd,args)=>{if(cmd==='fs_list_dir')return Array.from({length:3000},(_,i)=>({name:'Demo'+i+'.java',isDir:false,size:120}));"))
  .replace('workspace_root:null','workspace_root:fixtureRoot')
  .replace("if(cmd==='db_exec_bound')","if(cmd==='db_slot_acquire')return {slot:'page-switch',tx:tx()};if(['db_exec','db_exec_result','db_exec_bound'].includes(cmd))")
  .replace('ms:10,tx:tx()','ms:10,output:[],tx:tx()')
  .replace("throw Error('DB acceptance IPC not configured: '+cmd);",'return null;')
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}","{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'select * from TEST_TABLE',maxRows:500,timeoutSec:30}")
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');",'')
  .replace('/src/main.tsx',entry);
assert.ok(!bootstrap.includes('/src/'));
const mocks=await readFile(new URL('../node_modules/@tauri-apps/api/mocks.js',import.meta.url));
const config=JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
const hashes=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>"'sha256-"+createHash('sha256').update(m[1]).digest('base64')+"'");
const csp=config.app.security.csp.replace(/script-src ([^;]+)/,(_,v)=>'script-src '+v+' '+hashes.join(' '));
const server=createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/') {res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',csp);res.end(html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/,'<script type="module" src="/fixture.js"></script>'));}
    else if(path==='/fixture.js'||path==='/mocks.js'){res.setHeader('Content-Type','text/javascript');res.end(path==='/fixture.js'?bootstrap:mocks);}
    else if(/^\/(assets|fonts)\/[\w/.-]+$/.test(path)||path==='/icon.png'){
      res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream');
      res.end(await readFile(new URL(path.slice(1),dist)));
    } else {res.writeHead(404);res.end();}
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const definitions=[['files','代码','.wb-editor-groups'],['db','数据库','.dbx-page'],['svn','版本控制','.vc-review-document'],['meta','元数据','.meta-workbench'],['logs','日志排查','.lg-page'],['settings','设置','.wb-settings-page']];
let browser,page;const errors=[],cold=[],warm=[],retention=[];
try{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'});
  page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  // A delayed first chunk makes each lazy fallback inspectable without slowing normal warm navigation.
  await page.route(/\/(FilesTab|DbTab|SvnTab|MetaTab|LogTab|SettingsTab)-[^/]+\.js$/,async route=>{await new Promise(resolve=>setTimeout(resolve,2500));await route.continue();});
  await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'domcontentloaded'});
  const snapshot=async key=>{
    if(phase==='after')await page.locator('[data-workspace-skeleton="'+key+'"][data-visible]').first().waitFor();
    const result=await page.evaluate(()=>{
      const rect=el=>el?Object.fromEntries(['x','y','width','height'].map(k=>[k,el.getBoundingClientRect()[k]])):null;
      const sk=document.querySelector('.wb-doc-body [data-workspace-skeleton],.wb-code-body [data-workspace-skeleton]')||document.querySelector('.wb-tool-runtime .ui-loading-state')||document.querySelector('.wb-skeleton-editor');
      return {skeleton:rect(sk),document:rect(document.querySelector('#wb-document-surface:not([hidden]) .wb-doc-body')||document.querySelector('.wb-code-body')),inside:!!sk?.closest('.wb-doc-body,.wb-code-body'),outside:document.querySelectorAll('.wb-tool-runtime .ui-loading-state').length,toolbar:rect(document.querySelector('.wb-toolbar')),tabs:rect(document.querySelector('.wb-doc-tabs')),shellRadius:parseFloat(getComputedStyle(document.querySelector('.wb-root')).borderTopLeftRadius)};
    });
    cold.push({key,...result});await page.screenshot({path:fileURLToPath(new URL(phase+'-'+key+'-loading.png',artifacts)),animations:'disabled'});
    if(phase==='after'){assert.ok(result.inside,key+' skeleton docks in its real content region');assert.equal(result.outside,0);assert.equal(result.shellRadius,14);}
  };
  const actual=async key=>{
    if(phase!=='after')return;
    const bounds=await page.evaluate(()=>{
      const el=document.querySelector('#wb-document-surface:not([hidden]) .wb-doc-body')||document.querySelector('.wb-code-body');
      return Object.fromEntries(['x','y','width','height'].map(k=>[k,el.getBoundingClientRect()[k]]));
    });cold.find(item=>item.key===key).actual=bounds;
    await page.screenshot({path:fileURLToPath(new URL('after-'+key+'-ready.png',artifacts)),animations:'disabled'});
  };
  await page.locator('.wb-root').waitFor();await snapshot('files');await page.locator('.wb-editor-groups').waitFor();await actual('files');
  for(const [key,label,selector] of definitions.slice(1)){
    await page.locator('.app-side').getByRole('button',{name:new RegExp('^'+label)}).click();
    await page.locator('.wb-root[data-tool="'+key+'"]').waitFor();await snapshot(key);
    await page.locator(selector).waitFor();await actual(key);
  }
  await page.unroute(/\/(FilesTab|DbTab|SvnTab|MetaTab|LogTab|SettingsTab)-[^/]+\.js$/);
  const session=tracing?await page.context().newCDPSession(page):null,events=[];
  if(session){session.on('Tracing.dataCollected',({value})=>events.push(...value));await session.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline',transferMode:'ReportEvents'});}
  for(let round=0;round<(tracing?1:3);round++)for(const [key,label] of definitions){
    const reading=await page.locator('.app-side').getByRole('button',{name:new RegExp('^'+label)}).evaluate(async(button,key)=>{
      const frameTimes=[],tasks=[],root=document.querySelector('.wb-root');let committed=null,previous=performance.now();const start=previous;
      const changes=new MutationObserver(()=>{if(root.dataset.tool===key&&committed===null)committed=performance.now()-start;});changes.observe(root,{attributes:true,attributeFilter:['data-tool']});
      const observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask',buffered:false});
      button.click();
      while(frameTimes.length<3||performance.now()-start<400){const now=await new Promise(requestAnimationFrame);frameTimes.push(now-previous);previous=now;}
      changes.disconnect();observer.disconnect();const sorted=frameTimes.sort((a,b)=>a-b);
      return {commitMs:Math.round((committed??0)*10)/10,p95:sorted[Math.floor((sorted.length-1)*.95)],max:Math.max(...sorted),longTasks:tasks.length,longTaskMs:tasks.reduce((a,b)=>a+b,0)};
    },key);warm.push({round,key,...reading});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.switchViolations),[]);
  const transitions=await page.evaluate(()=>window.switchTransitions);
  if(session){const done=new Promise(resolve=>session.once('Tracing.tracingComplete',resolve));await session.send('Tracing.end');await done;await writeFile(new URL('trace.json',artifacts),JSON.stringify({traceEvents:events}));}
  if(phase==='after'&&!tracing){
    const navigate=label=>page.locator('.app-side').getByRole('button',{name:new RegExp('^'+label)}).click();
    await navigate('代码');const tree=page.getByRole('tree',{name:'文件树',exact:true});
    await tree.evaluate(el=>{el.dataset.identity='retained';el.scrollTop=6000;});
    const treeBefore=await tree.evaluate(el=>({top:el.scrollTop,width:el.clientWidth,height:el.scrollHeight}));
    await navigate('元数据');await navigate('日志排查');await navigate('数据库');await navigate('代码');
    const treeAfter=await tree.evaluate(el=>({identity:el.dataset.identity,top:el.scrollTop,width:el.clientWidth,height:el.scrollHeight}));
    assert.equal(treeAfter.identity,'retained');assert.equal(treeAfter.top,treeBefore.top);assert.equal(treeAfter.width,treeBefore.width);assert.equal(treeAfter.height,treeBefore.height);
    assert.ok(treeAfter.height>=3000*27,'offscreen rows preserve the full scroll extent');
    await tree.focus();await page.keyboard.press('End');
    const end=await tree.evaluate(el=>{const row=document.getElementById(el.getAttribute('aria-activedescendant'));return {selected:row?.getAttribute('aria-selected'),visible:!!row&&row.getBoundingClientRect().top>=el.getBoundingClientRect().top&&row.getBoundingClientRect().bottom<=el.getBoundingClientRect().bottom,top:el.scrollTop};});
    assert.equal(end.selected,'true');assert.ok(end.visible,'keyboard End reveals an offscreen row');
    retention.push({treeBefore,treeAfter,end});
    await navigate('数据库');const sql=page.getByRole('textbox',{name:'SQL 查询编辑器',exact:true});
    await sql.focus();await page.keyboard.press('Control+A');await page.keyboard.type('select 42 as preserved_draft');
    await navigate('设置');await navigate('数据库');assert.equal(await sql.inputValue(),'select 42 as preserved_draft');
    const quick=[];for(const label of ['元数据','日志排查','代码','设置'])quick.push(await page.locator('.app-side').getByRole('button',{name:new RegExp('^'+label)}).elementHandle());
    await page.evaluate(buttons=>buttons.forEach(button=>button.click()),quick);
    await page.locator('.wb-root[data-tool="settings"]').waitFor();
    await page.emulateMedia({reducedMotion:'reduce'});await navigate('元数据');
    assert.equal(await page.locator('.wb-main-with-inspector').evaluate(el=>el.getAnimations().length),0);
    retention.push({sqlDraft:true,latestClick:'settings',reducedMotion:true});
    const narrow=await browser.newPage({viewport:{width:1024,height:768},reducedMotion:'reduce'});
    try{
      await narrow.route(/\/(MetaTab|LogTab)-[^/]+\.js$/,async route=>{await new Promise(resolve=>setTimeout(resolve,2500));await route.continue();});
      await narrow.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'domcontentloaded'});
      await narrow.locator('.wb-editor-groups').waitFor();
      for(const [key,label,selector] of definitions.filter(item=>['meta','logs'].includes(item[0]))){
        await narrow.locator('.app-side').getByRole('button',{name:new RegExp('^'+label)}).click();
        await narrow.locator('[data-workspace-skeleton="'+key+'"][data-visible]').first().waitFor();
        if(key==='meta')assert.equal(await narrow.locator('.wb-loading-meta>.wb-loading-sidebar').isVisible(),false,'metadata skeleton follows the real resource drawer breakpoint');
        if(key==='logs')assert.ok(await narrow.locator('.wb-loading-logs').evaluate(el=>getComputedStyle(el).gridTemplateRows.split(' ').length===2),'narrow log skeleton stacks list and detail');
        await narrow.screenshot({path:fileURLToPath(new URL('after-'+key+'-loading-1024.png',artifacts)),animations:'disabled'});
        await narrow.locator(selector).waitFor();
      }
      retention.push({narrowMetadata:true,narrowLogs:true});
    }finally{await narrow.close();}
  }
  await writeFile(new URL((tracing?'trace-sample':phase)+'.json',artifacts),JSON.stringify({phase,entry,cold,warm,transitions,retention,errors},null,2)+'\n');
  console.log(JSON.stringify({phase,cold,warm,transitions:transitions.length,errors}));
}catch(error){if(page)console.log(JSON.stringify({errors,body:(await page.locator('body').innerText()).slice(0,1400)}));throw error;}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
