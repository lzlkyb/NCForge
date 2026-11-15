// Exercise packaged frontend assets under the application's CSP, with memory-only IPC.
/* global window, document, localStorage, getComputedStyle, innerWidth, CustomEvent */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dist = new URL('../dist/', import.meta.url);
const artifacts = new URL('../../docs/工作台材质升级验收-2026-11-13/', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
assert.ok(entry, 'Build the frontend before acceptance');
const existing = await readFile(new URL('db-workbench-acceptance.test.mjs', import.meta.url), 'utf8');
const raw = existing.match(/const bootstrap=`([\s\S]*?)`;/)?.[1];
assert.ok(raw, 'The existing database fixture must be available');
const mocks = await readFile(new URL('../node_modules/@tauri-apps/api/mocks.js', import.meta.url));
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const nonce = 'material-workbench-acceptance';
const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");
const csp = config.app.security.csp.replace(/script-src ([^;]+)/, (_, value) => `script-src ${value} ${hashes.join(' ')}`).replace(/style-src ([^;]+)/, (_, value) => `style-src ${value} 'nonce-${nonce}'`);
const bootstrap = raw
  .replace('/node_modules/@tauri-apps/api/mocks.js', '/__tauri_mocks.js')
  .replace('mockIPC((cmd,args)=>{', `const sep=String.fromCharCode(92),fixtureRoot=['D:','material-workspace'].join(sep),fixtureFile=[fixtureRoot,'Demo.java'].join(sep);
localStorage.setItem('ncforge-open-tabs',JSON.stringify({[fixtureRoot.toLowerCase()]:{tabs:[fixtureFile],activePath:fixtureFile,splitPath:null}}));
mockIPC((cmd,args)=>{
 if(cmd==='get_workspace')return fixtureRoot;
 if(cmd==='tree_projects')return [{name:'material-workspace',root:fixtureRoot,origin:'primary',depth:0,exported:true,classDirs:[],disabled:false,hasClasspath:true}];
 if(cmd==='fs_list_dir')return [{name:'Demo.java',isDir:false,size:120}];
 if(cmd==='fs_read_file')return {text:'package demo;'+String.fromCharCode(10)+'public class Demo {'+String.fromCharCode(10)+'    public String name() { return "NCForge"; }'+String.fromCharCode(10)+'}',encoding:'UTF-8',hasBom:false,eol:'LF',lossless:true,size:120,mtimeMs:1};
 if(cmd==='fs_encoding_marks'||cmd==='req_list'||cmd==='req_archive_list')return [];
 if(cmd==='req_state'||cmd==='req_prune')return {reqs:[],current:null,files:[],journal:{dir:null,found:false,lastAtMs:0,more:false}};
 if(cmd==='server_status'||cmd==='client_status')return {state:'stopped',runId:null,pid:null,startedAtMs:null,uptimeMs:null,port:80,host:'localhost',serverReachable:false,portAddress:'127.0.0.1',portFromConfig:false,portConfigPath:'prop.xml',portOwner:null,portOwnedBySelf:false,logPath:'server.log',logSize:0,java:null,classpathEntries:0,mainClass:'nc.starter.test.JStarter',commandLine:'',exitCode:null,reason:null,projectRoot:fixtureRoot,ncHome:null,heapMb:4096,defaultHeapMb:4096,debugPort:null};
 if(cmd==='server_log'||cmd==='client_log')return {text:'',offset:0};
 if(cmd==='service_log_tail'||cmd==='service_log_read')return {text:'',startOffset:0,offset:0,fileId:'material-log',size:0,eof:true,reset:false,truncated:false,lineOffsets:[]};
 if(cmd==='svn_info')return {root:fixtureRoot,url:'https://example.invalid/svn/material-workspace',revision:74,host:'example.invalid',user:'fixture',hasPassword:false,credentialSource:'none',bridgeAlive:true};
 if(cmd==='svn_status')return {changes:{groups:[],shown:0,total:0,ignored:0},scanned:1,generatedAtMs:Date.now(),hasConflict:false,reviewed:[],incremental:false,modulesScanned:1,epoch:1};
 if(cmd==='nc_log_sources')return {home:fixtureRoot,configPath:'logger-config.properties',fromConfig:true,serverDir:'server',loggers:[{name:'warningsql',level:'WARN',files:[],newestMs:0,totalSize:0}],logsRoot:fixtureRoot};
 if(cmd==='nc_log_query')return {entries:[{logger:'warningsql',file:'warningsql.log',lineNo:12,ts:'2026-11-13 20:00:00',callId:null,thread:'main',userId:null,remoteCall:null,level:'WARN',msg:'select * from TEST_TABLE',stack:[],stackTruncated:false,costMs:1500,rowCount:3,verdict:{rule:'slow-sql',severity:'slow',title:'查询耗时 1500ms',cause:'示例查询',action:'检查执行计划',jump:null}}],scannedFiles:['warningsql.log'],recordsScanned:1,truncatedFiles:0,stoppedEarly:false,elapsedMs:2,slowThresholdMs:1000};`)
  .replace('workspace_root:null', 'workspace_root:fixtureRoot')
  .replace("mockWindows('main');", "mockWindows('main');window.materialViolations=[];document.addEventListener('securitypolicyviolation',e=>window.materialViolations.push(e.effectiveDirective));")
  .replace("if(cmd==='get_autostart')", "if(cmd==='bmf_index_scan')return {entries:[],elapsedMs:0,cached:0,warnings:[]};if(cmd==='db_slot_acquire')return {slot:'material-slot',tx:tx()};if(cmd==='get_autostart')")
  .replace("if(cmd==='db_exec_bound')", "if(['db_exec','db_exec_result','db_exec_bound'].includes(cmd))")
  .replace("ms:10,tx:tx()", "ms:10,output:[],tx:tx()")
  .replace("throw Error('DB acceptance IPC not configured: '+cmd);", 'return null;')
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'select * from TEST_TABLE;',maxRows:500,timeoutSec:60}")
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", "localStorage.setItem('ncforge-db-result-height','310');")
  .replace('/src/main.tsx', entry);
assert.ok(!bootstrap.includes('/src/'), 'Acceptance cannot fall back to development modules');
await mkdir(artifacts, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Security-Policy', csp);
      res.end(html.replace(/<style>/g, `<style nonce="${nonce}">`).replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/__fixture.js"></script>'));
    } else if (path === '/__fixture.js' || path === '/__tauri_mocks.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(path === '/__fixture.js' ? bootstrap : mocks);
    } else if (/^\/(assets|fonts)\/[\w/.-]+$/.test(path) || path === '/icon.png') {
      res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
      res.end(await readFile(new URL(path.slice(1), dist)));
    } else { res.writeHead(404); res.end(); }
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const errors = [], passed = [], measurements = [];
const check = (condition, label) => { assert.ok(condition, label); passed.push(label); };
const shot = name => page.screenshot({ path: fileURLToPath(new URL(name + '.png', artifacts)), animations: 'disabled' });
const navigate = name => page.locator('.app-side').getByRole('button', { name: new RegExp('^' + name) }).click();
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  for (const theme of ['light', 'dark']) for (const material of ['classic', 'glass']) {
    const label = theme + '-' + material;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(({theme, material}) => {
      localStorage.setItem('theme', theme); localStorage.setItem('ncforge.ui-style', material); localStorage.setItem('ncforge.ui-density', 'standard'); localStorage.setItem('ncforge-rail-expanded', '0');
    }, {theme, material});
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await navigate('数据库'); await page.locator('#dbx-conn-c').click();
    await page.getByRole('textbox', { name: 'SQL 查询编辑器', exact: true }).focus(); await page.keyboard.press('Control+Enter');
    await page.locator('.dbx-gc:not(.rn)').first().waitFor();
    const reading = await page.evaluate(() => {
      const style = selector => getComputedStyle(document.querySelector(selector));
      return { background: style('.wb-main').backgroundColor,
        continuous: ['.dbx-console-body', '.dbx-editor', '.dbx-res', '.dbx-result-head', '.dbx-result-footer'].every(selector => style(selector).backgroundColor === style('.wb-main').backgroundColor && style(selector).boxShadow === 'none'),
        radius: parseFloat(style('.wb-root').borderTopLeftRadius), innerRadius: parseFloat(style('.wb-main').borderTopLeftRadius), row: document.querySelector('.dbx-gc').getBoundingClientRect().height,
        toolbar: document.querySelector('.dbx-command-header').getBoundingClientRect().height, tabs: document.querySelector('.wb-document-surface .wb-tabs').getBoundingClientRect().height };
    });
    measurements.push({ theme, material, reading });
    check(reading.continuous && reading.radius === 14 && reading.innerRadius === 0, `${label} packaged reading surfaces share one outer perimeter`);
    check(reading.row === 26 && reading.toolbar === 40 && reading.tabs === 36, `${label} workbench density is preserved`);
    const split = page.getByRole('separator', { name: '调整结果区高度', exact: true });
    await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement?.blur());
    check(await split.evaluate(el => getComputedStyle(el, '::before').opacity) === '0', `${label} splitter is hidden at rest`);
    const before = await page.locator('.dbx-res').boundingBox(); await split.focus(); await page.keyboard.press('ArrowUp');
    check((await page.locator('.dbx-res').boundingBox()).height > before.height, `${label} keyboard result resizing works`);
    await page.keyboard.press('ArrowDown'); await page.evaluate(() => document.activeElement?.blur());
    await page.locator('.dbx-gc:not(.rn)').first().click();
    check(await page.locator('.dbx-gc[data-active-cell]').evaluate(el => parseFloat(getComputedStyle(el, '::after').borderTopWidth) >= 1), `${label} grid selection remains visible`);
    await shot(label + '-数据库');
    await page.getByRole('button', { name: '更多数据库操作', exact: true }).click(); await page.getByRole('menu').first().waitFor();
    check(await page.getByRole('menu').first().evaluate(el => document.documentElement.dataset.uiStyle === 'glass' ? getComputedStyle(el).backdropFilter.includes('blur') : getComputedStyle(el).backdropFilter === 'none'), `${label} menus use the selected material`);
    await shot(label + '-菜单'); await page.keyboard.press('Escape');
    await navigate('设置'); await page.locator('.wb-settings-page').waitFor();
    await page.locator('.wb-settings-menu button').filter({ hasText: '外观与启动' }).click();
    await page.getByRole('radio', { name: '经典', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.uiStyle === 'classic');
    check(await page.evaluate(() => localStorage.getItem('ncforge.ui-style') === 'classic'), `${label} classic material selection persists`);
    await page.getByRole('radio', { name: '柔光玻璃', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.uiStyle === 'glass');
    check(await page.locator('.wb-settings-body .srow').evaluateAll(rows => rows.every(el => getComputedStyle(el).borderBottomColor === 'rgba(0, 0, 0, 0)')), `${label} settings have no repeated row separators`);
    if (material === 'classic') { await page.getByRole('radio', { name: '经典', exact: true }).click(); await page.waitForFunction(() => document.documentElement.dataset.uiStyle === 'classic'); }
    await shot(label + '-设置');
    await navigate('元数据'); await page.locator('.meta-workbench').waitFor();
    const search = page.getByRole('textbox', { name: '搜索元数据组件', exact: true });
    check(await search.evaluate(el => getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(getComputedStyle(el).borderTopWidth) === 0), `${label} metadata search has one surface`);
    await search.focus(); check(await page.locator('.meta-search').evaluate(el => parseFloat(getComputedStyle(el).outlineWidth) === 2), `${label} metadata search focus remains clear`);
    await page.evaluate(() => document.activeElement?.blur());
    const guidance = await page.locator('.meta-empty-toolbar + div > p').boundingBox();
    const action = await page.getByRole('button', { name: '打开元数据资源', exact: true }).boundingBox();
    check(action.y >= guidance.y + guidance.height && action.y - guidance.y - guidance.height <= 25, `${label} metadata guidance and action are grouped`);
    await shot(label + '-元数据');
    await page.setViewportSize({ width: 560, height: 800 });
    await page.getByRole('button', { name: '打开元数据资源', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '元数据资源', exact: true }); await drawer.waitFor(); await shot(label + '-元数据资源-560');
    await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} narrow metadata drawer works without page overflow`);
    check(await page.evaluate(() => window.materialViolations.length === 0), `${label} packaged CSP has no violations`);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [key, name, selector] of [['files','代码','.wb-code-context'],['svn','版本','.vc-mode'],['logs','日志','.lg-page'],['db','数据库','.dbx-console'],['meta','元数据','.meta-workbench'],['settings','设置','.wb-settings-page']]) {
      if (key === 'logs') await page.evaluate(() => window.dispatchEvent(new CustomEvent('ncforge-navigate', { detail: 'logs' })));
      else await navigate(name);
      await page.locator('.wb-root[data-tool="' + key + '"]').waitFor(); await page.locator(selector).waitFor();
      if (key === 'files') await page.locator('.wb-code-body .monaco-editor').waitFor();
      if(['files','svn','db','settings'].includes(key)&&!await page.locator('.wb-tree').isVisible()) {
        await page.getByRole('button',{name:'工作台布局',exact:true}).click();await page.getByRole('menuitem',{name:'资源侧栏',exact:true}).click();
      }
      const shell = await page.evaluate(() => {
        const root=document.querySelector('.wb-root'), outer=root.getBoundingClientRect(), style=getComputedStyle(root);
        const inside=el=>{const r=el.getBoundingClientRect();return r.left>=outer.left-1&&r.right<=outer.right+1&&r.top>=outer.top-1&&r.bottom<=outer.bottom+1;};
        const inner=[...root.querySelectorAll('.wb-tree,.wb-main,.wb-content-frame,.wb-bottom')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');
        return {radius:['TopLeft','TopRight','BottomRight','BottomLeft'].every(corner=>parseFloat(style['border'+corner+'Radius'])===14),shadow:style.boxShadow!=='none',clipped:style.overflow==='hidden'&&!root.contains(document.elementFromPoint(outer.left+1,outer.top+1)),inner:inner.every(el=>inside(el)&&getComputedStyle(el).borderTopLeftRadius==='0px'&&getComputedStyle(el).boxShadow==='none'),status:inside(root.querySelector('.wb-status')),outside:document.querySelector('.app-header').getBoundingClientRect().bottom<=outer.top&&document.querySelector('.app-side').getBoundingClientRect().right<=outer.left,overflow:document.documentElement.scrollWidth>innerWidth};
      });
      measurements.push({theme,material,page:key,shell});
      check(shell.radius&&shell.shadow&&shell.clipped&&shell.inner&&shell.status&&shell.outside&&!shell.overflow, `${label} ${key} resources, document and status share one clipped shell`);
      if(key==='logs')check(await page.locator('.lg-left').evaluate(el=>getComputedStyle(el).borderRightColor==='rgba(0, 0, 0, 0)'),`${label} log list and detail have no hard vertical seam`);
      if(key==='settings')check(await page.locator('.wb-layout').evaluate(el=>getComputedStyle(el).backgroundColor===getComputedStyle(el.querySelector('.wb-tree')).backgroundColor),`${label} settings splitter blends into the resource surface`);
      await shot(label+'-'+key+'-整体外壳');
      if(key==='files') {
        if(!await page.locator('.wb-bottom').isVisible())await page.getByRole('button',{name:'显示面板',exact:true}).click();
        const bottom=page.locator('.wb-bottom');await bottom.waitFor();
        check(await bottom.evaluate(el=>getComputedStyle(el).borderTopLeftRadius==='0px'&&getComputedStyle(el).boxShadow==='none'&&el.closest('.wb-root')!==null),`${label} code bottom panels belong to the shared shell`);
        await page.getByRole('tab',{name:'编译输出',exact:true}).click();
        const resize=page.getByRole('separator',{name:'调整底部面板高度',exact:true});const height=(await bottom.boundingBox()).height;
        await resize.focus();await page.keyboard.press('ArrowUp');check((await bottom.boundingBox()).height>height,`${label} shared shell keeps keyboard panel resizing`);await page.keyboard.press('ArrowDown');
        await page.locator('.wb-service-entry').click();await page.locator('.sc-panel').waitFor();
        check(await page.locator('.sc-panel').evaluate(el=>el.closest('.wb-root')!==null),`${label} NC service and logs stay in the shared shell`);
        await page.locator('.sc-log-pane:not([hidden]) .sc-log-empty').getByText('尚无控制台输出',{exact:true}).waitFor();
        check(await page.locator('.sc-panel .sc-log-error').count()===0,`${label} service console loads its normal empty state without errors`);
        check(await page.locator('.sc-panel .sc-run-toolbar,.sc-panel .sc-log-toolbar,.sc-panel .sc-log-footer').evaluateAll(elements=>elements.length===5&&elements.every(el=>getComputedStyle(el).borderBottomColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(el).borderTopColor==='rgba(0, 0, 0, 0)')),`${label} service toolbars and footer have no hard horizontal seams`);
        await shot(label+'-服务-整体外壳');
        await page.getByRole('tab',{name:'问题',exact:true}).click();
      }
      if (theme === 'light' && material === 'classic' || theme === 'dark' && material === 'glass') {
        for(const width of [1024,560]) {
          await page.setViewportSize({width,height:800});
          if(await page.getByRole('button',{name:/^关闭(资源侧栏|设置分类)$/,exact:false}).isVisible())await page.getByRole('button',{name:/^关闭(资源侧栏|设置分类)$/,exact:false}).click();
          check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&parseFloat(getComputedStyle(document.querySelector('.wb-root')).borderBottomLeftRadius)===14),`${label} ${key} ${width}px shell stays within the viewport`);
          if(width===560)await shot(label+'-'+key+'-整体外壳-560');
        }
        await page.setViewportSize({width:1440,height:900});
      }
    }
    check(await page.evaluate(()=>window.materialViolations.length===0),`${label} all pages respect packaged CSP`);
    await context.close();
  }
  check(errors.length === 0, 'No page script errors');
  await writeFile(new URL('验收结果.json', artifacts), JSON.stringify({ passed, errors, measurements }, null, 2) + '\n');
  console.log(JSON.stringify({ passed, errors }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) { await shot('失败现场'); console.log(JSON.stringify({ error: error.message, errors, body: (await page.locator('body').innerText()).slice(0, 5000) }, null, 2)); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
