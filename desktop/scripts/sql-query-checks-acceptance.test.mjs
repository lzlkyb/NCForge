// Formal UI and Monaco using isolated IPC/schema fixtures, never a business database.
/* global window */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const origin = process.env.GLASS_PREVIEW_URL || "http://127.0.0.1:1435";
const artifacts = new URL("../../docs/剩余五类查询辅助验收-2026-11-13/", import.meta.url);
const fixture = (await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8")).match(/const bootstrap=`([\s\S]*?)`;/)[1];
const col = (name, type = "VARCHAR2", zh = null, pk = false) => ({ name, type, full: type === "VARCHAR2" ? "VARCHAR2(30)" : type, zh, pk });
const fields = {
  invoice_head: [col("ID", "VARCHAR2", "主键", true), col("ORG_ID", "VARCHAR2", "组织"), col("BILL_NUMBER", "VARCHAR2", "单号"), col("CREATED_AT", "DATE", "创建日期"), col("DBILLDATE", "CHAR(19)", "字符日期")],
  invoice_rows: [col("ROW_ID", "VARCHAR2", "主键", true), col("HEAD_ID"), col("QTY", "NUMBER", "数量"), col("AMOUNT", "NUMBER(20,2)", "金额")],
  alternative_head: [col("ID", "VARCHAR2", null, true)],
};
const names = { invoice_head: "通用单据", invoice_rows: "通用明细", alternative_head: "另一关联主表" };
const execCommands = ["db_exec", "db_exec_bound", "db_exec_result"];
const headers = ["RELATION", "SOURCE_TABLE", "SOURCE_COLUMN", "TARGET_TABLE", "TARGET_COLUMN", "POSITION"];
const relations = [["head", "INVOICE_ROWS", "HEAD_ID", "INVOICE_HEAD", "ID", 1], ["other", "INVOICE_ROWS", "HEAD_ID", "ALTERNATIVE_HEAD", "ID", 1]];
const bootstrap = fixture
  .replace("if(cmd==='get_autostart')", "if(cmd==='check_update') return null; if(cmd==='get_autostart')")
  .replace("return {url:conn.url,user:conn.user,autoCommit:false};", "return {url:conn.url,user:conn.user,schema:'NC_TEST',autoCommit:false};")
  .replace("if(cmd==='db_tx') return {tx:tx()};", "if(cmd==='db_slot_acquire') return {slot:'sql-checks-1',tx:tx()}; if(cmd==='db_slot_release') return null; if(cmd==='db_tx') return {tx:tx()};")
  .replace("[{name:'TEST_TABLE',kind:'TABLE'},{name:'TEST_CHILD',kind:'TABLE'}]", JSON.stringify(Object.keys(fields).map(name => ({ name: name.toUpperCase(), kind: "TABLE" }))))
  .replace("{test_table:'测试主表',test_child:'测试子表'}", JSON.stringify(names))
  .replace("if(args.kind==='tables')", "if(args.kind==='schemas') return {schemas:['NC_TEST'],current:'NC_TEST',user:'NC_TEST'}; if(args.kind==='tables')")
  .replace("if(args.kind==='columns') return {columns};", `if(args.kind==='columns') return {columns:${JSON.stringify(fields)}[String(args.arg).toLowerCase()]||[]};`)
  .replace(/if\(cmd==='db_relations'\)[^\n]+/, `if(cmd==='db_relations') return {foreign:{kind:'rows',columns:${JSON.stringify(headers)}.map(name=>({name,type:'VARCHAR2'})),rows:${JSON.stringify(relations)}.filter(r=>[r[1],r[3]].includes(String(args.table).toUpperCase())),hasMore:false},references:{kind:'rows',columns:[],rows:[],hasMore:false},notes:[],sharedSession:false};`)
  .replace("if(cmd==='db_exec_bound')", "if(cmd==='db_exec' || cmd==='db_exec_result' || cmd==='db_exec_bound')")
  .replace("hasMore:false,ms:10,tx:tx()", "hasMore:false,ms:10,output:[],tx:tx()")
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'',results:[],output:[]}");
test("remaining five query assist workflows", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(12000);
  const passed = [], errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.route(origin + "/", async route => { const response = await route.fetch(); const body = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, () => '<script type="module">' + bootstrap + '</script>'); assert.ok(body.includes("sql-checks-1")); await route.fulfill({ response, body }); });
  const state = () => page.evaluate(() => window.checkEditor().getModel().getValue().replace(/\r\n/g, "\n"));
  async function setSql(sql, start = sql.length, end = start) { await page.evaluate(({ sql, start, end }) => { const e = window.checkEditor(), m = e.getModel(); e.trigger("acceptance", "hideSuggestWidget", {}); m.setValue(sql); const a = m.getPositionAt(start), b = m.getPositionAt(end); e.setSelection(new window.checkMonaco.Range(a.lineNumber, a.column, b.lineNumber, b.column)); e.focus(); }, { sql, start, end }); }
  async function suggest(sql, offset = sql.length) { await setSql(sql, offset); await page.evaluate(async () => { const e = window.checkEditor(); await (await import("/src/lib/sqlAssistProvider.ts")).provideSqlAssist(e.getModel(), e.getPosition(), { triggerKind: 0 }, { isCancellationRequested: false }); }); await page.keyboard.press("Control+Space"); await page.locator(".suggest-widget.visible .monaco-list-row").first().waitFor(); }
  async function accept(label) { for (let i = 0; i < 60; i++) { const row = page.locator(".suggest-widget.visible .monaco-list-row.focused"); if (await row.count() && (await row.innerText()).includes(label)) { await page.keyboard.press("Tab"); return; } await page.keyboard.press("ArrowDown"); } assert.fail("missing: " + label); }
  const run = id => page.evaluate(async id => window.checkEditor().getAction(id).run(), id);
  const markers = () => page.evaluate(() => window.checkMonaco.editor.getModelMarkers({ resource: window.checkEditor().getModel().uri }).filter(m => m.code === "left-join-where"));
  async function quickFix(label) {
    await page.evaluate(() => { const e = window.checkEditor(), m = e.getModel(); e.setPosition(m.getPositionAt(m.getValue().indexOf("b.QTY") + 2)); e.focus(); });
    await page.waitForFunction(() => window.checkMonaco.editor.getModelMarkers({ resource: window.checkEditor().getModel().uri }).some(m => m.code === "left-join-where"));
    await page.evaluate(() => window.checkEditor().trigger("acceptance", "editor.action.quickFix", {}));
    const item = page.getByText(label, { exact: true }); await item.waitFor();
    const box = await item.boundingBox(); assert.ok(box);
    // Monaco blocks the stationary pointer until its first move after opening the action list.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await item.click();
  }
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click({ timeout: 30000 }); await page.locator("#dbx-conn-c").click({ timeout: 30000 });
    await page.getByRole("textbox", { name: "SQL 查询编辑器", exact: true }).waitFor({ timeout: 30000 });
    await page.evaluate(async () => { window.checkDb = await import("/src/lib/dbStore.ts"); window.checkMonaco = (await import("/src/lib/monacoSetup.ts")).monaco; window.checkEditor = () => window.checkMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor")); });
    await page.waitForFunction(() => window.checkDb.rtOf("c").currentSchema === "NC_TEST" && window.checkDb.rtOf("c").tables?.length === 3);
    await suggest("invoice_head"); await accept("没有关联行 通用明细");
    assert.ok((await state()).includes("WHERE NOT EXISTS")); assert.ok((await state()).includes("b.HEAD_ID = a.ID")); passed.push("missing-related template uses verified generic keys");
    await suggest("invoice_head"); await accept("找不到 通用单据");
    assert.ok((await state()).includes("b.HEAD_ID IS NOT NULL")); assert.ok((await state()).includes("AND NOT EXISTS")); passed.push("orphan template explicitly excludes null reference keys");
    await suggest("invoice_head"); await accept("明细行数 通用明细");
    assert.ok((await state()).includes("COUNT(*) AS DETAIL_COUNT")); assert.ok((await state()).includes("NVL(d.DETAIL_COUNT, 0)")); passed.push("detail counts aggregate first and zero-fill unmatched parents");
    const duplicate = "SELECT a.ORG_ID, a.BILL_NUMBER FROM invoice_head a WHERE a.ORG_ID='O1';";
    await setSql(duplicate, duplicate.indexOf("a.ORG_ID"), duplicate.indexOf(" FROM")); await run("ncforge.sql.checkDuplicates");
    const duplicated = await state(); assert.ok(duplicated.startsWith(duplicate)); assert.ok(duplicated.includes("GROUP BY a.ORG_ID, a.BILL_NUMBER")); assert.ok(duplicated.includes("HAVING COUNT(*) > 1")); assert.equal(duplicated.split("WHERE").length, 2);
    await page.screenshot({ path: fileURLToPath(new URL("字段组合重复检查.png", artifacts)) });
    await page.keyboard.press("Control+z"); assert.equal(await state(), duplicate); passed.push("selected-field duplicate check appends explicit whole-table query and undoes atomically");
    const summary = "SELECT b.QTY, b.AMOUNT FROM invoice_rows b WHERE b.QTY>10;";
    await setSql(summary, summary.indexOf("b.QTY"), summary.indexOf(" FROM")); await run("ncforge.sql.detailSummary");
    await page.locator(".suggest-widget.visible .monaco-list-row").first().waitFor(); await accept("另一关联主表 · 汇总明细");
    const summed = await state(); assert.ok(summed.startsWith(summary)); assert.ok(summed.includes("FROM ALTERNATIVE_HEAD p")); assert.ok(summed.includes("SUM(c.QTY)")); assert.ok(summed.includes("SUM(c.AMOUNT)")); assert.ok(summed.includes("GROUP BY c.HEAD_ID"));
    assert.ok(summed.includes("\nSELECT p.*,"));
    assert.equal(await page.evaluate(() => { const e = window.checkEditor(), m = e.getModel(); return m.getOffsetAt(e.getPosition()) === m.getValueLength(); }), true);
    passed.push("multiple verified parents use completion choices and selected numeric metrics");
    await page.screenshot({ path: fileURLToPath(new URL("按主表汇总明细.png", artifacts)) });
    assert.equal(await page.evaluate(commands => window.dbCalls.filter(c => commands.includes(c.cmd)).length, execCommands), 0);
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(commands => window.dbCalls.some(c => commands.includes(c.cmd) && c.args.sql.includes("SUM(c.QTY)") && c.args.sql.includes("SUM(c.AMOUNT)")), execCommands);
    await page.waitForFunction(() => !window.checkDb.sqlTabOf("acceptance-table").run);
    assert.equal(await page.evaluate(() => window.checkDb.sqlTabOf("acceptance-table").results.at(-1)?.kind), "rows");
    assert.equal(await page.getByRole("dialog", { name: "填写查询参数" }).count(), 0);
    passed.push("generated summary uses normal manual execution and returns success without a parameter panel");
    await setSql(summary, summary.indexOf("b.QTY"), summary.indexOf(" FROM")); await run("ncforge.sql.detailSummary");
    await page.locator(".suggest-widget.visible .monaco-list-row").first().waitFor(); const beforeRefresh = await state();
    await page.evaluate(() => window.checkDb.forgetColumns("c"));
    await accept("另一关联主表 · 汇总明细"); assert.equal(await state(), beforeRefresh);
    passed.push("accepting an already visible parent choice after metadata refresh cannot insert stale SQL");
    const meaning = "SELECT a.*, b.*\nFROM invoice_head a\nLEFT JOIN invoice_rows b ON a.ID=b.HEAD_ID\nWHERE a.ORG_ID='O1' AND b.QTY>1;";
    await setSql(meaning, meaning.indexOf("b.QTY") + 2); await page.waitForFunction(() => window.checkMonaco.editor.getModelMarkers({ resource: window.checkEditor().getModel().uri }).some(m => m.code === "left-join-where"));
    assert.equal(await state(), meaning); assert.ok((await markers())[0].message.includes("会排除")); passed.push("condition notice annotates SQL without modifying or executing it");
    await quickFix("将此条件移入 ON（调整筛选范围）");
    let moved = await state(); assert.ok(moved.includes("ON (a.ID=b.HEAD_ID) AND (b.QTY>1)")); assert.ok(moved.includes("WHERE a.ORG_ID='O1'"));
    await page.screenshot({ path: fileURLToPath(new URL("条件移入关联范围.png", artifacts)) });
    await page.keyboard.press("Control+z"); assert.equal(await state(), meaning); passed.push("explicit ON correction preserves other filters and undoes as one operation");
    await quickFix("仅保留匹配记录：明确使用 INNER JOIN"); assert.ok((await state()).includes("INNER JOIN invoice_rows b")); passed.push("explicit matching-only choice changes LEFT to INNER");
    await suggest("SELECT *\nFROM invoice_head a\nWHERE 创建日期"); await accept("created_at · 本月");
    assert.ok((await state()).includes("TRUNC(CURRENT_DATE, 'MM')")); assert.ok((await state()).includes("AND a.created_at <")); passed.push("date-field picker inserts dynamic database month boundaries");
    await page.evaluate(() => { const e = window.checkEditor(); e.updateOptions({ wordWrap: "on" }); e.setScrollLeft(0); });
    await page.screenshot({ path: fileURLToPath(new URL("常用时间快捷条件.png", artifacts)) });
    await suggest("SELECT * FROM invoice_head a WHERE a.CREATED_AT 上月"); await accept("时间快捷 · 上月");
    assert.ok((await state()).includes("INTERVAL '1' MONTH")); passed.push("operator-only time picker retains the qualified field");
    await suggest("SELECT * FROM invoice_head a WHERE a.CREATED_AT 近七天"); await accept("时间快捷 · 近七天");
    assert.ok((await state()).includes("TRUNC(CURRENT_DATE) - 6")); assert.ok((await state()).includes("TRUNC(CURRENT_DATE) + 1")); passed.push("seven-day preset includes today with natural-day boundaries");
    await setSql("SELECT * FROM invoice_head a WHERE a.DBILLDATE");
    const dateItems = await page.evaluate(async () => { const e = window.checkEditor(); const r = await (await import("/src/lib/sqlAssistProvider.ts")).provideSqlAssist(e.getModel(), e.getPosition(), { triggerKind: 0 }, { isCancellationRequested: false }); return r.suggestions.map(s => s.insertText); });
    assert.equal(dateItems.some(s => s.includes("CURRENT_DATE")), false); passed.push("NC character dates do not receive guessed calendar presets");
    assert.deepEqual(errors, []); await writeFile(new URL("验收结果.json", artifacts), JSON.stringify({ passed, errors }, null, 2)); console.log(JSON.stringify({ passed, errors }));
  } catch (error) { await page.screenshot({ path: fileURLToPath(new URL("失败现场.png", artifacts)) }); console.error(JSON.stringify({ errors, sql: await state() })); throw error; }
  finally { await browser.close(); }
});
