/* global window, document, requestAnimationFrame, innerWidth */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const origin = process.env.RESOURCE_PREVIEW_URL || 'http://127.0.0.1:1423';
const artifacts = new URL('../../docs/resource-acceptance-20261104/', import.meta.url);
const bootstrap = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
// 临时验收入口不得引入新预打包依赖，否则加载中的 React 图会失效并产生双实例。
import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
import {emit} from '/node_modules/@tauri-apps/api/event.js';
mockWindows('main');window.resourceCalls=[];
window.resourcePacks=[['jdtls','Java 代码智能'],['ecj','Java 编译器'],['svnkit','SVN 版本控制'],['cfr','CFR 反编译']].map(([id,title])=>({id,title,notes:'对应功能按需下载，完成后保存在本机',state:'missing',version:null,size:null}));
mockIPC(async(cmd,args)=>{
 if(cmd==='resources_status')return window.resourcePacks;
 if(cmd==='resources_ensure'){window.resourceCalls.push(args);return null;}
 if(cmd.startsWith('plugin:'))return cmd==='plugin:window|is_visible'?true:null;
 return null;
},{shouldMockEvents:true});
window.resourceEmit=async(name,payload)=>{
 if(name==='resource:installed')window.resourcePacks=window.resourcePacks.map(p=>p.id===payload.id?{...p,state:'installed',version:payload.version,size:1048576}:p);
 await emit(name,payload);
};
await import('/src/index.css');
const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');
const theme=await import('/src/lib/theme.ts');window.resourceTheme=theme.applyTheme;
const {ResourceProvider}=await import('/src/contexts/ResourceContext.tsx');
const {ResourceSettings}=await import('/src/components/settings/ResourceSettings.tsx');
const {ResourceDownloadEntry}=await import('/src/components/resource/ResourceDownloadEntry.tsx');
const {ResourceDownloadButton}=await import('/src/components/resource/ResourceDownloadButton.tsx');
createRoot(document.getElementById('root')).render(React.createElement(ResourceProvider,null,
 React.createElement('header',{className:'app-header flex items-center justify-end p-2'},React.createElement(ResourceDownloadEntry)),
 React.createElement('main',{style:{maxWidth:800,margin:'24px auto',padding:20}},
 React.createElement(ResourceSettings),React.createElement('div',{style:{marginTop:20}},React.createElement(ResourceDownloadButton,{id:'svnkit'})))));
`;

test('按需下载、真实阶段、关闭重开、限定重试和布局', async () => {
  await mkdir(artifacts, { recursive: true });
  // 真实文件由 Vite 统一变换依赖 URL，避免热更新后裸动态 import 产生重复 Context。
  const harness = new URL('../resource-download-qa.jsx', import.meta.url);
  await writeFile(harness, bootstrap, { flag: 'wx' });
  let browser;
  try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = [], errorDetails = [], layouts = [];
  page.on('pageerror', e => { errors.push(e.message); errorDetails.push({ message: e.message, stack: e.stack }); });
  await page.route(origin + '/', async route => {
    const response = await route.fetch();
    // 保留 Vite 注入的 React refresh preamble，替换应用入口以注入可控 IPC 事件。
    const body = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, '<script type="module" src="/resource-download-qa.jsx"></script>');
    assert.ok(body.includes('/resource-download-qa.jsx'));
    await route.fulfill({ response, body });
  });
  const dialog = () => page.getByRole('dialog', { name: '运行组件下载' });
  const event = (name, payload) => page.evaluate(({ name, payload }) => window.resourceEmit(name, payload), { name, payload });
  const installed = id => event('resource:installed', { id, version: 'qa-v1' });
  const ready = ids => event('resource:ready', { installed: ids.map(id => ({ id, version: 'qa-v1' })), adoptedLegacy: false });
  const capture = async name => {
    await page.screenshot({ path: fileURLToPath(new URL(name + '.png', artifacts)) });
  };
  try {
    await page.goto(origin); await page.getByRole('button', { name: '下载Java 编译器', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.resourceCalls), []);
    await page.getByRole('button', { name: '下载Java 编译器', exact: true }).click();
    await dialog().waitFor(); await page.waitForFunction(() => window.resourceCalls.length === 1);
    assert.deepEqual(await page.evaluate(() => window.resourceCalls[0]), { force: false, ids: ['ecj'] });
    await event('resource:available', { packs: [{ id: 'ecj', title: 'Java 编译器', notes: '单包按需下载', size: 1048576 }], totalBytes: 1048576 });
    await event('resource:downloading', { id: 'ecj' });
    await event('resource:progress', { id: 'ecj', downloaded: 524288, total: 1048576, bytesPerSec: 262144 });
    await dialog().getByText('50%', { exact: true }).waitFor();
    assert.ok((await dialog().innerText()).includes('256 KB/s')); await capture('download-progress');
    await dialog().getByRole('button', { name: '关闭组件下载面板' }).click(); await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '组件下载与管理' }).click(); await dialog().getByText('50%', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.resourceCalls.length), 1);
    await event('resource:verifying', { id: 'ecj' }); await dialog().getByText('下载已完成，正在校验文件完整性。').waitFor(); await capture('verifying');
    await event('resource:installing', { id: 'ecj' }); await dialog().getByText('下载已完成，正在解压并安装组件。').waitFor();
    await installed('ecj'); await ready(['ecj']); await dialog().getByText('所选组件已就绪，可返回对应功能继续操作。').waitFor();
    await dialog().getByRole('button', { name: '关闭组件下载面板' }).click(); await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '下载 SVN 组件', exact: true }).click(); await dialog().waitFor();
    await page.waitForFunction(() => window.resourceCalls.length === 2);
    assert.deepEqual(await page.evaluate(() => window.resourceCalls[1]), { force: false, ids: ['svnkit'] });
    await event('resource:downloading', { id: 'svnkit' });
    await event('resource:progress', { id: 'svnkit', downloaded: 4000, total: null, bytesPerSec: 2000 });
    assert.equal(await dialog().getByRole('progressbar').getAttribute('aria-valuenow'), null);
    await dialog().getByText('总大小未知', { exact: true }).waitFor();
    await event('resource:error', { message: '下载超时', code: 'timeout', installed: [] });
    await dialog().getByRole('button', { name: '重试剩余组件' }).click(); await page.waitForFunction(() => window.resourceCalls.length === 3);
    assert.deepEqual(await page.evaluate(() => window.resourceCalls[2]), { force: false, ids: ['svnkit'] });
    await installed('svnkit'); await ready(['svnkit']);
    await dialog().getByRole('button', { name: '关闭组件下载面板' }).click(); await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '下载缺失组件（2）', exact: true }).click(); await dialog().waitFor();
    await page.waitForFunction(() => window.resourceCalls.length === 4);
    assert.deepEqual(await page.evaluate(() => window.resourceCalls[3].ids), ['jdtls', 'cfr']);
    await installed('jdtls'); await event('resource:error', { message: '连接失败', code: 'network', installed: [{ id: 'jdtls', version: 'qa-v1' }] });
    await dialog().getByRole('button', { name: '重试剩余组件' }).click(); await page.waitForFunction(() => window.resourceCalls.length === 5);
    assert.deepEqual(await page.evaluate(() => window.resourceCalls[4]), { force: false, ids: ['cfr'] });
    await event('resource:downloading', { id: 'cfr' });
    await event('resource:progress', { id: 'cfr', downloaded: 524288, total: 1048576, bytesPerSec: 262144 });
    for (const width of [1280, 1024, 560]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 800 }); await page.evaluate(theme => window.resourceTheme(theme), theme);
      await page.waitForFunction(theme => document.documentElement.classList.contains('dark') === (theme === 'dark'), theme);
      await page.evaluate(async () => { await document.startViewTransition?.(() => {}).finished; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      const layout = await dialog().evaluate(el => { const r = el.getBoundingClientRect(); return { width: innerWidth, dark: document.documentElement.classList.contains('dark'), left: r.left, right: r.right, top: r.top, bottom: r.bottom, overflow: el.scrollWidth > el.clientWidth + 1, viewportOverflow: document.documentElement.scrollWidth > innerWidth }; });
      layouts.push({ ...layout, theme }); assert.ok(layout.left >= 0 && layout.right <= width && layout.top >= 0 && layout.bottom <= 800); assert.equal(layout.overflow, false); assert.equal(layout.viewportOverflow, false);
      await capture(`panel-${width}-${theme}`);
    }
    await installed('cfr'); await ready(['cfr']);
    assert.deepEqual(errors, []);
    await writeFile(new URL('results.json', artifacts), JSON.stringify({ layouts, errors, calls: await page.evaluate(() => window.resourceCalls) }, null, 2));
  } catch (error) {
    await capture('failure'); await writeFile(new URL('failure.json', artifacts), JSON.stringify({ error: String(error), errors, errorDetails, body: await page.locator('body').innerText() }, null, 2)); throw error;
  }
  } finally { try { await browser?.close(); } finally { await unlink(harness); } }
});
