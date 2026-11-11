// Real application and Monaco, with local IPC fixtures for reproducible completion checks.
/* global window, document, localStorage, performance, CompositionEvent */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.GLASS_PREVIEW_URL || "http://127.0.0.1:1433";
const artifacts = new URL("../../docs/SQL智能补全验收-2026-11-11/", import.meta.url);
const fixture = await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
const matched = fixture.match(/const bootstrap=`([\s\S]*?)`;/);
assert.ok(matched);
let bootstrap = matched[1]
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'',results:[],output:[]}")
  .replace("if(cmd==='db_exec_bound')", "if(cmd==='db_exec' || cmd==='db_exec_result' || cmd==='db_exec_bound')")
  .replace("if(cmd==='get_autostart')", "if(cmd==='check_update') return null; if(cmd==='get_autostart')")
  .replace("ms:10,tx:tx()", "ms:10,output:[],tx:tx()")
  .replace("rows:[[1,'A','甲'],[2,'B','乙'],[3,'C','丙']]", "rows:[[1,'A','甲','M1',1,0,'O1'],[2,'B','乙','M2',0,0,'O1'],[3,'C','丙','M3',1,0,'O2']]")
  .replace("if(cmd==='db_tx')", "if(cmd==='db_slot_acquire')return {slot:'sql-1',tx:tx()}; if(cmd==='db_tx')")
  .replace("if(args.kind==='tables')", "if(args.kind==='schemas')return {schemas:['NC_TEST','OTHER'],current:'NC_TEST'}; if(args.kind==='tables')")
  .replace("[{name:'TEST_TABLE',kind:'TABLE'},{name:'TEST_CHILD',kind:'TABLE'}]", "['BD_MATERIAL','BD_PROJECT','BD_ORDER','BD_CUSTOMER'].map(name=>({name,kind:'TABLE'}))")
  .replace("{test_table:'测试主表',test_child:'测试子表'}", "{bd_material:'物料',bd_project:'项目',bd_order:'订单',bd_customer:'客户'}")
  .replace("if(cmd==='db_relations')", "if(cmd==='db_relations') return {foreign:{kind:'rows',columns:['RELATION','SOURCE_TABLE','SOURCE_COLUMN','TARGET_TABLE','TARGET_COLUMN','POSITION'].map(name=>({name,type:'VARCHAR2'})),rows:[['FK_ORDER_MATERIAL','BD_ORDER','PK_MATERIAL','BD_MATERIAL','PK_MATERIAL',1]],hasMore:false},references:{kind:'rows',columns:[],rows:[],hasMore:false},enums:{kind:'rows',columns:['FIELD','ENUM_VALUE','ENUM_LABEL'].map(name=>({name,type:'VARCHAR2'})),rows:[['STATUS','1','已审核'],['STATUS','0','未审核']],hasMore:false},notes:[],sharedSession:false}; if(cmd==='unused_db_relations')")
  .replace("const conn=", "columns.push({name:'PK_MATERIAL',type:'VARCHAR2',full:'VARCHAR2(20)',pk:false,zh:'物料主键'},{name:'STATUS',type:'NUMBER',full:'NUMBER',pk:false,zh:'状态'},{name:'DR',type:'NUMBER',full:'NUMBER',pk:false,zh:'删除标记'},{name:'PK_ORG',type:'VARCHAR2',full:'VARCHAR2(20)',pk:false,zh:'组织'}); const conn=")
  .replace("await import('/src/main.tsx');", "localStorage.setItem('ncforge-db-result-height','250');await import('/src/main.tsx');");

test("three phase SQL assistance: real Monaco completion, keyboard, learning, business and latency", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], passed = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on('console', m => { if(m.type()==='error' && !m.text().includes('WebSocket') && !m.text().includes('[vite]')) errors.push(m.text()); });
  await page.route(origin + "/", async route => {
    const response = await route.fetch(), html = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, '<script type="module">' + bootstrap + '</script>');
    assert.ok(html.includes("mockWindows")); await route.fulfill({ response, body: html });
  });
  const editorState = async () => page.evaluate(async () => { const { monaco } = await import('/src/lib/monacoSetup.ts'); return monaco.editor.getEditors().find(e => e.getContainerDomNode().closest('.dbx-editor')).getValue(); });
  async function setSql(sql, offset = sql.length) {
    await page.getByRole('textbox',{name:'SQL 查询编辑器',exact:true}).waitFor();
    await page.evaluate(async ({ sql, offset }) => { const { monaco } = await import('/src/lib/monacoSetup.ts'); const e = monaco.editor.getEditors().find(e => e.getContainerDomNode().closest('.dbx-editor')); e.trigger('test','hideSuggestWidget',{}); e.getModel().setValue(sql); e.setPosition(e.getModel().getPositionAt(offset)); e.focus(); }, { sql, offset });
  }
  async function suggest(sql, offset = sql.length) {
    await setSql(sql, offset); await page.keyboard.press('Control+Space');
    await page.locator('.suggest-widget.visible .monaco-list-row').first().waitFor({ timeout: 15000 });
    return page.locator('.suggest-widget.visible .monaco-list-row');
  }
  async function accept(rows, text) {
    const index = (await rows.allInnerTexts()).findIndex(s => s.includes(text));
    assert.ok(index >= 0, `Missing candidate: ${text}`);
    for (let n=0;n<index;n++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
  }
  async function ready() {
    await page.locator('#dbx-conn-c').click();
    await page.evaluate(async () => { window.assistDb=await import('/src/lib/dbStore.ts');window.assistMonaco=(await import('/src/lib/monacoSetup.ts')).monaco;window.assistUsage=await import('/src/lib/sqlUsage.ts');window.assistLearning=await import('/src/lib/sqlAssistLearning.ts'); });
    await page.waitForFunction(() => window.assistDb.rtOf('c').tables?.length === 4 && window.assistDb.rtOf('c').currentSchema === 'NC_TEST');
    await page.waitForFunction(() => window.assistMonaco.editor.getEditors().some(e => e.getContainerDomNode().closest('.dbx-editor')));
  }
  try {
    await page.goto(origin); await page.locator('.app-side').getByRole('button', { name: /^数据库/ }).click();
    await ready();
    let rows = await suggest('select * from 物料');
    assert.match(await rows.first().innerText(), /bd_material/); await page.keyboard.press('Tab');
    assert.equal(await editorState(), 'select * from bd_material'); passed.push('Chinese search inserts physical name');
    await page.keyboard.press('Control+z');
    assert.equal(await editorState(), 'select * from 物料');
    const noAccept = await page.evaluate(async () => { const { sqlAssistScope } = await import('/src/lib/sqlAssistLearning.ts'); const { usageSnapshot } = await import('/src/lib/sqlUsage.ts'); return Object.values(usageSnapshot(sqlAssistScope('c'))).reduce((n,e)=>n+e.accept,0); });
    assert.equal(noAccept,0); passed.push('Immediate undo rolls back acceptance');
    rows = await suggest('select * from bd_');
    await accept(rows,'bd_project');
    assert.equal(await editorState(), 'select * from bd_project');
    rows = await suggest('select * from bd_'); assert.match(await rows.first().innerText(),/bd_project/); passed.push('Accepted table moves to first within equal match tier');
    rows = await suggest('select * from bd_mat'); assert.match(await rows.first().innerText(),/bd_material/); passed.push('Explicit prefix outranks popularity');
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.suggest-widget.visible').count(),0); assert.equal(await editorState(),'select * from bd_mat');
    await suggest('select * from 物料'); await page.keyboard.press('Enter'); assert.equal(await editorState(),'select * from bd_material'); passed.push('Escape closes and Enter accepts without executing');
    rows = await suggest('select * from bd_material',20); await page.keyboard.press('Tab'); assert.equal(await editorState(),'select * from bd_material'); passed.push('Midword replacement preserves no old suffix');
    const four = 'select  from bd_material m join bd_project p on 1=1 join bd_order o on 1=1 join bd_customer c on 1=1';
    rows = await suggest(four,7); assert.ok((await rows.allInnerTexts()).some(s=>s.includes('c.code'))); passed.push('Fourth source fields are discoverable');
    const where = 'select * from bd_material m where m.';
    rows = await suggest(where); assert.ok((await rows.allInnerTexts()).some(s=>s.includes('code'))); assert.ok(!(await rows.allInnerTexts()).some(s=>s.includes('bd_project'))); passed.push('Alias suggestions stay within source');
    rows = await suggest('select * from bd_material m where m.编码'); await page.keyboard.press('Tab'); assert.equal(await editorState(),'select * from bd_material m where m.code'); passed.push('Chinese field descriptions insert scoped physical fields');
    rows = await suggest('select * from bd_order o join bd_material m on ');
    await accept(rows,'外键');
    assert.match(await editorState(),/o\.PK_MATERIAL = m\.PK_MATERIAL/); passed.push('FK candidate inserts verified relationship with current aliases');
    await page.screenshot({path:fileURLToPath(new URL('三期关联条件.png',artifacts))});
    rows = await suggest('select * from bd_material m where m.status = ');
    await accept(rows,'已审核'); assert.match(await editorState(),/status = 1$/); passed.push('Verified numeric enum inserts actual value');
    await page.evaluate(async () => { const { addSnippet } = await import('/src/lib/dbSnippets.ts'); addSnippet({name:'组织查询',connId:'c',sql:'select * from bd_material where pk_org = {{pk_org}}'}); });
    rows = await suggest('组织查询'); await accept(rows,'组织查询');
    assert.match(await editorState(),/pk_org = pk_org/); passed.push('Saved query parameters are navigable snippet slots');
    await setSql('select * from bd_material'); await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => window.dbCalls.some(c=>['db_exec','db_exec_bound','db_exec_result'].includes(c.cmd) && c.args.sql==='select * from bd_material'));
    await page.evaluate(async () => { window.assistUsage=await import('/src/lib/sqlUsage.ts');window.assistLearning=await import('/src/lib/sqlAssistLearning.ts'); });
    await page.waitForFunction(() => Object.values(window.assistUsage.usageSnapshot(window.assistLearning.sqlAssistScope('c'))).some(e=>e.execute>0)); passed.push('Ctrl+Enter executes and success trains frozen scope');
    await page.getByRole('button',{name:'更多数据库操作',exact:true}).click(); await page.getByText('补全记忆',{exact:true}).click();
    await page.getByRole('button',{name:'固定 bd_material',exact:true}).click(); passed.push('Memory drawer pins physical objects');
    await page.screenshot({path:fileURLToPath(new URL('一期补全记忆.png',artifacts))});
    await page.evaluate(()=>window.assistUsage.flushSqlUsage()); await page.reload();
    await page.locator('.app-side').getByRole('button',{name:/^数据库/}).click(); await ready();
    await page.getByRole('button',{name:'更多数据库操作',exact:true}).click(); await page.getByText('补全记忆',{exact:true}).click();
    await page.getByRole('button',{name:'取消固定 bd_material',exact:true}).waitFor(); passed.push('Local preference survives reload');
    await page.getByRole('button',{name:'忘记 bd_material',exact:true}).click();
    await page.getByRole('checkbox',{name:'根据使用习惯排序',exact:true}).uncheck();
    assert.equal(await page.evaluate(()=>window.assistUsage.getSqlUsageEnabled()),false);
    await page.getByRole('checkbox',{name:'根据使用习惯排序',exact:true}).check();
    await page.getByRole('button',{name:'清除当前 schema 补全记忆',exact:true}).click(); await page.getByRole('button',{name:'确认清除',exact:true}).click();
    assert.equal(await page.evaluate(()=>Object.keys(window.assistUsage.usageSnapshot(window.assistLearning.sqlAssistScope('c'))).length),0); passed.push('Disable, forget and clear memory controls');
    await page.getByRole('button',{name:'关闭补全记忆',exact:true}).click();
    const joinSql='select * from bd_order o join bd_material m on o.pk_material = m.pk_material';
    for(let i=0;i<2;i++){await setSql(joinSql);await page.keyboard.press('Control+Enter');await page.waitForFunction(n=>window.dbCalls.filter(c=>['db_exec','db_exec_result'].includes(c.cmd) && c.args.sql.includes('join bd_material')).length>=n,i+1);await page.waitForFunction(()=>!window.assistDb.sqlTabOf('acceptance-table').run);}
    await page.waitForFunction(()=>Object.values(JSON.parse(localStorage.getItem('ncforge-sql-join-history')||'{"scopes":{}}').scopes).some(rows=>rows.some(row=>row.count>=2)));
    rows=await suggest('select * from bd_order ord join bd_material mat on ');assert.ok((await rows.allInnerTexts()).some(s=>s.includes('历史写法')));passed.push('Repeated verified joins recommend current aliases');
    await setSql('select * from bd_material');
    const ime=await page.evaluate(()=>{const e=window.assistMonaco.editor.getEditors().find(e=>e.getContainerDomNode().closest('.dbx-editor')),input=e.getDomNode().querySelector('textarea'); input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'物'}));const during=e.getOption(window.assistMonaco.editor.EditorOption.quickSuggestions);input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));return {during,after:e.getOption(window.assistMonaco.editor.EditorOption.quickSuggestions)};});
    assert.equal(ime.during.other,'off');assert.equal(ime.after.other,'on');passed.push('Real editor composition suppresses automatic suggestions');
    const perf = await page.evaluate(async () => {
      const {monaco}=await import('/src/lib/monacoSetup.ts'), {getDb}=await import('/src/lib/dbStore.ts'), {provideSqlAssist}=await import('/src/lib/sqlAssistProvider.ts');
      const e=monaco.editor.getEditors().find(e=>e.getContainerDomNode().closest('.dbx-editor')),rt=getDb().rt.c,old=rt.tables;
      rt.tables=Array.from({length:10000},(_,i)=>({name:'BD_TABLE_'+String(i).padStart(5,'0'),kind:'TABLE'}));
      e.getModel().setValue('select * from bd_'); e.setPosition({lineNumber:1,column:18});
      const values=[]; for(let i=0;i<25;i++){ const start=performance.now(); const list=await provideSqlAssist(e.getModel(),e.getPosition(),{}, {isCancellationRequested:false}); values.push(performance.now()-start); if(list.suggestions.length!==10000)throw Error('incomplete metadata candidates'); }
      rt.tables=old; values.sort((a,b)=>a-b);return {tables:10000,samples:values,p95:values[Math.floor(values.length*.95)]};
    });
    assert.ok(perf.p95<100,`Hot P95 ${perf.p95}ms should be <100ms`); passed.push('10000 table warm completion P95 below 100ms');
    rows = await suggest('select * from bd_');
    await page.screenshot({path:fileURLToPath(new URL('二期真实提示.png',artifacts))});
    await page.setViewportSize({width:860,height:650}); await page.evaluate(async()=>{const{applyTheme}=await import('/src/lib/theme.ts');applyTheme('dark');});
    await suggest('select * from 物料'); await page.screenshot({path:fileURLToPath(new URL('深色窄窗提示.png',artifacts))});
    assert.ok((await page.locator('.suggest-widget.visible').boundingBox()).width<=860); passed.push('Dark and narrow completion remains visible');
    assert.deepEqual(errors,[]);
    await writeFile(new URL('browser-checks.json',artifacts),JSON.stringify({passed,perf,errors},null,2));
  } catch(error) { const state=await page.evaluate(async()=>{const{monaco}=await import('/src/lib/monacoSetup.ts');const{getDb}=await import('/src/lib/dbStore.ts');const{provideSqlAssist}=await import('/src/lib/sqlAssistProvider.ts');const e=monaco.editor.getEditors().find(e=>e.getContainerDomNode().closest('.dbx-editor'));return{editors:monaco.editor.getEditors().map(e=>({id:e.getId(),parent:e.getContainerDomNode().parentElement?.className})),active:getDb().active,rt:getDb().rt.c,direct:e?await provideSqlAssist(e.getModel(),e.getPosition(),{},{isCancellationRequested:false}).catch(error=>({error:String(error)})):null,body:document.body.innerText};}); await page.screenshot({path:fileURLToPath(new URL('failure.png',artifacts))}); await writeFile(new URL('failure.json',artifacts),JSON.stringify({error:String(error),errors,passed,state},null,2)); throw error; }
  finally { await browser.close(); }
});
