// Production React assets under packaged CSP; all system and business IPC uses local fixtures.
/* global window, document, getComputedStyle, innerWidth, navigator */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dist = new URL('../dist/', import.meta.url);
const artifacts = new URL('../../docs/about-ui-20261105/', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
assert.ok(entry, 'Run npm run vite:build first');
const fixture = await readFile(new URL('db-workbench-acceptance.test.mjs', import.meta.url), 'utf8');
const raw = fixture.match(/const bootstrap=`([\s\S]*?)`;/)?.[1];
assert.ok(raw);
const bootstrap = `
window.cspViolations=[];
document.addEventListener('securitypolicyviolation', e=>window.cspViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));
window.infoMode=new URLSearchParams(location.search).get('info') || 'ready';
localStorage.setItem('ncforge.last_update_check',String(Date.now()));
localStorage.removeItem('shell_last_run_version');
localStorage.setItem('theme',new URLSearchParams(location.search).get('theme') || 'light');
` + raw
  .replace('/node_modules/@tauri-apps/api/mocks.js', '/__tauri_mocks.js')
  .replace("if(cmd==='get_app_info') return {version:'0.1.0',platform:'windows',running:false};", `
    if(cmd==='get_app_info') {
      if(window.infoMode==='error') throw Error('fixture app info unavailable');
      return {version:window.infoMode==='missing' ? undefined : window.infoMode==='other' ? '9.8.7' : '0.1.1',platform:'windows',running:false};
    }
    if(cmd==='open_external') { if(window.linkFail) throw Error('fixture browser unavailable'); return null; }
    if(cmd==='check_update' && window.dbCalls.filter(c=>c.cmd==='check_update').length===1) {
      return window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'update:uptodate',payload:null});
    }
    if(cmd==='check_update') return new Promise(done=>{
      window.finishCheck=async()=>{await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'update:uptodate',payload:null});done();};
    });
  `)
  .replace("const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');", "localStorage.setItem('ncforge.ui-style',new URLSearchParams(location.search).get('style') || 'glass');")
  .replace('/src/main.tsx', entry);
assert.ok(!bootstrap.includes('/src/'), 'Acceptance must never import dev modules');
const mocks = await readFile(new URL('../node_modules/@tauri-apps/api/mocks.js', import.meta.url));
const license = await readFile(new URL('../../LICENSE', import.meta.url), 'utf8');
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const nonce = 'about-acceptance-nonce';
const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash('sha256').update(m[1]).digest('base64') + "'");
const csp = config.app.security.csp
  .replace(/script-src ([^;]+)/, (_, sources) => `script-src ${sources} ${hashes.join(' ')}`)
  .replace(/style-src ([^;]+)/, (_, sources) => `style-src ${sources} 'nonce-${nonce}'`);
const body = html.replace(/<style>/g, `<style nonce="${nonce}">`)
  .replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/__about_fixture.js"></script>');

test('about workflow and responsive production UI under packaged CSP', async () => {
  await mkdir(artifacts, { recursive: true });
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.setHeader('Content-Security-Policy', csp); response.end(body); }
      else if (path === '/__about_fixture.js' || path === '/__tauri_mocks.js') {
        response.setHeader('Content-Type', 'text/javascript'); response.end(path === '/__about_fixture.js' ? bootstrap : mocks);
      } else if (/^\/assets\/[\w.-]+$/.test(path) || path === '/icon.png') {
        response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.png') ? 'image/png' : 'application/octet-stream');
        response.end(await readFile(new URL(path.slice(1), dist)));
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page;
  const errors = [], measurements = [], passed = [];
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 840 }, permissions: ['clipboard-read', 'clipboard-write'] });
    page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    const about = page.locator('.settings-about');
    const history = page.getByRole('dialog', { name: '更新历史', exact: true });
    const navigate = async params => {
      await page.goto(`${origin}/?${params}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.app-side').getByRole('button', { name: /^设置/ }).click();
      await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '关于', exact: true }).click();
      await about.waitFor({ state: 'visible' });
    };
    await navigate('');
    assert.match(await about.locator('#about-version').textContent(), /v0\.1\.1.*Windows/s);
    assert.equal(await about.locator('#about-history-title').textContent(), '本版本更新');
    assert.match(await about.locator('#about-repo').textContent(), /github.com\/lzlkyb\/NCForge/);
    await about.getByRole('button', { name: '复制版本信息', exact: true }).first().click();
    await about.getByRole('status').filter({ hasText: '版本信息已复制' }).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /版本：0.1.1\r?\n平台：Windows/); assert.ok(!copied.includes('D:\\'));
    await page.evaluate(() => { window.linkFail = true; });
    await about.getByRole('button', { name: '打开仓库' }).click();
    await about.getByRole('alert').filter({ hasText: '打开链接失败' }).waitFor();
    await page.evaluate(() => { window.linkFail = false; });
    await about.getByRole('button', { name: '打开仓库' }).click();
    await about.getByRole('status').filter({ hasText: '已交给系统浏览器' }).waitFor();
    const urls = await page.evaluate(() => window.dbCalls.filter(c => c.cmd === 'open_external').map(c => c.args.url));
    assert.deepEqual(urls, ['https://github.com/lzlkyb/NCForge', 'https://github.com/lzlkyb/NCForge']);
    passed.push('Running metadata', 'Clipboard', 'External link failure and recovery');

    await about.getByRole('button', { name: '查看更新历史', exact: true }).click();
    assert.equal(await history.getByLabel('选择更新版本').inputValue(), '0.1.1');
    assert.equal(await history.locator('li').count(), 12);
    await history.getByRole('button', { name: /^展开全部/ }).click();
    assert.ok(await history.locator('li').count() > 12);
    await history.getByRole('button', { name: '修复', exact: true }).click();
    assert.equal(await history.locator('.settings-about-history-group').count(), 1);
    const search = history.getByLabel('搜索更新记录');
    await search.fill('不存在的验收关键词');
    await history.getByRole('status').filter({ hasText: '没有找到相关记录' }).waitFor();
    await search.press('Escape'); assert.equal(await search.inputValue(), ''); assert.ok(await history.isVisible());
    await search.press('Escape'); await history.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '查看更新历史');
    await about.getByRole('button', { name: '查看更新历史', exact: true }).click();
    await history.getByLabel('选择更新版本').selectOption('0.1.0');
    assert.match(await history.locator('.settings-about-history-meta').textContent(), /0.1.0/);
    await history.getByRole('button', { name: '关闭', exact: true }).click(); await history.waitFor({ state: 'hidden' });
    await about.getByRole('button', { name: '查看许可', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'MIT 许可', exact: true });
    assert.equal((await dialog.locator('pre').textContent()).trim(), license.trim());
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '查看许可');
    passed.push('Version choice and pagination', 'Category and search', 'Escape and focus return', 'Authoritative license');

    await about.getByRole('button', { name: '检查更新', exact: true }).click();
    await about.locator('button[data-loading="true"]').waitFor();
    assert.equal(await about.locator('[data-loading="true"]').count(), 1);
    await page.waitForFunction(() => typeof window.finishCheck === 'function');
    await page.evaluate(() => window.finishCheck());
    await about.getByRole('status').filter({ hasText: '当前已是最新版本' }).waitFor();
    const updatePrompt = page.getByRole('dialog').filter({ hasText: '最新' });
    if (await updatePrompt.isVisible()) { await page.keyboard.press('Escape'); await updatePrompt.waitFor({ state: 'hidden' }); }
    passed.push('Update checking feedback');

    await navigate('info=missing');
    await about.getByRole('alert').filter({ hasText: '版本信息不完整' }).waitFor();
    assert.equal(await about.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.infoMode = 'ready'; });
    await about.getByRole('button', { name: '重新读取版本', exact: true }).click();
    await about.locator('.settings-about-name').filter({ hasText: 'v0.1.1' }).waitFor();
    await navigate('info=error');
    await about.getByRole('alert').filter({ hasText: '版本信息读取失败' }).waitFor();
    await page.evaluate(() => { window.infoMode = 'other'; });
    await about.getByRole('button', { name: '重新读取版本', exact: true }).click();
    await about.locator('.settings-about-name').filter({ hasText: 'v9.8.7' }).waitFor();
    assert.equal(await about.locator('#about-history-title').textContent(), '随包更新记录');
    passed.push('Missing and failed metadata recovery', 'Bundled and running versions distinguished');

    for (const [name, width, height, theme, style] of [
      ['production-light', 1280, 840, 'light', 'glass'],
      ['production-dark-low', 1024, 600, 'dark', 'glass'],
      ['production-light-narrow', 560, 700, 'light', 'glass'],
      ['production-dark-narrow', 560, 700, 'dark', 'glass'],
      ['production-classic-narrow', 560, 700, 'light', 'classic'],
      ['production-scale-125', 819, 672, 'light', 'glass'],
    ]) {
      await page.setViewportSize({ width, height });
      await navigate(`theme=${theme}&style=${style}`);
      await page.waitForFunction(({ theme, style }) => document.documentElement.classList.contains('dark') === (theme === 'dark') && document.documentElement.dataset.uiStyle === style, { theme, style });
      const m = await about.evaluate(el => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
        cardOverflow: el.scrollWidth > el.clientWidth + 1,
        font: getComputedStyle(el.querySelector('h2')).fontSize }));
      assert.equal(m.overflow, false, `${name} document overflow`); assert.equal(m.cardOverflow, false, `${name} card overflow`);
      await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, artifacts)) });
      await about.getByRole('button', { name: '查看更新历史', exact: true }).click();
      const modal = await history.evaluate(el => {
        const r = el.getBoundingClientRect(), header = el.querySelector('header').getBoundingClientRect(), footer = el.querySelector('footer').getBoundingClientRect();
        const content = el.querySelector('.settings-about-history-body');
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, bodyHeight: content.clientHeight,
          bodyOverflow: content.scrollWidth > content.clientWidth + 1, headerBottom: header.bottom, footerTop: footer.top };
      });
      assert.ok(modal.left >= 0 && modal.right <= width + 1 && modal.top >= 0 && modal.bottom <= height + 1, `${name} dialog visible`);
      assert.ok(modal.bodyHeight >= 100, `${name} readable content`); assert.equal(modal.bodyOverflow, false, `${name} reading overflow`);
      await history.getByRole('button', { name: '关闭', exact: true }).focus(); await page.keyboard.press('Tab');
      assert.equal(await history.getByRole('button', { name: '关闭更新历史', exact: true }).evaluate(el => el === document.activeElement), true);
      await history.getByRole('button', { name: /^展开全部/ }).click();
      await history.locator('.settings-about-history-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.equal(await history.getByRole('button', { name: '关闭', exact: true }).isVisible(), true);
      await page.screenshot({ path: fileURLToPath(new URL(`${name}-history.png`, artifacts)) });
      const violations = await page.evaluate(() => window.cspViolations); assert.deepEqual(violations, [], `${name} CSP`);
      measurements.push({ name, width, height, theme, style, ...m, modal });
      await history.getByRole('button', { name: '关闭', exact: true }).click(); await history.waitFor({ state: 'hidden' });
    }
    passed.push('Six responsive and theme profiles', 'Internal scrolling and fixed close controls', 'Keyboard focus trap', 'Packaged CSP');
    assert.deepEqual(errors, []);
    await writeFile(new URL('production.json', artifacts), JSON.stringify({ passed, measurements, csp, errors }, null, 2) + '\n');
  } catch (error) {
    await page?.screenshot({ path: fileURLToPath(new URL('production-failure.png', artifacts)) });
    await writeFile(new URL('production-failure.json', artifacts), JSON.stringify({ errors, measurements, error: String(error), state: page ? await page.evaluate(() => ({ calls: window.dbCalls, check: typeof window.finishCheck, status: document.querySelector('#about-update')?.textContent })) : null, violations: page ? await page.evaluate(() => window.cspViolations) : [] }, null, 2));
    throw error;
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
});
