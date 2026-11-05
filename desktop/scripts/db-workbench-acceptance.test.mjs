// Formal frontend regression with mocked IPC; never connects to a business database.
/* global document, window, navigator, innerWidth */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir,writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const origin=process.env.GLASS_PREVIEW_URL || "http://localhost:1420";
const artifacts=new URL(process.env.UI_ARTIFACT_DIR || "../../docs/db-acceptance-20261104/",import.meta.url);
const bootstrap=`
import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
mockWindows('main'); window.dbCalls=[]; window.dbReadonly=false;
const tx=()=>({autoCommit:false,statements:0,rows:0,since:0});
const columns=[{name:'ID',type:'NUMBER',full:'NUMBER',pk:true,nullable:false,zh:'主键'},{name:'CODE',type:'VARCHAR2',full:'VARCHAR2(50)',pk:false,nullable:true,zh:'编码'},{name:'NAME',type:'VARCHAR2',full:'VARCHAR2(100)',pk:false,nullable:true,zh:'名称'}];
const conn={id:'c',name:'NC测试库',env:'test',source:'manual',url:'jdbc:oracle:thin:@localhost:1521/test',user:'NC_TEST',autoCommit:false,engine:'rust',hasPassword:true};
mockIPC((cmd,args)=>{
 window.dbCalls.push({cmd,args});
 if(cmd==='get_config') return {workspace_root:null,nc_home:null,autostart_enabled:false,lang_enabled:false,lang_auto_start:false,lang_xmx_mb:null,linked_overrides:[],auto_compile:false,deploy_on_start:false};
 if(cmd==='get_app_info') return {version:'0.1.0',platform:'windows',running:false};
 if(cmd==='get_autostart') return false;
 if(cmd==='resources_status' || cmd==='workspace_recent') return [];
 if(cmd==='db_conn_list') return [conn];
 if(cmd==='db_schema_cache') return null;
 if(cmd==='db_cached_tables') return {tables:[],fetchedAt:0};
 if(cmd==='db_connect') return {url:conn.url,user:conn.user,autoCommit:false};
 if(cmd==='db_caps') return {engine:'rust',connected:true,cancel:true,stats:true};
 if(cmd==='db_read_only') {if(args.enabled!==null) window.dbReadonly=args.enabled;return {readOnly:window.dbReadonly,tx:tx()};}
 if(cmd==='db_tx') return {tx:tx()};
 if(cmd==='db_meta') {
  if(args.kind==='tables') return {tables:[{name:'TEST_TABLE',kind:'TABLE'},{name:'TEST_CHILD',kind:'TABLE'}]};
  if(args.kind==='columns') return {columns};
  if(args.kind==='objects') return {objects:[{name:'TEST_PKG',type:'PACKAGE',status:'VALID'}]};
  if(args.kind==='ncNames') return {names:{test_table:'测试主表',test_child:'测试子表'}};
  if(args.kind==='indexes') return {indexes:[]};
  if(args.kind==='ddl') return {ddl:'create table TEST_TABLE (ID number primary key)'};
  return {names:{}};
 }
 if(cmd==='db_exec_bound') {if(args.sql.startsWith('update')) return {kind:'update',updateCount:1,ms:1,tx:tx()};return {kind:'rows',columns,rows:[[1,'A','甲'],[2,'B','乙'],[3,'C','丙']],hasMore:false,ms:10,tx:tx()};}
 if(cmd==='db_relations') return {foreign:{kind:'rows',columns:['RELATION','SOURCE_TABLE','SOURCE_COLUMN','TARGET_TABLE','TARGET_COLUMN','POSITION'].map(name=>({name,type:'VARCHAR2'})),rows:[['FK_CHILD','TEST_CHILD','ID','TEST_TABLE','ID',1]],hasMore:false},references:{kind:'rows',columns:[],rows:[]},notes:['NC类引用不可用：当前库缺少元数据表'],sharedSession:false};
 if(cmd==='nc_md_dict') return {tables:[],missing:[],tableCount:0,columnCount:0};
 if(cmd==='plugin:window|is_visible') return true;
 if(cmd==='plugin:window|is_maximized') return false;
 if(cmd.startsWith('plugin:')) return null;
 throw Error('DB acceptance IPC not configured: '+cmd);
},{shouldMockEvents:true});
localStorage.setItem('ncforge-db-tabs',JSON.stringify({tabs:[{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}],active:'acceptance-table'}));
const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');
await import('/src/main.tsx');
`;
test('database workflow: selection, layouts, filters, snapshots, query-only, relations and 560px themes',async()=>{
 await mkdir(artifacts,{recursive:true});
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['clipboard-read','clipboard-write']});
 const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[],measurements=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin+'/',async route=>{const response=await route.fetch();const body=(await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, '<script type="module">'+bootstrap+'</script>');assert.ok(body.includes('mockWindows'));await route.fulfill({response,body});});
 try {
  await page.goto(origin,{waitUntil:"domcontentloaded",timeout:60000});await page.locator('.app-side').getByRole('button',{name:/^数据库/}).click({timeout:30000});
  await page.locator('#dbx-conn-c').click();
  await page.locator('#dbx-cell-0-1').waitFor();
  await page.locator('#dbx-cell-0-1').click();await page.keyboard.press('Shift+ArrowDown');await page.keyboard.press('Shift+ArrowDown');await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'A\t甲\r\nB\t乙\r\nC\t丙');
  await page.getByRole('button',{name:'结果列布局',exact:true}).click();
  const layout=page.getByRole('dialog',{name:'结果列布局'});await layout.locator('label').filter({hasText:'NAME'}).locator('input').uncheck();await layout.getByRole('button',{name:'完成',exact:true}).click();
  assert.equal(await page.locator('.dbx-ghead .dbx-gh').count(),3);
  await page.getByRole('button',{name:'展开筛选',exact:true}).click();
  await page.getByRole('button',{name:'添加条件',exact:true}).click();await page.getByLabel('条件 1 字段').selectOption('CODE');await page.getByLabel('条件 1 值').fill("O'Brien");await page.getByRole('button',{name:'保存常用筛选',exact:true}).click();await page.getByRole('button',{name:'查询',exact:true}).click();
  await page.waitForFunction(()=>window.dbCalls.some(c=>c.cmd==='db_exec_bound' && c.args.params[0]==="O'Brien"));
  assert.equal(await page.evaluate(()=>window.dbCalls.filter(c=>c.cmd==='db_exec_bound').at(-1).args.sql.includes("O'Brien")),false);
  await page.getByRole('button',{name:'固定为对照',exact:true}).click();await page.getByRole('button',{name:'结果对比',exact:true}).click();await page.getByRole('dialog',{name:'查询结果对比'}).getByLabel('ID',{exact:true}).check();await page.getByText('新增 0 行 · 删除 0 行 · 变化 0 行',{exact:true}).waitFor();await page.getByRole('dialog',{name:'查询结果对比'}).getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'开启只读查询',exact:true}).click();await page.getByRole('button',{name:'只读查询已开启',exact:true}).waitFor();await page.locator('#dbx-cell-0-1').dblclick();assert.equal(await page.locator('.dbx-gedit').count(),0);await page.getByRole('button',{name:'只读查询已开启',exact:true}).click();await page.getByRole('button',{name:'开启只读查询',exact:true}).waitFor();
  await page.locator('#dbx-cell-0-1').click();await page.getByRole('button',{name:'关联记录',exact:true}).click();await page.getByRole('button',{name:'打开关联记录',exact:true}).click();await page.getByRole('button',{name:'返回上一表',exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭 test_table 标签 · NC测试库',exact:true}).click();
  await page.getByRole('button',{name:'返回上一表',exact:true}).click();
  await page.locator('.dbx-subtabs .title .dbx-mono').filter({hasText:'test_table'}).waitFor();
  await page.getByText('来源标签已关闭，已重新打开表',{exact:true}).waitFor();
  await page.keyboard.press('Control+Alt+o');await page.getByRole('dialog',{name:'查找数据库对象'}).waitFor();await page.getByLabel('查找表名或中文名').fill('TEST_TABLE');await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'查找数据库对象'}).waitFor({state:'hidden'});
  for(const [name,width,dark,height=900] of [['db-light-wide',1280,false],['db-light-narrow',560,false],['db-dark-narrow',560,true],['db-1024',1024,false,768],['db-low-height',1024,false,540],['db-scale-125-equivalent',819,false,614],['db-scale-150-equivalent',683,false,512]]) {
   await page.setViewportSize({width,height});await page.evaluate(async dark=>{
    const t=await import('/src/lib/theme.ts');
    const original=document.startViewTransition?.bind(document);let finished=Promise.resolve();
    if(original) document.startViewTransition=(...args)=>{const vt=original(...args);finished=vt.finished.catch(()=>{});return vt;};
    try { t.applyTheme(dark?'dark':'light');await finished; }
    finally { if(original) document.startViewTransition=original; }
   },dark);
   await page.waitForFunction(dark=>document.documentElement.classList.contains('dark')===dark && !document.documentElement.classList.contains('theme-transition'),dark);
   // Close the overlay sidebar to evaluate the document area at its actual narrow width.
   if(width===560 && await page.locator('.wb-tree').isVisible()) {
     await page.getByRole('button',{name:'关闭资源侧栏',exact:true}).click();await page.locator('.wb-tree').waitFor({state:'hidden'});
   }
   if(await page.locator('.toast').count()) await page.locator('.toast').first().waitFor({state:'hidden',timeout:10000});
   if(await page.getByRole('button',{name:'展开筛选',exact:true}).isVisible()) await page.getByRole('button',{name:'展开筛选',exact:true}).click();
   const m=await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,grid:document.querySelector('.dbx-grid')?.getBoundingClientRect().height,filter:document.querySelector('.dbx-filterbar')?.getBoundingClientRect().toJSON(),context:document.querySelector('.dbx-context')?.getBoundingClientRect().toJSON()}));measurements.push({name,...m});assert.equal(m.overflow,false,name+' external overflow');assert.ok(m.grid>60,name+' readable grid');if(width===560) assert.equal(await page.locator('.wb-side-backdrop:not([hidden])').isVisible(),false,name+' document unobscured');
   const header=page.locator('.dbx-filter-header');
   await header.getByRole('button',{name:'查询',exact:true}).waitFor({state:'visible'});
   const before=await header.boundingBox();
   await page.locator('.dbx-filter-body').evaluate(el=>{el.scrollTop=el.scrollHeight;});
   const after=await header.boundingBox();
   assert.equal(after.y,before.y,name+' stable query header');
   await page.locator('.dbx-filter-body').evaluate(el=>{el.scrollTop=0;});
   await page.getByRole('button',{name:'收起筛选',exact:true}).click();
   const collapsed=await page.locator('.dbx-filterbar').boundingBox();
   assert.ok(collapsed.height < 60,name+' compact filter');
   assert.equal(await page.locator('.dbx-filter-body').isVisible(),false);
   assert.ok((await page.locator('.dbx-grid').boundingBox()).height > m.grid,name+' more result space');
   assert.ok(await header.getByRole('button',{name:'查询',exact:true}).isVisible());
   await page.screenshot({path:new URL(name+'.png',artifacts).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
   await page.getByRole('button',{name:'展开筛选',exact:true}).click();
  }
  assert.deepEqual(errors,[]);await writeFile(new URL('measurements.json',artifacts),JSON.stringify(measurements,null,2));
 }catch(error){
  await writeFile(new URL('failure.json',artifacts),JSON.stringify(await page.evaluate(()=>({text:document.body.innerText,calls:window.dbCalls,db:window.dbStore?.getDb()})).catch(()=>({errors})),null,2));
  await page.screenshot({path:new URL('failure.png',artifacts).pathname.replace(/^\/([A-Za-z]:)/,'$1')});throw error;
 }finally{await context.close();await browser.close();}
});
