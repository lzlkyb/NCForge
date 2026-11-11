// 正式前端验收：所有 IPC 和文件输入隔离，避免改动真实配置或启动 NC。
/* global window, document, innerWidth, getComputedStyle, requestAnimationFrame */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.SETTINGS_PREVIEW_URL || "http://127.0.0.1:1421";
const flowsOnly = process.argv.includes("--flows");
const artifacts = new URL("../../docs/设置UI验收-2026-11-11/", import.meta.url);
const bootstrap = `
import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
mockWindows('main');
window.settingsAcceptance = {commands:[],unknown:[],home:'D:/NC/NC65'};
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.settingsAcceptance.copied=text;}}});
const home = root => ({root,java:root+'/ufjdk/bin/java.exe',moduleCount:86,hasNcStarter:true,httpPort:8080,servicePort:8005});
let config = {workspace_root:null,nc_home:'D:/NC/NC65',autostart_enabled:false,lang_enabled:true,lang_auto_start:false,lang_xmx_mb:1024,linked_overrides:[],auto_compile:true,deploy_on_start:true,hotswap_enabled:true,hotswap_auto:true,auto_compile_incremental:true,auto_compile_external:true,prewarm_index:true,persistent_worker:true,build_parallel:2};
mockIPC((cmd,args) => {
  window.settingsAcceptance.commands.push({cmd,args});
  if (cmd === 'get_config') return {...config};
  if (cmd === 'patch_config' || cmd === 'lang_config_set') {config={...config,...args.patch};return {...config};}
  if (cmd === 'get_app_info') return {version:'0.4.0',platform:'windows',running:false};
  if (cmd === 'get_autostart') return false;
  if (cmd === 'resources_status') return ['jdtls','ecj','svnkit','cfr'].map((id,i)=>({id,title:['Java 代码智能','Java 编译器','SVN 组件','反编译组件'][i],notes:'对应功能所需的运行组件',state:'installed',version:'a1b2c3d4',size:1024*1024*(i+1)}));
  if (cmd === 'nc_home_probe') return home(args.path ?? window.settingsAcceptance.home);
  if (cmd === 'nc_home_candidates') return [{root:'D:/NC/测试环境/NC65',moduleCount:86,source:'driveRoot'}];
  if (cmd === 'nc_home_set') {window.settingsAcceptance.home=args.path;config.nc_home=args.path;return home(args.path);}
  if (cmd === 'pick_folder') return 'D:/NC/测试环境/NC65';
  if (cmd === 'server_status') return {state:'running',ncHome:'D:/NC/NC65',pid:123,httpPort:8080,heapMb:4096,defaultHeapMb:4096,portOwner:null,portOwnedBySelf:true};
  if (cmd === 'hotswap_status') return {enabled:true,auto:true,agentOnline:false,agentAttached:true,stale:false,pending:0,pendingClasses:[],last:null,staleReport:null,client:{running:false,agentOnline:false,agentAttached:false,stale:false}};
  if (cmd === 'build_cache_info') return {indexBytes:102400,indexFiles:12,manifestBytes:4096,manifestModules:3,tmpBytes:2048,trackedClasses:125,untrackedClasses:[],history:[],worker:{workerCompiles:0,oneshotCompiles:0}};
  if (cmd === 'build_history') return [];
  if (cmd === 'export_config') return JSON.stringify({app:'ncforge',schema:1,from_version:'0.4.0',config:{workspace_root:'D:/工程/当前工程',nc_home:window.settingsAcceptance.home,lang_enabled:true,lang_xmx_mb:1024}});
  if (cmd === 'import_config') return {};
  if (cmd === 'db_cached_tables') return {tables:[],fetchedAt:0};
  if (['db_connections','workspace_recent','fs_list_dir','svn_recent','workspace_modules','workspace_linked','local_history_list'].includes(cmd)) return [];
  if (cmd === 'plugin:window|is_visible') return true;
  if (cmd === 'plugin:window|is_maximized') return false;
  if (cmd.startsWith('plugin:') || ['workspace_watch','workspace_unwatch','check_update'].includes(cmd)) return null;
  window.settingsAcceptance.unknown.push(cmd);
  throw new Error('验收 IPC 未配置：'+cmd);
}, {shouldMockEvents:true});
await import('/src/main.tsx');
`;

await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
const measurements = [];
let screenshotCount = 0;
page.on("pageerror", error => errors.push(error.message));
await page.route(`${origin}/`, async route => {
  const response = await route.fetch();
  const html = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, `<script type="module">${bootstrap}</script>`);
  assert.ok(html.includes("mockWindows"), "正式前端挂载前必须隔离 IPC");
  await route.fulfill({ response, body: html });
});
const settle = () => page.evaluate(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
});
const navigate = async label => {
  if (!await page.locator(".wb-settings-nav").isVisible()) await page.getByRole("button", { name: "分类", exact: true }).click();
  await page.locator(".wb-settings-nav").getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("heading", { name: label, exact: true }).waitFor();
  await page.locator(".wb-settings-body").evaluate(n => { n.scrollTop = 0; });
  await settle();
};
const capture = async (name, screenshot = true) => {
  await settle();
  const layout = await page.evaluate(() => ({
    width: innerWidth, outerOverflow: document.documentElement.scrollWidth > innerWidth,
    body: [...document.querySelectorAll(".wb-settings-body")].map(n => ({client:n.clientWidth,scroll:n.scrollWidth})),
    controls: [...document.querySelectorAll('[data-settings-section]:not([hidden]) input:not([type="file"]),[data-settings-section]:not([hidden]) select')].filter(n => n.getClientRects().length).map(n => {
      const r = n.getBoundingClientRect();return {label:n.getAttribute('aria-label'),left:r.left,right:r.right};
    }),
    spacing: [...document.querySelectorAll('.wb-settings-page-header,.settings-row,.wb-settings-commandbar')].filter(n => n.getClientRects().length).slice(0,8).map(n => ({class:n.className,padding:getComputedStyle(n).padding,fontSize:getComputedStyle(n).fontSize})),
  }));
  measurements.push({name,...layout});
  if (screenshot) { await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, artifacts)) });screenshotCount++; }
  assert.equal(layout.outerOverflow, false, `${name} 外层不能横向溢出`);
  assert.ok(layout.body.every(n => n.scroll <= n.client+1), `${name} 设置正文不能横向溢出`);
  assert.ok(layout.controls.every(n => n.left >= 0 && n.right <= layout.width+1), `${name} 输入控件必须位于视口内`);
};
try {
  await page.goto(origin);
  await page.locator(".app-side").getByRole("button", { name: /^设置(?:，|$)/ }).click({ timeout:30000 });
  await page.getByRole("radiogroup", {name:"界面材质",exact:true}).waitFor();
  await page.evaluate(async () => { const {setSession}=await import('/src/lib/workspaceSession.ts');setSession({root:'D:/工程/验收工程'}); });
  const labels = await page.locator(".wb-settings-nav button").allTextContents();
  assert.equal(labels.length,11);
  for (const dark of flowsOnly ? [] : [false,true]) {
    await navigate("外观与启动");
    await page.getByRole("radiogroup",{name:"明暗主题",exact:true}).getByRole("radio",{name:dark?"深色":"浅色",exact:true}).click();
    await settle();
    for (const [density,width] of [['standard',1280],['standard',560],['standard',1024],['comfortable',1280],['comfortable',1024],['comfortable',560]]) {
      await navigate("外观与启动");
      await page.getByRole("radiogroup",{name:"界面密度",exact:true}).getByRole("radio",{name:density==='standard'?"标准":"舒适",exact:true}).click();
      await page.setViewportSize({width,height:width===1024?768:800});
      for (const [i,label] of labels.entries()) {
        await navigate(label);
        if (label === "任务流程") {
          await page.locator(".settings-task-create > summary").click();
          await page.getByLabel("任务名称",{exact:true}).fill("编译并投送到测试环境");
        }
        const snapshot = density === 'standard' && width !== 1024;
        await capture(`${dark?'dark':'light'}-${width}-${String(i+1).padStart(2,'0')}${snapshot?'':`-${density}`}`,snapshot);
        if (label === "任务流程") await page.getByRole("button",{name:"收起并保留草稿",exact:true}).click();
      }
    }
  }
  await navigate('外观与启动');
  await page.getByRole('radiogroup',{name:'界面密度',exact:true}).getByRole('radio',{name:'标准',exact:true}).click();
  await page.setViewportSize({width:1280,height:800});
  await navigate("编辑器");
  const size=page.getByRole('spinbutton',{name:'代码字号',exact:true});
  await size.fill('20');await size.blur();
  assert.match(await page.locator('.settings-editor-preview').innerText(),/预览草稿/);
  await size.press('Escape');assert.equal(await size.inputValue(),'13');
  const search=page.getByRole('textbox',{name:'搜索设置',exact:true});
  await search.fill('保存时自动编译');await search.press('Enter');
  await page.locator('#task-auto-compile').waitFor();
  assert.equal(await page.locator('#task-auto-compile').evaluate(n=>n===document.activeElement),true);
  await page.getByRole('button',{name:'返回搜索结果',exact:true}).click();
  assert.equal(await search.inputValue(),'保存时自动编译');await search.press('Escape');
  await navigate('NC 安装与检测');
  await page.getByRole('button',{name:'复制NC 配置目录',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.settingsAcceptance.copied),'D:/NC/NC65');
  await page.getByRole('button',{name:'浏览…',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'NC 安装目录',exact:true}).inputValue(),'D:/NC/测试环境/NC65');
  assert.equal(await page.evaluate(()=>window.settingsAcceptance.commands.filter(x=>x.cmd==='nc_home_set').length),0);
  await page.getByRole('button',{name:'检测目录',exact:true}).click();
  await page.getByRole('button',{name:'保存并使用',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await capture('nc-directory-confirmation');
  await page.setViewportSize({width:560,height:800});await capture('nc-confirmation-narrow',false);
  await page.setViewportSize({width:1280,height:800});
  assert.equal(await page.evaluate(()=>window.settingsAcceptance.commands.filter(x=>x.cmd==='nc_home_set').length),0);
  await page.getByRole('button',{name:'保存配置，稍后重启',exact:true}).click();
  await page.getByText('NC 安装目录已保存。',{exact:false}).waitFor();
  await navigate('任务流程');
  await page.locator('.settings-task-create > summary').click();
  await page.getByLabel('任务名称',{exact:true}).fill('验收流程');
  await page.getByRole('button',{name:'上移投送元数据到 NC',exact:true}).click();
  await page.getByRole('button',{name:'添加任务',exact:true}).click();
  await page.getByRole('button',{name:'编辑任务「验收流程」',exact:true}).click();
  assert.match(await page.locator('.settings-task-ordered li').first().innerText(),/投送元数据/);
  await navigate('SQL 格式化');
  await page.waitForFunction(()=>!document.querySelector('.settings-sql-preview')?.textContent.includes('正在生成'));
  assert.equal(await page.locator('.settings-sql-preview').getByText('示例排版失败',{exact:false}).count(),0);
  await navigate('配置迁移');
  await page.getByLabel('选择配置文件',{exact:true}).setInputFiles({name:'验收配置.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({app:'ncforge',schema:1,config:{nc_home:'E:/迁移环境/NC65',lang_enabled:false}}))});
  await page.getByRole('dialog',{name:'导入配置预览',exact:true}).waitFor();
  await capture('import-review');
  await page.setViewportSize({width:560,height:800});await capture('import-review-narrow',false);
  await page.setViewportSize({width:1280,height:800});
  assert.equal(await page.evaluate(()=>window.settingsAcceptance.commands.filter(x=>x.cmd==='import_config').length),0);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  assert.deepEqual(errors,[], '正式前端不能有未处理的运行时错误');
  const previous = flowsOnly ? JSON.parse(await readFile(new URL('results.json',artifacts),'utf8')).measurements.filter(x=>x.name!=='nc-directory-confirmation'&&x.name!=='import-review') : [];
  await writeFile(new URL('results.json',artifacts),JSON.stringify({measurements:[...previous,...measurements],errors,fixture:await page.evaluate(()=>window.settingsAcceptance),ipc:'全部为 Tauri mocks，没有真实配置写入或服务操作'},null,2));
  console.log(flowsOnly ? "关键操作流程与弹框截图复核通过。" : `设置验收通过：${measurements.length} 组布局与流程检查，${screenshotCount} 张截图，含明暗主题、标准/舒适密度与三种窗口宽度。`);
} catch(error) {
  await page.screenshot({path:fileURLToPath(new URL('failure.png',artifacts))});
  await writeFile(new URL('failure.json',artifacts),JSON.stringify({error:String(error),errors,measurements,fixture:await page.evaluate(()=>window.settingsAcceptance)},null,2));
  throw error;
} finally { await context.close();await browser.close(); }
