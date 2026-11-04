/* global window, document, requestAnimationFrame, getComputedStyle, innerWidth */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
const origin=process.env.UI_PREVIEW_URL || 'http://localhost:1420';
const artifacts=new URL('../../docs/interaction-acceptance-20261104/',import.meta.url);
const bootstrap=String.raw`
import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
mockWindows('main');window.acceptanceCommands=[];window.acceptanceReads=[];window.waitReads=false;
const root='C:\\acceptance';
mockIPC(async(cmd,args)=>{
 window.acceptanceCommands.push({cmd,args});
 if(cmd==='get_workspace')return root;
 if(cmd==='get_config')return {workspace_root:root,nc_home:null,autostart_enabled:false,lang_enabled:false,lang_auto_start:false,lang_xmx_mb:null,linked_overrides:[],auto_compile:false,deploy_on_start:false};
 if(cmd==='get_app_info')return {version:'0.1.0',platform:'windows',running:false};
 if(cmd==='tree_projects')return [];
 if(cmd==='fs_list_dir')return [{name:'A.java',isDir:false,size:50},{name:'B.java',isDir:false,size:50}];
 if(cmd==='fs_read_file') {if(window.waitReads)await new Promise(resolve=>window.acceptanceReads.push(resolve));return {text:'public class A {\n    public void execute() {}\n}\n',encoding:'UTF-8',hasBom:false,eol:'LF',mtimeMs:1,lossless:true};}
 if(cmd==='fs_encoding_marks' || cmd==='workspace_recent' || cmd==='resources_status' || cmd==='local_history_list' || cmd==='db_conn_list')return [];
 if(cmd==='local_history_capture')return null;
 if(cmd==='get_autostart')return false;
 if(cmd==='lang_status')return {state:'stopped',module:null,reason:null};
 if(cmd==='server_status')return {state:'stopped',pid:null,port:80,portOpen:false,portOwnedBySelf:false,projectRoot:root,ncHome:null,logPath:'',logSize:0,reason:null,heapMb:4096,defaultHeapMb:4096,debugPort:null};
 if(cmd==='server_log')return {text:'',nextOffset:0};
 if(cmd==='nc_home_probe')return {path:null,valid:false,issues:[]};
 if(cmd==='svn_info')return null;
 if(cmd==='svn_status')return [];
 if(cmd==='nc_manifest')return null;
 if(cmd==='db_cached_tables')return {tables:[],fetchedAt:0};
 if(cmd==='db_schema_cache')return null;
 if(cmd.startsWith('plugin:'))return cmd==='plugin:window|is_visible'?true:cmd==='plugin:window|is_maximized'?false:null;
 return null;
},{shouldMockEvents:true});
localStorage.clear();
const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');
await import('/src/main.tsx');
`;
test('code reading and global tasks: real frontend, delayed IPC, themes, narrow layout and reduced motion',async()=>{
 await mkdir(artifacts,{recursive:true});
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const context=await browser.newContext({viewport:{width:1280,height:800}});
 const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[],measurements=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin+'/',async route=>{const response=await route.fetch();const body=(await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/,'<script type="module">'+bootstrap+'</script>');assert.ok(body.includes('mockWindows'));await route.fulfill({response,body});});
 const settled=()=>page.evaluate(async()=>{await document.startViewTransition?.(()=>{}).finished;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
 const openTasks=async()=>{const trigger=page.locator('.wb-header-icon.op-status');if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();await page.locator('.op-panel:not([data-exiting])').waitFor();await settled();};
 try {
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});
  await page.getByRole('treeitem',{name:'A.java',exact:true}).click({timeout:30000});await page.locator('.wb-tab').filter({hasText:'A.java'}).waitFor();await page.locator('.monaco-editor').first().waitFor({timeout:30000});
  await page.evaluate(()=>{window.waitReads=true;});
  await page.getByRole('treeitem',{name:'B.java',exact:true}).click();
  await page.locator('.wb-read-feedback').filter({hasText:'B.java'}).waitFor();
  assert.equal(await page.locator('.wb-tab[data-active]').count(),1);
  assert.match(await page.locator('.wb-tab[data-active]').innerText(),/A.java/);
  const before=await page.locator('.monaco-editor').count();assert.ok(before>0,'waiting preserves mounted editor');
  await page.locator('.app-side').getByRole('button',{name:/^设置/}).click();
  await openTasks();
  await page.locator('.op-row').filter({hasText:'读取 B.java'}).getByRole('button',{name:'返回来源'}).click();
  await page.locator('.wb-read-feedback').filter({hasText:'B.java'}).waitFor();
  for(const width of [1280,1024,560]) for(const dark of [false,true]){
    await page.setViewportSize({width,height:800});
    await page.locator('.app-side').getByRole('button',{name:/^设置/}).click();
    await page.locator('.wb-root[data-tool="settings"]').waitFor();await settled();
    if(width===560){const close=page.getByRole('button',{name:'关闭设置分类',exact:true});if(await close.isVisible()){await close.click();await page.locator('.wb-tree').waitFor({state:'hidden'});}}
    await page.getByRole('radiogroup',{name:'明暗主题',exact:true}).getByRole('radio',{name:dark?'深色':'浅色'}).click();
    await page.waitForFunction(dark=>document.documentElement.classList.contains('dark')===dark && !document.documentElement.classList.contains('theme-transition'),dark);
    await openTasks();await page.locator('.op-row').filter({hasText:'读取 B.java'}).getByRole('button',{name:'返回来源'}).click();
    await openTasks();await settled();
    const m=await page.evaluate(()=>{const el=document.querySelector('.op-panel:not([data-exiting])');const r=el.getBoundingClientRect();const status=document.querySelector('.wb-status');const bounds=status.getBoundingClientRect();const clipped=[...status.children].filter(e=>{const box=e.getBoundingClientRect();return box.width>0 && (box.top<bounds.top || box.bottom>bounds.bottom || box.left<bounds.left || box.right>bounds.right);}).map(e=>e.textContent);return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,left:r.left,right:r.right,panels:[...document.querySelectorAll('.op-panel')].map(e=>e.id),editors:document.querySelectorAll('.monaco-editor').length,statusClipped:clipped,statusOverflow:status.scrollWidth>status.clientWidth};});
    measurements.push({...m,dark});assert.equal(m.overflow,false);assert.ok(m.left>=0 && m.right<=width);assert.equal(new Set(m.panels).size,m.panels.length);assert.equal(m.editors,before);assert.deepEqual(m.statusClipped,[],'status entries fit on one line');assert.equal(m.statusOverflow,false,'code footer needs no horizontal scroll');
    await page.screenshot({path:new URL(`code-tasks-${width}-${dark?'dark':'light'}.png`,artifacts).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});
    await page.keyboard.press('Escape');assert.equal(await page.locator('.wb-header-icon.op-status').evaluate(e=>document.activeElement===e),true);
  }
  await page.emulateMedia({reducedMotion:'reduce'});await openTasks();
  const spin=await page.locator('.wb-header-icon.op-status svg').evaluate(e=>getComputedStyle(e).animationName);assert.equal(spin,'none');
  await page.evaluate(()=>{window.waitReads=false;window.acceptanceReads.splice(0).forEach(resolve=>resolve());});
  await page.locator('.wb-tab').filter({hasText:'B.java'}).waitFor();
  await page.locator('.op-row').filter({hasText:'读取 B.java'}).getByText(/已完成/).first().waitFor();
  const reads=await page.evaluate(()=>window.acceptanceCommands.filter(c=>c.cmd==='fs_read_file' && c.args.path.endsWith('B.java')).length);assert.equal(reads,1,'returning to same pending file shares the IPC');
  await page.locator('.op-panel:not([data-exiting])').getByRole('button',{name:'清除已结束'}).click();await page.getByText('暂无运行任务。耗时操作开始后会在这里显示。').waitFor();
  assert.deepEqual(errors,[]);await writeFile(new URL('measurements.json',artifacts),JSON.stringify({measurements,errors,reads},null,2));
 }catch(error){await writeFile(new URL('failure.json',artifacts),JSON.stringify({error:String(error),errors,commands:await page.evaluate(()=>window.acceptanceCommands),body:await page.locator('body').innerText(),hosts:await page.locator('.wb-editor-host').evaluateAll(es=>es.map(e=>({html:e.outerHTML,rect:e.getBoundingClientRect().toJSON()})))},null,2));await page.screenshot({path:new URL('failure.png',artifacts).pathname.replace(/^\/([A-Za-z]:)/,'$1')});throw error;}finally{await browser.close();}
});
