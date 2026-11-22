/* global window, document, innerWidth, requestAnimationFrame */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const origin=process.env.SVN_PREVIEW_URL || 'http://localhost:1420';
const artifacts=new URL('../../target/svn-workbench-acceptance/',import.meta.url);
const bootstrap=String.raw`
import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
mockWindows('main');window.svnCommands=[];window.svnSubmitted=[];window.svnDelayPath='';window.svnPending=[];
const root='C:/svn-acceptance';
const entries=[['A.java','M'],['B.java','M'],['Deleted.java','D'],['Conflict.java','C'],['New.java','?']].map(([name,letter],index)=>({path:root+'/module/src/'+name,rel:'module/src/'+name,module:'module',letter,status:'modified',revision:8,isDir:false,ignored:false,mtimeMs:1000+index}));
const text='public class A {\n    public void execute() {\n        save();\n    }\n}\n';
const logResult={entries:[{logger:'nclog',file:'nc.log',lineNo:12,ts:'2026-11-07 18:00:00',callId:null,thread:'worker-1',userId:null,remoteCall:null,level:'ERROR',msg:'java.lang.IllegalStateException: save failed',stack:[],stackTruncated:false,costMs:null,rowCount:null,verdict:{rule:'qa',severity:'error',title:'保存失败',cause:'保存流程返回异常',action:'查看异常正文并定位调用',jump:null}}],scannedFiles:['nc.log'],recordsScanned:10,truncatedFiles:0,stoppedEarly:false,elapsedMs:1,slowThresholdMs:1000};
mockIPC(async(cmd,args)=>{
 window.svnCommands.push({cmd,args});
 if(cmd==='get_workspace')return root;
 if(cmd==='nc_log_sources')return {home:'C:/qa-nc',configPath:'C:/qa-nc/logger.properties',fromConfig:true,serverDir:'server',loggers:[],logsRoot:'C:/qa-nc/nclogs'};
 if(cmd==='nc_log_query' || cmd==='nc_log_search')return logResult;
 if(cmd==='get_config')return {workspace_root:root,nc_home:null,autostart_enabled:false,lang_enabled:false,lang_auto_start:false,lang_xmx_mb:null,linked_overrides:[],auto_compile:false,deploy_on_start:false};
 if(cmd==='get_app_info')return {version:'0.1.0',platform:'windows',running:false};
 if(cmd==='svn_info')return {root,url:'file:///QA/NC/module',revision:8,host:'',user:'qa',hasPassword:true,credentialSource:'saved',bridgeAlive:true};
 if(cmd==='req_state' || cmd==='req_prune')return {reqs:[],current:null,files:[],journal:{dir:null,found:false,lastAtMs:0,more:false}};
 if(cmd==='review_blocks_marks')return [];
 if(cmd==='svn_status') {const items=entries.filter(e=>!window.svnSubmitted.includes(e.path) && !(window.svnMerged && e.letter==='C'));return {changes:{groups:[{module:'module',items}],shown:items.length,total:items.length,ignored:0},scanned:100,generatedAtMs:Date.now(),hasConflict:!window.svnMerged,reviewed:[]};}
 if(cmd==='svn_diff') {if(args.path===window.svnDelayPath)await new Promise(resolve=>window.svnPending.push(resolve));return {baseText:text.replace('save();','oldSave();'),workingText:args.path.endsWith('Deleted.java')?'':text,encoding:'UTF-8',eol:'LF',baseEmpty:args.path.endsWith('New.java'),baseSize:50,workingSize:50,editable:true};}
 if(cmd==='svn_review_mark')return null;
 if(cmd==='svn_commit') {window.svnSubmitted.push(...args.paths);return {revision:12,author:'qa',added:[]};}
 if(cmd==='svn_history')return {repositoryPath:args.path===root?'/':'/module/src/A.java',entries:[{revision:12,author:'qa',date:Date.now(),message:'保存流程修复\n核对日期绑定',paths:[{path:'/module/src/A.java',action:'M',copyFromPath:null,copyFromRevision:-1}]}]};
 if(cmd==='svn_revision_diff')return {path:args.repositoryPath,beforePath:args.repositoryPath,beforeRevision:11,revision:12,beforeEmpty:false,afterEmpty:false,beforeText:text.replace('save();','oldSave();'),afterText:text,beforeEncoding:'UTF-8',afterEncoding:'UTF-8'};
 if(cmd==='svn_blame_snapshot')return {sourceRevision:12,text:'HEAD source only\n',encoding:'UTF-8',lines:[{revision:12,author:'qa',date:Date.now()}]};
 if(cmd==='svn_remote_status')return {revision:12,baseRevision:8,total:1,overlap:1,entries:[{relativePath:'module/src/Conflict.java',repositoryPath:'/module/src/Conflict.java',kind:'modified',baseRevision:8,directory:false,overlap:true}]};
 if(cmd==='svn_update') {window.svnUpdated=true;return {revision:12,added:0,deleted:0,modified:1,skipped:0};}
 if(cmd==='svn_resolve_working') {window.svnMerged=true;return {backupDir:'C:/qa-backup'};}
 if(cmd==='svn_conflict_snapshot')return {treeConflict:false,propertyConflict:false,textConflict:true,mine:{role:'mine',name:'Conflict.java.mine',revision:-1,binary:false,text:'mine\n',encoding:'UTF-8'},base:{role:'base',name:'Conflict.java.r8',revision:8,binary:false,text:'base\n',encoding:'UTF-8'},theirs:{role:'theirs',name:'Conflict.java.r12',revision:12,binary:false,text:'theirs\n',encoding:'UTF-8'},workingReadable:true,workingHasMarkers:true,...(window.svnUpdated?{workingMtimeMs:42,workingText:'start\n<<<<<<< .mine\nmine\n=======\ntheirs\n>>>>>>> .r12\nend\n'}:{})};
 if(cmd==='patch_defaults')return {workspaceRoot:root,outDir:'C:/qa-output',outDirSource:'suggest',outDirExists:false,outRoot:null,outRootCandidates:[],ncHome:null,ncHomeModules:0};
 if(cmd==='patch_scan')return {root,items:[],problems:[],outRoots:[],javaCount:0,classCount:0,blockedCount:0};
 if(cmd==='tree_projects' || cmd==='fs_list_dir' || cmd==='fs_encoding_marks' || cmd==='workspace_recent' || cmd==='resources_status' || cmd==='local_history_list' || cmd==='db_conn_list')return [];
 if(cmd==='get_autostart')return false;
 if(cmd==='lang_status')return {state:'stopped',module:null,reason:null};
 if(cmd==='server_status')return {state:'stopped',pid:null,port:80,portOpen:false,portOwnedBySelf:false,projectRoot:root,ncHome:null,logPath:'',logSize:0,reason:null,heapMb:4096,defaultHeapMb:4096,debugPort:null};
 if(cmd==='server_log')return {text:'',nextOffset:0};
 if(cmd==='nc_home_probe')return {path:null,valid:false,issues:[]};
 if(cmd==='nc_manifest')return null;
 if(cmd==='db_cached_tables')return {tables:[],fetchedAt:0};
 if(cmd==='db_schema_cache')return null;
 if(cmd.startsWith('plugin:'))return cmd==='plugin:window|is_visible'?true:cmd==='plugin:window|is_maximized'?false:null;
 return null;
},{shouldMockEvents:true});
localStorage.clear();
const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');
const theme=await import('/src/lib/theme.ts'),density=await import('/src/lib/uiDensity.ts');
window.svnTheme=(dark,comfortable)=>{theme.applyTheme(dark?'dark':'light');density.applyUiDensity(comfortable?'comfortable':'standard');};
await import('/src/main.tsx');
`;
test('SVN continuous review, draft, snapshots and 12 layout combinations',async()=>{
 await mkdir(artifacts,{recursive:true});
 const browser=await chromium.launch({headless:true,channel:'msedge'}),page=await browser.newPage({viewport:{width:1440,height:900}});
 page.setDefaultTimeout(15000);const errors=[],errorDetails=[],measurements=[];page.on('pageerror',e=>{errors.push(e.message);errorDetails.push({message:e.message,stack:e.stack});});
 await page.route(origin+'/node_modules/@tauri-apps/api/mocks.js',route=>route.fulfill({
  path:fileURLToPath(new URL('../node_modules/@tauri-apps/api/mocks.js',import.meta.url)),contentType:'text/javascript',
 }));
 await page.route(origin+'/',async route=>{
  const response=await route.fetch({timeout:60000});
  const document=await response.text();
  const entry=/<script type="module"(?: crossorigin)? src="([^"]+)"><\/script>/;
  const source=entry.exec(document)?.[1];
  assert.ok(source,'the workbench module must be present');
  const setup=source.startsWith('/src/')?bootstrap:bootstrap.slice(0,bootstrap.indexOf('const appearance='))
    +'document.documentElement.dataset.uiStyle="glass";'
    +'window.svnTheme=(dark,comfortable)=>{document.documentElement.classList.toggle("dark",dark);document.documentElement.dataset.uiDensity=comfortable?"comfortable":"standard";};'
    +'await import('+JSON.stringify(source)+');';
  await route.fulfill({response,body:document.replace(entry,()=>'<script type="module">'+setup+'</script>')});
 });
 const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const row=name=>page.locator('[data-file-row]').filter({hasText:name});
 const commit=()=>page.locator('.vc-commit:visible');
 const showFiles=async()=>{if(!await row('A.java').isVisible())await page.getByRole('button',{name:'显示改动清单',exact:true}).click();};
 const closeCommit=async()=>{const close=page.getByRole('button',{name:'收起提交区',exact:true});if(await close.isVisible()){await close.click();await page.locator('.vc-commit:visible').waitFor({state:'hidden'});}};
 try {
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:90000});await page.locator('.app-side').getByRole('button',{name:/^版本/}).click({timeout:45000});
  await row('A.java').click();await page.locator('.monaco-diff-editor').waitFor();
  await page.getByText('第 1 / 1 处',{exact:true}).waitFor();
  await page.setViewportSize({width:1920,height:1020});await settled();
  const standard=await page.locator('.vc-compare-body').boundingBox();assert.ok(standard.height>=760);
  assert.ok((await page.locator('[data-commit-trigger]').boundingBox()).x<1800);
  const editor=await page.locator('.vc-compare-host').elementHandle();
  const side=await page.locator('.wb-tree').boundingBox();
  await page.getByRole('button',{name:'显示设置',exact:true}).click();
  await page.getByRole('checkbox',{name:'折叠长段未修改代码',exact:true}).uncheck();
  await page.keyboard.press('Escape');
  assert.equal(await editor.evaluate(el=>el===document.querySelector('.vc-compare-host')),true);
  await page.getByRole('button',{name:'专注对比',exact:true}).click();await settled();
  const focus=await page.locator('.vc-compare-body').boundingBox();assert.ok(focus.height>standard.height,JSON.stringify({standard,focus}));assert.ok(focus.width>standard.width);
  assert.equal(await page.locator('.wb-toolbar').isVisible(),false);
  assert.equal(await editor.evaluate(el=>el===document.querySelector('.vc-compare-host')),true);
  await page.screenshot({path:fileURLToPath(new URL('专注对比-1920.png',artifacts))});
  await page.getByRole('button',{name:/^切换文件/}).click();await page.getByRole('textbox',{name:'搜索审查文件',exact:true}).fill('B.java');
  await page.getByRole('menuitemcheckbox',{name:'module/src/B.java',exact:true}).click();
  await page.locator('.vc-diff-file').getByText('B.java',{exact:true}).waitFor();
  await page.getByRole('button',{name:'退出专注对比',exact:true}).click();await settled();
  assert.equal(Math.round((await page.locator('.wb-tree').boundingBox()).width),Math.round(side.width));
  await row('A.java').click();await settled();
  await page.screenshot({path:fileURLToPath(new URL('标准审查-1920.png',artifacts))});
  measurements.push({standardHeight:standard.height,focusHeight:focus.height,standardWidth:standard.width,focusWidth:focus.width});
  await page.locator('[data-commit-trigger]').click();await commit().waitFor();await commit().getByRole('textbox',{name:'提交说明',exact:true}).fill('修复保存流程');
  await closeCommit();await row('B.java').click();await page.locator('[data-commit-trigger]').click();assert.equal(await commit().getByRole('textbox',{name:'提交说明',exact:true}).inputValue(),'修复保存流程');
  await closeCommit();
  for(const width of process.env.SVN_QA_DIAGNOSTIC ? [1280] : [1280,1024,560])for(const dark of process.env.SVN_QA_DIAGNOSTIC ? [false] : [false,true])for(const comfortable of process.env.SVN_QA_DIAGNOSTIC ? [false] : [false,true]){
   await page.setViewportSize({width,height:900});await page.evaluate(({dark,comfortable})=>window.svnTheme(dark,comfortable),{dark,comfortable});
   await page.waitForFunction(()=>!document.documentElement.classList.contains('theme-transition'));await showFiles();await row('A.java').click();await settled();
   await page.screenshot({path:fileURLToPath(new URL(`review-${width}-${dark?'dark':'light'}-${comfortable?'comfortable':'standard'}.png`,artifacts))});
   await page.locator('[data-commit-trigger]').click();await commit().waitFor();await settled();
   const m=await page.evaluate(()=>{const header=document.querySelector('.vc-head'),panel=[...document.querySelectorAll('.vc-commit')].find(e=>e.getBoundingClientRect().width>0);const r=panel.getBoundingClientRect(),commit=document.querySelector('[data-commit-trigger]').getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,toolbarOverflow:header.scrollWidth>header.clientWidth+1,commitRight:commit.right,panelLeft:r.left,panelRight:r.right,diffCount:document.querySelectorAll('.monaco-diff-editor').length};});
   measurements.push({...m,dark,comfortable});assert.equal(m.overflow,false);assert.equal(m.toolbarOverflow,false);assert.ok(m.commitRight<=width);assert.ok(m.panelLeft>=0 && m.panelRight<=width);assert.equal(m.diffCount,1);
   await page.screenshot({path:fileURLToPath(new URL(`commit-${width}-${dark?'dark':'light'}-${comfortable?'comfortable':'standard'}.png`,artifacts))});await closeCommit();
  }
  await page.setViewportSize({width:1280,height:900});await showFiles();await row('A.java').click();await page.getByRole('button',{name:'当前文件更多操作',exact:true}).click();await page.getByRole('menuitem',{name:'逐行追溯',exact:true}).click();await page.getByText('正文与作者：r12',{exact:true}).waitFor();assert.ok((await page.locator('.vc-blame').innerText()).includes('HEAD source only'));assert.equal(await page.locator('.vc-blame').getByText('save();',{exact:true}).count(),0);
  await page.screenshot({path:fileURLToPath(new URL('blame-source.png',artifacts))});await page.getByRole('button',{name:'返回差异',exact:true}).click();
  await page.getByRole('button',{name:'当前文件更多操作',exact:true}).click();await page.getByRole('menuitem',{name:'历史',exact:true}).click();await page.locator('.vc-history-record').first().click();await page.locator('.vc-history-detail .monaco-diff-editor').waitFor();await page.screenshot({path:fileURLToPath(new URL('history-revision.png',artifacts))});
  await showFiles();await row('Conflict.java').click();await page.getByText('Conflict.java.r12',{exact:false}).first().waitFor();await page.screenshot({path:fileURLToPath(new URL('conflict-versions.png',artifacts))});
  await row('A.java').click();await page.locator('[data-commit-trigger]').click();await commit().getByRole('button',{name:'清空',exact:true}).click();await commit().getByRole('button',{name:'全选',exact:true}).click();await commit().getByRole('textbox',{name:'提交说明',exact:true}).fill('修复保存流程');await commit().getByRole('button',{name:/^提交 \d+ 个文件$/}).click();await page.getByText('已提交 r12',{exact:true}).waitFor();
  const calls=await page.evaluate(()=>window.svnCommands.filter(c=>c.cmd==='svn_commit'));assert.equal(calls.length,1);assert.equal(calls[0].args.expectedRoot,'C:/svn-acceptance');assert.equal(calls[0].args.paths.some(p=>p.endsWith('Conflict.java')),false);
  await page.getByRole('button',{name:'查看 r12',exact:true}).click();
  await page.getByRole('button',{name:'预览 NC 补丁',exact:true}).click();
  await page.getByRole('complementary',{name:'NC 补丁预览',exact:true}).getByText('A.java',{exact:true}).waitFor();
  await page.getByRole('button',{name:'远端更新',exact:true}).click();
  await page.locator('.vc-remote-tools').getByRole('button',{name:'检查远端',exact:true}).click();
  await page.getByRole('button',{name:'准备更新',exact:true}).click();
  await page.getByRole('complementary',{name:'确认更新',exact:true}).getByRole('button',{name:'更新工作副本',exact:true}).click();
  await page.getByRole('button',{name:'处理冲突',exact:true}).click();
  await page.getByRole('button',{name:'本处保留双方',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'合并结果',exact:true}).inputValue(),'start\nmine\ntheirs\nend\n');
  await page.getByRole('button',{name:'保存并标为已解决',exact:true}).click();
  await page.waitForFunction(()=>window.svnMerged);
  const updateCalls=await page.evaluate(()=>window.svnCommands.filter(c=>c.cmd==='svn_update'));
  assert.equal(updateCalls.length,1);assert.equal(updateCalls[0].args.revision,12);
  await page.getByRole('button',{name:'需求审查与补丁',exact:true}).click();
  await page.getByRole('menuitemcheckbox',{name:'打包补丁',exact:true}).click();
  const outputDir=page.getByRole('textbox',{name:'补丁输出目录',exact:true});
  await outputDir.fill('C:/qa-next');await outputDir.press('Tab');
  await page.getByText('输出目录未保存',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:/^生成补丁包/}).isDisabled(),true);
  const buildBounds=await page.getByRole('button',{name:/^生成补丁包/}).boundingBox();assert.ok(buildBounds && buildBounds.y+buildBounds.height<900);
  assert.equal((await page.evaluate(()=>window.svnCommands.filter(c=>c.cmd==='patch_set_out_dir'))).length,0);
  await page.screenshot({path:fileURLToPath(new URL('补丁目录草稿.png',artifacts))});
  await outputDir.press('Escape');assert.equal(await outputDir.inputValue(),'C:/qa-output');
  await page.evaluate(()=>window.dispatchEvent(new window.CustomEvent('ncforge-navigate',{detail:'logs'})));
  await page.locator('.lg-row').first().click();await page.locator('.lg-msg').waitFor();
  await page.setViewportSize({width:1920,height:1020});await settled();
  const logHeight=(await page.locator('.lg-head-wrap').boundingBox()).height;assert.ok(logHeight<=56);
  await page.getByRole('textbox',{name:'日志检索关键词',exact:true}).fill('save');await page.getByRole('button',{name:'检索',exact:true}).click();
  await page.getByRole('button',{name:'清除',exact:true}).waitFor();assert.equal(await page.locator('.lg-search-info').count(),0);
  await page.screenshot({path:fileURLToPath(new URL('日志内容优先.png',artifacts))});
  await page.setViewportSize({width:560,height:900});await settled();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  measurements.push({logHeaderHeight:logHeight,logNarrowOverflow:false});
  await page.evaluate(()=>window.dispatchEvent(new window.CustomEvent('ncforge-navigate',{detail:'settings'})));
  await page.getByRole('heading',{name:'外观与启动',exact:true}).waitFor();assert.equal(await page.locator('.wb-document-surface>.wb-doc-tabs').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);await writeFile(new URL('measurements.json',artifacts),JSON.stringify({measurements,errors,commitCalls:calls.length},null,2));
 }catch(error){await writeFile(new URL('failure.json',artifacts),JSON.stringify({error:String(error),errors,errorDetails,body:await page.locator('body').innerText(),commands:await page.evaluate(()=>window.svnCommands)},null,2));await page.screenshot({path:fileURLToPath(new URL('failure.png',artifacts))});throw error;}finally{await browser.close();}
});
