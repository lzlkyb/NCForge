// Real editor workflows with isolated database/IPC fixtures; no business database is contacted.
/* global window */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.GLASS_PREVIEW_URL || "http://127.0.0.1:1435";
const artifacts = new URL("../../docs/实用查询辅助验收-2026-11-13/", import.meta.url);
const fixture = await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
const matched = fixture.match(/const bootstrap=`([\s\S]*?)`;/);
assert.ok(matched);
const col = (name, zh, pk = false, type = "VARCHAR2") => ({ name, zh, pk, type, full: type === "NUMBER" ? type : `${type}(30)`, nullable: true });
const schemaColumns = {
  doc_head: [col("HEAD_KEY", "主键", true), col("BILL_NUMBER", "单号")],
  doc_rows: [col("ROW_KEY", "主键", true), col("HEAD_REF", "主表"), col("ITEM_REF", "物料"), col("QTY", "数量", false, "NUMBER")],
  catalog_item: [col("ITEM_KEY", "主键", true), col("ITEM_NUMBER", "物料编码"), col("ITEM_TITLE", "物料名称")],
};
const schemaNames = { doc_head: "通用单据", doc_rows: "单据明细", catalog_item: "物料档案" };
const headers = ["RELATION", "SOURCE_TABLE", "SOURCE_COLUMN", "TARGET_TABLE", "TARGET_COLUMN", "POSITION"];
const relations = [["parent", "DOC_ROWS", "HEAD_REF", "DOC_HEAD", "HEAD_KEY", 1], ["item", "DOC_ROWS", "ITEM_REF", "CATALOG_ITEM", "ITEM_KEY", 1]];
const execCommands = ["db_exec", "db_exec_bound", "db_exec_result"];
const bootstrap = matched[1]
  .replace("if(cmd==='get_autostart')", "if(cmd==='check_update') return null; if(cmd==='get_autostart')")
  .replace("return {url:conn.url,user:conn.user,autoCommit:false};", "return {url:conn.url,user:conn.user,schema:'NC_TEST',autoCommit:false};")
  .replace("if(cmd==='db_tx') return {tx:tx()};", "if(cmd==='db_slot_acquire') return {slot:'sql-practical-1',tx:tx()}; if(cmd==='db_slot_release') return null; if(cmd==='db_tx') return {tx:tx()};")
  .replace("[{name:'TEST_TABLE',kind:'TABLE'},{name:'TEST_CHILD',kind:'TABLE'}]", JSON.stringify(Object.keys(schemaColumns).map(name => ({ name: name.toUpperCase(), kind: "TABLE" }))))
  .replace("{test_table:'测试主表',test_child:'测试子表'}", JSON.stringify(schemaNames))
  .replace("if(args.kind==='tables')", "if(args.kind==='schemas') return {schemas:['NC_TEST','OTHER'],current:'NC_TEST',user:'NC_TEST'}; if(args.kind==='tables')")
  .replace("if(args.kind==='columns') return {columns};", `if(args.kind==='columns') return {columns:${JSON.stringify(schemaColumns)}[String(args.arg).toLowerCase()] || []};`)
  .replace(/if\(cmd==='db_relations'\)[^\n]+/, `if(cmd==='db_relations') return {foreign:{kind:'rows',columns:${JSON.stringify(headers)}.map(name=>({name,type:'VARCHAR2'})),rows:window.noPracticalRelations?[]:${JSON.stringify(relations)}.filter(r=>[r[1],r[3]].includes(String(args.table).toUpperCase())),hasMore:false},references:{kind:'rows',columns:[],rows:[],hasMore:false},notes:[],sharedSession:false};`)
  .replace("if(cmd==='db_exec_bound')", "if(cmd==='db_exec' || cmd==='db_exec_result' || cmd==='db_exec_bound')")
  .replace("hasMore:false,ms:10,tx:tx()", "hasMore:false,ms:10,output:[],tx:tx()")
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'',results:[],output:[]}");

test("practical SQL assistance preserves detail rows, typed batch literals and archive join integrity", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = [], passed = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route(origin + "/", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, () => '<script type="module">' + bootstrap + '</script>');
    assert.ok(body.includes("sql-practical-1"));
    await route.fulfill({ response, body });
  });
  const state = () => page.evaluate(() => {
    const editor = window.practicalEditor(), model = editor.getModel(), selection = editor.getSelection();
    const raw = model.getValue();
    return { sql: raw.replace(/\r\n/g, "\n"), start: model.getOffsetAt(selection.getStartPosition()), end: model.getOffsetAt(selection.getEndPosition()), raw };
  });
  async function setSql(sql, start = sql.length, end = start) {
    await page.evaluate(({ sql, start, end }) => {
      const editor = window.practicalEditor(), model = editor.getModel();
      editor.trigger("acceptance", "hideSuggestWidget", {}); model.setValue(sql);
      const a = model.getPositionAt(start), b = model.getPositionAt(end);
      editor.setSelection(new window.practicalMonaco.Range(a.lineNumber, a.column, b.lineNumber, b.column)); editor.focus();
    }, { sql, start, end });
  }
  async function suggest(sql, offset = sql.length) {
    await setSql(sql, offset);
    await page.evaluate(async () => {
      const editor = window.practicalEditor();
      const { provideSqlAssist } = await import("/src/lib/sqlAssistProvider.ts");
      await provideSqlAssist(editor.getModel(), editor.getPosition(), { triggerKind: 0 }, { isCancellationRequested: false });
    });
    await page.keyboard.press("Control+Space");
    const rows = page.locator(".suggest-widget.visible .monaco-list-row");
    await rows.first().waitFor(); return rows;
  }
  async function accept(rows, label) {
    const index = (await rows.allInnerTexts()).findIndex(text => text.includes(label));
    assert.ok(index >= 0, "missing suggestion: " + label);
    for (let n = 0; n < index; n++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
  }
  async function batch(sql, selected) {
    const start = sql.indexOf(selected);
    await setSql(sql, start, start + selected.length);
    await page.evaluate(async () => window.practicalEditor().getAction("ncforge.sql.batchIn").run());
    return (await state()).sql;
  }
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click({ timeout: 30000 });
    await page.locator("#dbx-conn-c").click({ timeout: 30000 });
    await page.getByRole("textbox", { name: "SQL 查询编辑器", exact: true }).waitFor({ timeout: 30000 });
    await page.evaluate(async () => {
      window.practicalDb = await import("/src/lib/dbStore.ts");
      window.practicalMonaco = (await import("/src/lib/monacoSetup.ts")).monaco;
      window.practicalEditor = () => window.practicalMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor"));
    });
    await page.waitForFunction(() => window.practicalDb.rtOf("c").currentSchema === "NC_TEST" && window.practicalDb.rtOf("c").tables?.length === 3);
    let rows = await suggest("doc_head");
    await accept(rows, "通用单据 · 按关联条件查完整结果 单据明细");
    let s = await state();
    assert.ok(s.sql.includes("LEFT JOIN doc_rows b\n    ON b.head_ref = a.head_key\nWHERE EXISTS ("));
    assert.equal(s.raw.slice(s.start - 2, s.start), "x.");
    await page.locator(".suggest-widget.visible").waitFor();
    await page.keyboard.insertText("物料");
    rows = page.locator(".suggest-widget.visible .monaco-list-row");
    await rows.filter({ hasText: "item_ref · 等于" }).first().waitFor();
    await accept(rows, "item_ref · 等于");
    await page.keyboard.insertText("MAT1");
    s = await state();
    assert.ok(/AND \(x.item_ref = 'MAT1'\)\s*\);$/.test(s.sql));
    assert.equal(s.sql.includes("b.item_ref ="), false);
    passed.push("complete-result template picks x fields and filters only inside EXISTS");
    await page.evaluate(() => {
      const editor = window.practicalEditor(), model = editor.getModel();
      editor.setPosition(model.getPositionAt(model.getValue().indexOf("'MAT1'") + 6)); editor.focus();
    });
    await page.keyboard.insertText(" OR 数量");
    rows = page.locator(".suggest-widget.visible .monaco-list-row");
    await rows.filter({ hasText: "qty · 大于" }).first().waitFor();
    await accept(rows, "qty · 大于"); await page.keyboard.insertText("0");
    s = await state();
    assert.ok(s.sql.includes("AND (x.item_ref = 'MAT1' OR x.qty > 0)"));
    passed.push("OR remains inside the detail group and cannot bypass the document correlation");
    await page.screenshot({ path: fileURLToPath(new URL("明细条件查完整结果.png", artifacts)) });
    assert.equal(await page.evaluate(commands => window.dbCalls.filter(c => commands.includes(c.cmd)).length, execCommands), 0);
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(commands => window.dbCalls.some(c => commands.includes(c.cmd) && c.args.sql.includes("EXISTS") && c.args.sql.includes("MAT1")), execCommands);
    await page.waitForFunction(() => !window.practicalDb.sqlTabOf("acceptance-table").run);
    assert.equal(await page.evaluate(() => window.practicalDb.sqlTabOf("acceptance-table").results.at(-1)?.kind), "rows");
    assert.equal(await page.getByRole("dialog", { name: "填写查询参数" }).count(), 0);
    passed.push("manual literal executes through normal query path without parameter UI");

    const pasted = "001\n002\n001\nO'Brien", batchSql = `SELECT * FROM doc_rows b WHERE b.item_ref\n${pasted};`;
    assert.equal(await batch(batchSql, pasted), "SELECT * FROM doc_rows b WHERE b.item_ref IN ('001', '002', 'O''Brien');");
    await page.screenshot({ path: fileURLToPath(new URL("批量条件转换.png", artifacts)) });
    await page.keyboard.press("Control+z"); assert.equal((await state()).sql, batchSql);
    passed.push("batch action preserves leading zeros, escapes quotes, deduplicates and undoes in one step");
    assert.equal(await batch("SELECT * FROM doc_rows b WHERE b.qty IN (10\n20\n10);", "10\n20\n10"), "SELECT * FROM doc_rows b WHERE b.qty IN (10, 20);");
    passed.push("numeric metadata generates raw numeric IN values");
    const many = Array.from({ length: 1001 }, (_, i) => String(i + 1)).join("\n");
    const big = await batch(`SELECT * FROM doc_rows b WHERE b.head_ref='H1' AND NOT b.qty\n${many};`, many);
    assert.ok(big.includes("AND NOT (b.qty IN (1, 2"));
    assert.ok(big.endsWith("\n OR b.qty IN (1001));"));
    passed.push("Oracle 1001 values form grouped OR lists under the existing AND NOT");

    const archiveSql = "SELECT b.item_ref FROM doc_rows b WHERE b.head_ref='H1';";
    rows = await suggest(archiveSql, archiveSql.indexOf("item_ref") + 8);
    await accept(rows, "b.item_ref · 展开档案编码和名称");
    s = await state();
    assert.ok(s.sql.startsWith("SELECT b.item_ref,\n"));
    assert.ok(s.sql.includes("ref1.item_number AS item_ref_code"));
    assert.ok(s.sql.includes("ref1.item_title AS item_ref_name"));
    assert.ok(s.sql.includes("LEFT JOIN catalog_item ref1\n    ON b.item_ref = ref1.item_key\nWHERE b.head_ref='H1';"));
    await page.screenshot({ path: fileURLToPath(new URL("档案编码名称展开.png", artifacts)) });
    await page.keyboard.press("Control+z"); assert.equal((await state()).sql, archiveSql);
    passed.push("archive completion inserts fields and LEFT JOIN together and undoes atomically");
    const reuseSql = "SELECT b.item_ref FROM doc_rows b LEFT JOIN catalog_item m ON b.item_ref = m.item_key WHERE b.qty > 0;";
    rows = await suggest(reuseSql, reuseSql.indexOf("item_ref") + 8); await accept(rows, "b.item_ref · 展开档案编码和名称");
    s = await state(); assert.equal(s.sql.split("LEFT JOIN").length, 2); assert.ok(s.sql.includes("m.item_title AS item_ref_name"));
    passed.push("matching existing LEFT JOIN is reused");
    rows = await suggest("SELECT DISTINCT b.item_ref FROM doc_rows b", 26);
    assert.equal((await rows.allInnerTexts()).some(t => t.includes("展开档案")), false);
    passed.push("DISTINCT results do not get archive edits");
    await page.evaluate(async () => { window.noPracticalRelations = true; (await import("/src/lib/sqlBusiness.ts")).clearSqlBusinessCache(); });
    rows = await suggest(archiveSql, archiveSql.indexOf("item_ref") + 8);
    assert.equal((await rows.allInnerTexts()).some(t => t.includes("展开档案")), false);
    passed.push("no relationship evidence means no archive candidate");
    assert.deepEqual(errors, []);
    await writeFile(new URL("验收结果.json", artifacts), JSON.stringify({ passed, errors }, null, 2));
    console.log(JSON.stringify({ passed, errors }));
  } catch (error) {
    await page.screenshot({ path: fileURLToPath(new URL("失败现场.png", artifacts)) });
    console.error(JSON.stringify({ errors, state: await state() })); throw error;
  } finally { await browser.close(); }
});
