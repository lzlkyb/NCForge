// Packaged WebView frontend under its CSP, memory-only IPC. No workspace/database writes.
/* global document, window, performance, requestAnimationFrame, PerformanceObserver */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const phase = process.argv[2] ?? 'after';
assert.ok(['before', 'after'].includes(phase));
const dist = new URL(process.env.NCFORGE_PERF_DIST ?? '../dist/', import.meta.url);
const artifacts = new URL(process.env.NCFORGE_PERF_ARTIFACTS ?? '../../docs/smoothness-20261119/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const html = await readFile(new URL('index.html', dist), 'utf8');
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1];
const db = await readFile(new URL('db-workbench-acceptance.test.mjs', import.meta.url), 'utf8');
const material = await readFile(new URL('material-workbench-acceptance.mjs', import.meta.url), 'utf8');
const raw = db.match(/const bootstrap=`([\s\S]*?)`;/)?.[1];
const memory = material.match(/\.replace\('mockIPC\(\(cmd,args\)=>\{', `([\s\S]*?)`\)/)?.[1];
assert.ok(entry && raw && memory);
const bootstrap = raw.replace('/node_modules/@tauri-apps/api/mocks.js', '/mocks.js')
  .replace('mockIPC((cmd,args)=>{', memory.replace('mockIPC((cmd,args)=>{', `
const files=['Demo.java',...Array.from({length:29},(_,i)=>'File'+String(i).padStart(2,'0')+'.java')];
const source=base=>'public class Demo {\\n'+Array.from({length:1600},(_,i)=>'    // line '+i+(i%500===0?(base?' BASE':' edited'):'')).join('\\n')+'\\n}';
localStorage.setItem('ncforge-open-tabs',JSON.stringify({[fixtureRoot.toLowerCase()]:{tabs:files.map(n=>fixtureRoot+sep+n),activePath:fixtureFile,splitPath:null}}));
localStorage.setItem('ncforge.ui-style','classic');localStorage.setItem('ncforge.ui-density','standard');
localStorage.setItem('ncforge-rail-expanded','0');
window.smoothIPC={};
mockIPC((cmd,args)=>{
 window.smoothIPC[cmd]=(window.smoothIPC[cmd]||0)+1;
 if(cmd==='fs_list_dir')return Array.from({length:3000},(_,i)=>({name:i<files.length?files[i]:'Other'+String(i).padStart(4,'0')+'.java',isDir:false,size:40000}));
 if(cmd==='fs_read_file')return {text:source(false),encoding:'UTF-8',hasBom:false,eol:'LF',lossless:true,size:40000,mtimeMs:1};
 if(cmd==='svn_diff')return {path:args.path,baseText:source(true),workingText:source(false),eol:'LF',encoding:'UTF-8',binary:false};
`))
  .replace('workspace_root:null', 'workspace_root:fixtureRoot')
  .replace("if(cmd==='get_autostart')", "if(cmd==='bmf_index_scan')return {entries:[],elapsedMs:0,cached:0,warnings:[]};if(cmd==='db_slot_acquire')return {slot:'smoothness',tx:tx()};if(cmd==='get_autostart')")
  .replace("if(cmd==='db_exec_bound')", "if(['db_exec','db_exec_result','db_exec_bound'].includes(cmd))")
  .replace('ms:10,tx:tx()', 'ms:10,output:[],tx:tx()')
  .replace("throw Error('DB acceptance IPC not configured: '+cmd);", 'return null;')
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'select * from TEST_TABLE;',maxRows:500,timeoutSec:30}")
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", '')
  .replace('/src/main.tsx', entry);
assert.ok(!bootstrap.includes('/src/'));
const mocks = await readFile(new URL('../node_modules/@tauri-apps/api/mocks.js', import.meta.url));
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash('sha256').update(m[1]).digest('base64') + "'");
const csp = config.app.security.csp.replace(/script-src ([^;]+)/, (_, v) => 'script-src ' + v + ' ' + hashes.join(' '));
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Security-Policy', csp);
      res.end(html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/fixture.js"></script>'));
    } else if (path === '/fixture.js' || path === '/mocks.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(path === '/fixture.js' ? bootstrap : mocks);
    } else if (/^\/(assets|fonts)\/[\w/.-]+$/.test(path) || path === '/icon.png') {
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      res.end(await readFile(new URL(path.slice(1), dist)));
    } else { res.writeHead(404); res.end(); }
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const percentile = (list, p) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.ceil(list.length * p) - 1)];
let browser, page;
const errors = [], samples = [], retention = {}, memorySamples = [];
let typing = [], menus = [];
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--js-flags=--expose-gc'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('.wb-tab').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.wb-editor-group-slot .wb-tab').length === 20);
  const tab = name => page.locator('.wb-editor-group-slot .wb-tab').filter({ has: page.locator('.wb-tab-name', { hasText: name }) }).first();
  for (let i = 19; i < 29; i++) {
    const name = 'File' + String(i).padStart(2, '0') + '.java';
    await page.locator('[data-file][aria-label="' + name + '"]').click();
    await tab(name).waitFor(); await tab(name).dblclick();
  }
  // Deferred startup tabs are hydrated once before measuring cached file switching.
  for (const name of ['File00.java', 'File01.java', 'Demo.java']) {
    await tab(name).click();
    await page.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.textContent?.includes('class'));
    await page.waitForTimeout(180);
  }
  const measure = async (kind, locator, name) => {
    const result = await locator.evaluate(async (button, { kind, name }) => {
      const tasks = []; let committed = false;
      const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => e.duration)));
      observer.observe({ type: 'longtask', buffered: false });
      const start = performance.now();
      button.click();
      const ready = () => kind === 'file'
        ? button.getAttribute('aria-selected') === 'true' && !!document.querySelector('.monaco-editor .view-lines')?.textContent
        : document.querySelector('.wb-root')?.getAttribute('data-tool') === name && !!document.querySelector('#wb-document-surface:not([hidden]),#wb-code-surface:not([hidden])');
      while (!ready() && performance.now() - start < 5000) await new Promise(requestAnimationFrame);
      committed = ready();
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const ms = performance.now() - start;
      observer.disconnect();
      return { ms, committed, longTasks: tasks.length, maxTask: Math.max(0, ...tasks) };
    }, { kind, name });
    assert.ok(result.committed, kind + ':' + name + ' must display destination');
    samples.push({ kind, name, ...result });
  };
  const trace = process.argv.includes('--trace') ? await page.context().newCDPSession(page) : null;
  const events = [];
  if (trace) { trace.on('Tracing.dataCollected', ({ value }) => events.push(...value)); await trace.send('Tracing.start', { categories: 'devtools.timeline,v8.execute', transferMode: 'ReportEvents' }); }
  const warmReads = await page.evaluate(() => window.smoothIPC.fs_read_file);
  for (let i = 0; i < 30; i++) for (const name of ['File00.java', 'File01.java', 'Demo.java']) await measure('file', tab(name), name);
  assert.equal(await page.evaluate(() => window.smoothIPC.fs_read_file), warmReads, 'cached switching must not read files again');
  const pages = [['db', '数据库'], ['svn', '版本控制'], ['meta', '元数据'], ['logs', '日志排查'], ['settings', '设置'], ['files', '代码']];
  const rail = label => page.locator('.app-side').getByRole('button', { name: new RegExp('^' + label) });
  for (const [key, label] of pages) {
    await rail(label).click();
    await page.locator('.wb-root[data-tool="' + key + '"]').waitFor();
    await page.waitForTimeout(350);
  }
  const inspector = await page.context().newCDPSession(page);
  const collectMemory = async () => {
    await page.waitForTimeout(400);
    await inspector.send('HeapProfiler.collectGarbage');
    memorySamples.push({ ...await inspector.send('Memory.getDOMCounters'), heapUsedBytes: (await inspector.send('Runtime.getHeapUsage')).usedSize });
  };
  await collectMemory();
  for (let round = 0; round < 10; round++) for (const [key, label] of pages) await measure('page', rail(label), key);
  if (trace) {
    const complete = new Promise(resolve => trace.once('Tracing.tracingComplete', resolve)); await trace.send('Tracing.end'); await complete;
    await writeFile(new URL(phase + '-trace.json', artifacts), JSON.stringify({ traceEvents: events }));
  }
  await collectMemory();
  retention.tabs = await page.locator('.wb-editor-group-slot .wb-tab').count(); assert.equal(retention.tabs, 30);
  // Editors must remain the same DOM instance across tool navigation.
  await page.locator('.monaco-editor').first().evaluate(el => { window.retainedEditor = el; });
  await rail('设置').click(); await rail('代码').click();
  retention.editor = await page.evaluate(() => window.retainedEditor === document.querySelector('.monaco-editor'));
  assert.equal(retention.editor, true);
  const sql = page.getByRole('textbox', { name: 'SQL 查询编辑器', exact: true });
  await rail('数据库').click(); await sql.focus(); await page.keyboard.press('Control+A'); await page.keyboard.type('select 42 as preserved_draft');
  await rail('设置').click(); await rail('数据库').click(); assert.equal(await sql.inputValue(), 'select 42 as preserved_draft'); retention.sqlDraft = true;
  await rail('代码').click();
  await tab('Demo.java').click();
  const codeInput = page.locator('.wb-editor-group-slot .monaco-editor textarea').first();
  await codeInput.focus(); await page.keyboard.press('Control+End');
  await page.evaluate(() => {
    window.smoothTyping = [];
    window.smoothKeydown = event => {
      if (event.key.length !== 1 || event.ctrlKey || event.altKey) return;
      const start = performance.now();
      requestAnimationFrame(() => setTimeout(() => window.smoothTyping.push(performance.now() - start), 0));
    };
    document.addEventListener('keydown', window.smoothKeydown, true);
  });
  // 20 keys/second is sustained fast typing; bulk insertion is a separate workload from input echo.
  await page.keyboard.type('// smoothness_preserved_draft', { delay: 50 });
  const visibleCode = async () => (await page.locator('.wb-editor-group-slot .monaco-editor .view-lines').allTextContents()).join('\n');
  const waitDraft = () => page.waitForFunction(() => [...document.querySelectorAll('.wb-editor-group-slot .monaco-editor .view-lines')].some(el => el.textContent.includes('smoothness_preserved_draft')));
  await waitDraft(); assert.match(await visibleCode(), /smoothness_preserved_draft/);
  typing = await page.evaluate(() => { document.removeEventListener('keydown', window.smoothKeydown, true); return window.smoothTyping; });
  await tab('File00.java').click(); await tab('Demo.java').click();
  await rail('设置').click(); await rail('代码').click();
  await waitDraft(); assert.match(await visibleCode(), /smoothness_preserved_draft/); retention.codeDraftAndView = true;
  await codeInput.focus(); await page.keyboard.press('Control+z');
  await page.waitForFunction(() => [...document.querySelectorAll('.wb-editor-group-slot .monaco-editor .view-lines')].every(el => !el.textContent.includes('smoothness_preserved_draft')));
  assert.doesNotMatch(await visibleCode(), /smoothness_preserved_draft/); retention.undo = true;
  for (let i = 0; i < 5 && (await tab('Demo.java').locator('.wb-tab-x').getAttribute('title')).includes('有未保存'); i++) {
    await codeInput.focus(); await page.keyboard.press('Control+z');
  }
  await page.waitForFunction(() => !document.querySelector('.wb-editor-group-slot .wb-tab[data-active] .wb-tab-x')?.getAttribute('title')?.includes('有未保存'));
  retention.undoToSaved = true;
  for (let i = 0; i < 10; i++) {
    menus.push(await page.getByRole('button', { name: '编辑器布局', exact: true }).evaluate(async button => {
      const start = performance.now(); button.click();
      while (!document.querySelector('[role="menu"]') && performance.now() - start < 1000) await new Promise(requestAnimationFrame);
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      return performance.now() - start;
    }));
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });
  }
  const summary = {};
  for (const kind of ['file', 'page']) {
    const selected = samples.filter(s => s.kind === kind), times = selected.map(s => s.ms);
    summary[kind] = { n: times.length, p50: percentile(times, .5), p95: percentile(times, .95), max: Math.max(...times), longTasks: selected.reduce((n, s) => n + s.longTasks, 0) };
  }
  for (const [kind, times] of [['typing', typing], ['menu', menus]]) {
    assert.ok(times.length > 0, kind + ' has samples');
    summary[kind] = { n: times.length, p50: percentile(times, .5), p95: percentile(times, .95), max: Math.max(...times) };
  }
  const ipc = await page.evaluate(() => window.smoothIPC);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: fileURLToPath(new URL(phase + '.png', artifacts)) });
  await writeFile(new URL(phase + '.json', artifacts), JSON.stringify({ phase, entry, environment: { browser: browser.version(), platform: process.platform, node: process.version }, fixture: { files: 3000, tabs: 30, lines: 1602 }, summary, samples, retention, memorySamples, ipc, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ phase, summary, retention, memorySamples, errors }));
  if (phase === 'after') {
    for (const [kind, limit] of [['file', 100], ['page', 150], ['typing', 50], ['menu', 100]]) {
      assert.ok(summary[kind].p95 <= limit, `${kind} p95 ${summary[kind].p95.toFixed(1)}ms exceeds ${limit}ms`);
    }
    for (const counter of ['documents', 'nodes', 'jsEventListeners']) {
      assert.equal(memorySamples[1][counter], memorySamples[0][counter], `${counter} must remain stable across retained page switches`);
    }
  }
} catch (e) {
  if (page) console.error((await page.locator('body').innerText()).slice(0, 1800));
  throw e;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
