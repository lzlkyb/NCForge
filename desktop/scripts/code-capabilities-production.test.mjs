// Real production Monaco/React interactions; IPC fixtures isolate filesystem and JVM effects.
/* global localStorage, document, NodeFilter */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { codeFixture } from './code-workbench-fixture.mjs';
import { serviceFixture } from './service-console-fixture.mjs';

const dist = new URL('../dist/', import.meta.url);
const artifacts = new URL('../../docs/代码区能力补齐验收-2026-11-14/', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)[1];
const base = (await readFile(new URL('db-workbench-acceptance.test.mjs', import.meta.url), 'utf8')).match(/const bootstrap=`([\s\S]*?)`;/)[1];
const mocks = await readFile(new URL('../node_modules/@tauri-apps/api/mocks.js', import.meta.url));
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url)));
const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash('sha256').update(m[1]).digest('base64') + "'");
const csp = config.app.security.csp.replace(/script-src ([^;]+)/, (_, v) => `script-src ${v} ${hashes.join(' ')}`).replace(/style-src ([^;]+)/, (_, v) => `style-src ${v} 'nonce-capabilities'`);
const fixture = String.raw`
window.capabilityCalls=[];
const location=(name,line=2)=>({uri:'file:///'+serviceRoot+'/demo/'+name,range:{start:{line,character:10},end:{line,character:15}}});
const capabilityMock=(cmd,args)=>{
 window.capabilityCalls.push({cmd,args});
 if(cmd==='fs_list_dir'&&args.path===serviceRoot)return [{name:'demo',isDir:true,size:0}];
 if(cmd==='lang_status')return {state:'ready',module:'demo',message:'',sourceFiles:20,jarCount:1};
 if(cmd==='lang_notify'||cmd==='lang_start')return null;
 if(cmd==='lang_request'){
  if(args.method==='textDocument/hover')return {contents:{kind:'markdown',value:'public void execute()'}};
  if(args.method==='textDocument/implementation')return [location('B.java'),location('File01.java')];
  if(args.method==='textDocument/definition')return [location('B.java')];
  if(args.method==='java/findLinks')return [{displayName:'IService.execute',location:location('B.java')}];
  if(args.method==='textDocument/references')return [location('A.java',5),location('B.java',3)];
  if(args.method==='workspace/executeCommand'&&args.params.command==='ncforge.fieldAccesses')return {name:'name',references:[{...location('A.java',3),access:'read',accurate:true},{...location('B.java',3),access:'write',accurate:true}],truncated:false};
  if(args.method==='workspace/executeCommand'&&args.params.command==='ncforge.signatureWorkbench')return {name:'execute',parameters:[],returnType:'void'};
  if(args.method==='workspace/executeCommand'&&args.params.command==='ncforge.projectClasspath')return {project:'demo',entries:[],issues:[]};
  return null;
 }
 if(cmd==='project_tools_context')return {root:serviceRoot,maven:true,gradle:false,projects:[{name:'demo',root:serviceRoot,origin:'primary',depth:0,exported:true,classDirs:[],disabled:false,hasClasspath:true}],edges:[]};
 if(cmd==='change_shelf_list')return [];
 return undefined;
};
`;
const bootstrap = base.replace('/node_modules/@tauri-apps/api/mocks.js','/__mocks.js')
 .replace('const tx=',`${serviceFixture}\n${codeFixture}\n${fixture}\nconst tx=`)
 .replace(' window.dbCalls.push({cmd,args});',' window.dbCalls.push({cmd,args});const cap=capabilityMock(cmd,args);if(cap!==undefined)return cap;const code=codeMock(cmd,args);if(code!==undefined)return code;const svc=serviceMock(cmd,args);if(svc!==undefined)return svc;')
 .replace('workspace_root:null','workspace_root:serviceRoot').replace('lang_enabled:false','lang_enabled:true')
 .replace("throw Error('DB acceptance IPC not configured: '+cmd);",'return null;')
 .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');",'')
 .replace('/src/main.tsx',entry);

test('code capabilities: hover action, multiple targets, preview, right group and tool hosts', {timeout:180000}, async()=>{
 await mkdir(artifacts,{recursive:true});
 const server=createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://local').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',csp);res.end(html.replace(/<style>/g,'<style nonce="capabilities">').replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/,'<script type="module" src="/__fixture.js"></script>'));}
  else if(path==='/__fixture.js'||path==='/__mocks.js'){res.setHeader('Content-Type','text/javascript');res.end(path==='/__fixture.js'?bootstrap:mocks);}
  else if(/^\/assets\/[\w.-]+$/.test(path)||path==='/icon.png'){res.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(await readFile(new URL(path.slice(1),dist)));}
  else{res.writeHead(404);res.end();}
 }catch{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,channel:'msedge'}),errors=[],checks=[];
 try{for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  await context.addInitScript(theme=>{localStorage.setItem('theme',theme);localStorage.setItem('ncforge.ui-style','classic');localStorage.setItem('ncforge.tree.packageView','0');},theme);
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
   const tree=page.getByRole('tree',{name:'文件树',exact:true});await tree.getByText('demo',{exact:true}).click();await tree.getByText('A.java',{exact:true}).dblclick();
   const left=page.locator('.wb-editor-group-slot[data-group="left"]'),right=page.locator('.wb-editor-group-slot[data-group="right"]');
   await left.locator('.monaco-editor').waitFor();
   const command=async name=>{await page.locator('.wb-global-search').click();await page.getByLabel('快速导航输入',{exact:true}).fill('> '+name);await page.getByRole('option').filter({hasText:name}).first().click();};
   // The command and mouse-hover paths both execute the registered production navigation service.
   await left.locator('.view-line').filter({hasText:'public void execute()'}).first().click();
   await command('打开实现');
   const dialog=page.getByRole('dialog',{name:'打开实现',exact:true});await dialog.waitFor();
   assert.equal(await dialog.getByRole('listbox',{name:'导航目标'}).getByRole('option').count(),2);
   await dialog.getByLabel('筛选导航目标').fill('B.java');assert.equal(await dialog.getByRole('listbox',{name:'导航目标'}).getByRole('option').count(),1);
   await dialog.getByRole('button',{name:'就地预览',exact:true}).click();await dialog.locator('.nav-preview').waitFor();
   await page.screenshot({path:fileURLToPath(new URL(`${theme}-navigation.png`,artifacts))});
   await dialog.getByRole('button',{name:'在右侧打开',exact:true}).click();await right.getByRole('tab',{name:'B.java',exact:true}).waitFor();
   assert.equal(await left.getByRole('tab',{selected:true}).textContent().then(t=>t.includes('A.java')),true);
   assert.equal(await page.locator('.wb-editor-group-slot[data-focused="true"]').getAttribute('data-group'),'right');
   await left.getByRole('tab',{name:'A.java',exact:true}).click();
   const method=left.locator('.view-line').filter({hasText:'public void execute()'}).first();await method.hover();
   // Use Monaco's rendered word to retain a genuine pointer-driven hover.
   const rect=await method.evaluate(element=>{const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){const at=node.textContent.indexOf('execute');if(at<0)continue;const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+7);const box=range.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};}throw Error('No rendered method token');});
   await page.mouse.move(rect.x,rect.y);await page.getByRole('link',{name:'打开实现',exact:true}).waitFor();await page.getByRole('link',{name:'打开实现',exact:true}).click();await dialog.waitFor();await dialog.getByRole('button',{name:'关闭导航选择'}).click();checks.push(`${theme}:hover`);
   await command('找引用');await page.getByLabel('字段引用读写').waitFor();await page.getByLabel('字段引用读写').selectOption('write');
   assert.equal(await page.locator('.wb-prow').filter({hasText:'写入'}).count(),1);
   await command('管理 Java 代码模板');await page.getByRole('dialog',{name:'Java 代码模板',exact:true}).waitFor();await page.keyboard.press('Escape');
   await command('修改方法签名');await page.getByRole('dialog',{name:'修改方法签名',exact:true}).waitFor();await page.keyboard.press('Escape');
   await command('工程类路径');await page.getByRole('dialog',{name:'工程工具',exact:true}).waitFor();await page.getByRole('tab',{name:'变更集',exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click();
   await command('运行配置 / 测试');await page.getByText('完整 main 类名',{exact:true}).waitFor();
   await page.setViewportSize({width:1100,height:760});await page.screenshot({path:fileURLToPath(new URL(`${theme}-runtime.png`,artifacts))});
   checks.push(`${theme}:navigation,split,references,templates,refactor,project,runtime`);
  }catch(error){await page.screenshot({path:fileURLToPath(new URL(`${theme}-failure.png`,artifacts))});throw error;}finally{await context.close();}
 }}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await writeFile(new URL('results.json',artifacts),JSON.stringify({checks,errors},null,2));}
 assert.deepEqual(errors,[]);assert.ok(checks.some(check=>check.endsWith(':hover')),'No genuine hover executed');
});
