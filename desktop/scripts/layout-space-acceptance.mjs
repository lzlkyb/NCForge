// Render the production frontend with memory-only IPC. No NC service, file or database is changed.
/* global window, document, innerWidth, getComputedStyle, CustomEvent, localStorage */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import ts from 'typescript';
import { serviceFixture } from './service-console-fixture.mjs';
import { codeFixture } from './code-workbench-fixture.mjs';

const phase = process.argv.includes('--baseline') ? 'before' : 'after';
const dist = new URL('../dist/', import.meta.url);
const artifacts = new URL('../../docs/页面布局精简验收-2026-11-07/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const html = await readFile(new URL('index.html', dist), 'utf8');
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
assert.ok(entry);
const fixtures = ts.transpileModule(await readFile(new URL('../src/test/metaFixtures.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { metaDetail, metaEntity, metaAttr, metaEntry } = await import('data:text/javascript;base64,' + Buffer.from(fixtures).toString('base64'));
const model = metaDetail('expense', { entities: [
  metaEntity('head', Array.from({ length: 80 }, (_, i) => metaAttr('field' + i, 'field' + i, { displayName: ['单据编码', '业务日期', '业务金额', '业务部门'][i % 4] + i })), { displayName: '费用报销单' }),
  metaEntity('body', [metaAttr('item')], { displayName: '费用明细' }),
], relations: [], issues: [] });
const fixture = [
  'const layoutModel=' + JSON.stringify(model) + ';',
  'const layoutEntry=' + JSON.stringify(metaEntry('expense', { displayName: '费用报销组件', attrCount: 81 })) + ';',
  "const layoutChanges=Object.keys(window.codeFiles).map((name,i)=>({path:serviceRoot+'/'+name,rel:name,module:'demo',letter:'M',status:'modified',revision:8,isDir:false,ignored:false,mtimeMs:1000+i}));",
  'const layoutMock=(cmd,args)=>{',
  "if(cmd==='bmf_index_scan')return {entries:[layoutEntry],roots:[],warnings:[],cached:0,elapsedMs:1};",
  "if(cmd==='bmf_doc_detail')return layoutModel;",
  "if(cmd==='bmf_validate')return [];",
  "if(cmd==='svn_info')return {root:serviceRoot,url:'file:///layout/demo',revision:8,host:'',user:'demo',hasPassword:true,credentialSource:'saved',bridgeAlive:true};",
  "if(cmd==='svn_status')return {changes:{groups:[{module:'demo',items:layoutChanges}],shown:layoutChanges.length,total:layoutChanges.length,ignored:0},scanned:20,generatedAtMs:Date.now(),hasConflict:false,reviewed:[]};",
  "if(cmd==='patch_defaults')return {workspaceRoot:serviceRoot,outDir:'D:/output',outDirSource:'config',outDirExists:true,outRoot:null,outRootCandidates:[],ncHome:'D:/NC',ncHomeModules:20};",
  "if(cmd==='patch_scan')return {root:serviceRoot,items:layoutChanges.map(c=>({path:c.path,rel:c.rel,label:c.rel,module:'demo',section:'private',pkgRel:c.rel,target:'modules/demo/META-INF/classes/nc/bs/demo',layer:{hyext:false,why:'未命中 hyext jar'},classes:[{name:c.rel.replace('.java','.class'),path:c.path.replace('.java','.class'),fresh:true}],problems:[],blocked:false,outRootUsed:'classes'})),problems:[],outRoots:['classes'],javaCount:20,classCount:20,blockedCount:0};",
  'return undefined;};',
].join('\n');
const base = (await readFile(new URL('db-workbench-acceptance.test.mjs', import.meta.url), 'utf8')).match(/const bootstrap=`([\s\S]*?)`;/)[1];
const bootstrap = base.replace('/node_modules/@tauri-apps/api/mocks.js', '/__mocks.js')
  .replace('const tx=', serviceFixture + '\n' + codeFixture + '\n' + fixture + '\nconst tx=')
  .replace(' window.dbCalls.push({cmd,args});', ' window.dbCalls.push({cmd,args});for(const mock of [layoutMock,codeMock,serviceMock]){const result=mock(cmd,args);if(result!==undefined)return result;}')
  .replace('workspace_root:null', 'workspace_root:serviceRoot')
  .replace("throw Error('DB acceptance IPC not configured: '+cmd);", 'return null;')
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", '')
  .replace('/src/main.tsx', entry);
const mocks = await readFile(new URL('../node_modules/@tauri-apps/api/mocks.js', import.meta.url));
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/__fixture.js"></script>')); }
    else if (path === '/__fixture.js' || path === '/__mocks.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(path === '/__fixture.js' ? bootstrap : mocks); }
    else if (/^\/assets\/[\w.-]+$/.test(path) || path === '/icon.png') { response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); response.end(await readFile(new URL(path.slice(1), dist))); }
    else { response.writeHead(404); response.end(); }
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
if (process.argv.includes('--serve')) {
  console.log('Local fixture: http://127.0.0.1:' + server.address().port);
  await new Promise(() => {});
}
const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--disable-gpu'] });
const report = { phase, source: 'production frontend; isolated memory IPC fixtures', windows: [], errors: [] };
try {
  for (const [width, height, theme] of [[1440, 900, 'light'], [1920, 1080, 'light'], [1024, 720, 'light'], [683, 512, 'dark'], [560, 900, 'light'], [1440, 900, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    await context.addInitScript(theme => { localStorage.setItem('theme', theme); localStorage.setItem('ncforge.ui-style', 'classic'); }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message));
    const result = { width, height, theme, regions: {} };
    report.windows.push(result);
    const navigate = tool => page.evaluate(tool => window.dispatchEvent(new CustomEvent('ncforge-navigate', { detail: tool })), tool);
    const measure = async (name, selectors) => {
      result.regions[name] = await page.evaluate(selectors => {
        const regions = {};
        for (const [key, selector] of Object.entries(selectors)) {
          const el = [...document.querySelectorAll(selector)].find(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
          const rect = el?.getBoundingClientRect();
          regions[key] = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        }
        return { ...regions, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
      }, selectors);
      assert.equal(result.regions[name].overflow, false, name + ' page overflow at ' + width);
      if (width === 1440 || width === 560) await page.screenshot({ path: fileURLToPath(new URL(phase + '-' + name + '-' + width + '-' + theme + '.png', artifacts)), animations: 'disabled' });
    };
    try {
      await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'NC 服务', exact: true }).click();
      await page.getByText('已加载 4000 行', { exact: true }).waitFor();
      await measure('services', { body: '.sc-log-pane:not([hidden]) .sc-log-body', navigator: '.sc-services', toolbar: '.sc-run-toolbar' });
      await page.keyboard.press('Control+j');
      await navigate('db');
      await page.locator('#dbx-conn-c').click();
      await page.locator('#dbx-cell-0-1').waitFor();
      await measure('database', { objects: '.dbx-tree', head: '.dbx-side-head' });
      if (phase === 'after') {
        await page.getByRole('button', { name: '查找数据库对象', exact: true }).click();
        await page.getByRole('dialog', { name: '查找数据库对象', exact: true }).waitFor();
        await page.keyboard.press('Escape');
      }
      await navigate('meta');
      await page.getByRole('button', { name: '打开元数据资源', exact: true }).click();
      await page.locator('.meta-entry').filter({ hasText: '费用报销组件' }).click();
      await page.getByRole('group', { name: '元数据工作模式' }).getByRole('button', { name: '字段', exact: true }).click();
      await page.locator('.meta-field-table [data-attr="field0"]').waitFor();
      await measure('metadata', { fields: '.meta-field-scroll', toolbar: '.meta-fields-head', main: '.meta-main' });
      if (phase === 'after') {
        await page.getByRole('button', { name: '进入元数据专注模式', exact: true }).click();
        await measure('metadata-focus', { fields: '.meta-field-scroll', main: '.meta-main' });
        await page.getByRole('button', { name: '退出元数据专注模式', exact: true }).click();
        const entity = page.getByRole('combobox', { name: '当前实体', exact: true });
        await entity.selectOption('body');
        await page.locator('.meta-field-table [data-attr="item"]').waitFor();
        await entity.selectOption('head');
      }
      await navigate('settings');
      await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '编辑器', exact: true }).click();
      await measure('settings', { page: '[data-settings-section="编辑器"]', firstRow: '[data-settings-section="编辑器"] .srow', body: '.wb-settings-body' });
      await navigate('patch');
      await page.locator('.pk-list').getByText('A.java', { exact: true }).click();
      await page.locator('.pk-detail').waitFor();
      await measure('patch', { tree: '.pk-tree', detail: '.pk-detail', stage: '.pk-stage' });
      if (phase === 'after') {
        await page.locator('.pk-detail summary').click();
        await page.locator('.pk-detail').getByRole('button', { name: '标准层', exact: true }).waitFor();
        await page.locator('.pk-detail summary').click();
      }
      console.log(phase, width + 'x' + height, theme, 'passed');
    } catch (error) {
      await page.screenshot({ path: fileURLToPath(new URL(phase + '-failure.png', artifacts)) });
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(new URL(phase + '.json', artifacts), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
