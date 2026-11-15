// Formal app and Monaco with isolated IPC fixtures; no business database is contacted.
/* global window, document */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.GLASS_PREVIEW_URL || "http://127.0.0.1:1435";
const artifacts = new URL("../../docs/主子表单号查询验收-2026-11-13/", import.meta.url);
const fixture = await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
const matched = fixture.match(/const bootstrap=`([\s\S]*?)`;/);
assert.ok(matched);
const rootColumns = ["VBILLCODE", "PK_ORDER"].map(name => ({ name, type: "VARCHAR2", full: "VARCHAR2(30)", zh: name === "VBILLCODE" ? "单据号" : "订单主键", pk: name === "PK_ORDER" }));
const bodyColumns = ["PK_ORDER_B", "PK_ORDER", "NNUM"].map(name => ({ name, type: name === "NNUM" ? "NUMBER" : "VARCHAR2", full: name === "NNUM" ? "NUMBER" : "VARCHAR2(30)", zh: name === "NNUM" ? "数量" : "主键", pk: name === "PK_ORDER_B" }));
rootColumns.push(...[{ name: "PK_ORG", full: "VARCHAR2(20)", zh: "组织" }, { name: "CREATED_AT", full: "DATE", zh: "创建日期" }, { name: "DBILLDATE", full: "CHAR(19)", zh: "单据日期" }].map(c => ({ ...c, type: c.full, pk: false })));
bodyColumns.push({ name: "PK_MATERIAL", type: "VARCHAR2", full: "VARCHAR2(20)", zh: "物料", pk: false });
const fields = names => names.map(name => ({ name, type: "VARCHAR2", full: "VARCHAR2(30)", pk: false, zh: null }));
const schemaColumns = { po_order: rootColumns, po_order_b: bodyColumns,
  so_sale: fields(["VBILLCODE", "SALE_ID"]), sale_details: fields(["HEAD_REF"]), sale_tax: fields(["SALE_REF"]),
  ic_receipt: fields(["VBILLCODE", "RECEIPT_KEY"]), warehouse_rows: fields(["RECEIPT_REF"]),
  custom_head: fields(["HEAD_ID", "NAME"]), custom_lines: fields(["PARENT_ID"]) };
const schemaNames = { po_order: "采购订单", po_order_b: "采购订单子表", so_sale: "销售订单", sale_details: "销售明细", sale_tax: "税额明细", ic_receipt: "入库单", warehouse_rows: "入库明细", custom_head: "通用主表", custom_lines: "通用明细" };
const relationRows = [
  ["order_head", "PO_ORDER_B", "PK_ORDER", "PO_ORDER", "PK_ORDER", 1],
  ["sale_head", "SALE_DETAILS", "HEAD_REF", "SO_SALE", "SALE_ID", 1],
  ["sale_tax", "SALE_TAX", "SALE_REF", "SO_SALE", "SALE_ID", 1],
  ["receipt_head", "WAREHOUSE_ROWS", "RECEIPT_REF", "IC_RECEIPT", "RECEIPT_KEY", 1],
  ["custom_parent", "CUSTOM_LINES", "PARENT_ID", "CUSTOM_HEAD", "HEAD_ID", 1],
];
const relationHeaders = ["RELATION", "SOURCE_TABLE", "SOURCE_COLUMN", "TARGET_TABLE", "TARGET_COLUMN", "POSITION"];
const example = "ASSCG2026110800000005";
const expected = "SELECT a.*, b.*\nFROM po_order a\nLEFT JOIN po_order_b b\n    ON a.pk_order = b.pk_order\nWHERE a.vbillcode = '';";
const execCommands = ["db_exec", "db_exec_bound", "db_exec_result"];
const bootstrap = matched[1]
  .replace("if(cmd==='get_autostart')", "if(cmd==='check_update') return null; if(cmd==='get_autostart')")
  .replace("return {url:conn.url,user:conn.user,autoCommit:false};", "return {url:conn.url,user:conn.user,schema:'NC_TEST',autoCommit:false};")
  .replace("if(cmd==='db_tx') return {tx:tx()};", "if(cmd==='db_slot_acquire') return {slot:'sql-bill-1',tx:tx()}; if(cmd==='db_slot_release') return null; if(cmd==='db_tx') return {tx:tx()};")
  .replace("[{name:'TEST_TABLE',kind:'TABLE'},{name:'TEST_CHILD',kind:'TABLE'}]", JSON.stringify(Object.keys(schemaColumns).map(name => ({ name: name.toUpperCase(), kind: "TABLE" }))))
  .replace("{test_table:'测试主表',test_child:'测试子表'}", JSON.stringify(schemaNames))
  .replace("if(args.kind==='tables')", "if(args.kind==='schemas') return {schemas:['NC_TEST','OTHER'],current:'NC_TEST',user:'NC_TEST'}; if(args.kind==='tables')")
  .replace("if(args.kind==='columns') return {columns};", `if(args.kind==='columns') return {columns:${JSON.stringify(schemaColumns)}[String(args.arg).toLowerCase()] || []};`)
  .replace(/if\(cmd==='db_relations'\)[^\n]+/, `if(cmd==='db_relations') return {foreign:{kind:'rows',columns:[],rows:[],hasMore:false},references:{kind:'rows',columns:${JSON.stringify(relationHeaders)}.map(name=>({name,type:'VARCHAR2'})),rows:window.billNoRelations?[]:${JSON.stringify(relationRows)}.filter(r=>[r[1],r[3]].includes(String(args.table).toUpperCase())),hasMore:false},notes:[],sharedSession:false};`)
  .replace("if(cmd==='db_exec_bound')", "if(cmd==='db_exec' || cmd==='db_exec_result' || cmd==='db_exec_bound')")
  .replace("return {kind:'rows',columns,rows:[[1,'A','甲'],[2,'B','乙'],[3,'C','丙']],hasMore:false,ms:10,tx:tx()};", `return {kind:'rows',columns:${JSON.stringify([...rootColumns, ...bodyColumns])},rows:${JSON.stringify([120, 80, 200].map((n, i) => [...rootColumns, ...bodyColumns].map(c => ({ VBILLCODE: example, PK_ORDER: "O1", PK_ORDER_B: "B" + (i + 1), NNUM: n, PK_ORG: "ORG1", PK_MATERIAL: "MAT1", CREATED_AT: "2026-11-01", DBILLDATE: "2026-11-01" })[c.name])))},hasMore:false,ms:10,output:[],tx:tx()};`)
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'',results:[],output:[]}");

test("bill query completion inserts literal SQL, places caret in quotes, and executes without parameter UI", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = [], passed = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route(origin + "/", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, () => '<script type="module">' + bootstrap + '</script>');
    assert.ok(body.includes("sql-bill-1"));
    await route.fulfill({ response, body });
  });
  const editorState = () => page.evaluate(() => {
    const editor = window.billMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor"));
    const model = editor.getModel(), selection = editor.getSelection();
    const rawSql = model.getValue();
    return { rawSql, sql: rawSql.replace(/\r\n/g, "\n"), start: model.getOffsetAt(selection.getStartPosition()), end: model.getOffsetAt(selection.getEndPosition()) };
  });
  async function suggest(sql, offset = sql.length) {
    await page.evaluate(async ({ sql, offset }) => {
      const editor = window.billMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor"));
      editor.trigger("acceptance", "hideSuggestWidget", {});
      editor.getModel().setValue(sql);
      editor.setPosition(editor.getModel().getPositionAt(offset)); editor.focus();
      // Prime the same production provider before opening the visible suggestion snapshot.
      const { provideSqlAssist } = await import("/src/lib/sqlAssistProvider.ts");
      await provideSqlAssist(editor.getModel(), editor.getPosition(), { triggerKind: 0 }, { isCancellationRequested: false });
    }, { sql, offset });
    await page.keyboard.press("Control+Space");
    const rows = page.locator(".suggest-widget.visible .monaco-list-row");
    await rows.first().waitFor();
    return rows;
  }
  async function accept(rows, label) {
    const index = (await rows.allInnerTexts()).findIndex(text => text.includes(label));
    assert.ok(index >= 0, "missing suggestion: " + label);
    for (let n = 0; n < index; n++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
  }
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click({ timeout: 30000 });
    await page.locator("#dbx-conn-c").click({ timeout: 30000 });
    await page.getByRole("textbox", { name: "SQL 查询编辑器", exact: true }).waitFor({ timeout: 30000 });
    await page.evaluate(async () => { window.billDb = await import("/src/lib/dbStore.ts"); window.billMonaco = (await import("/src/lib/monacoSetup.ts")).monaco; });
    await page.waitForFunction(count => window.billDb.rtOf("c").currentSchema === "NC_TEST" && window.billDb.rtOf("c").tables?.length === count, Object.keys(schemaColumns).length);
    let rows = await suggest("po_order");
    await accept(rows, "采购订单 · 按单号关联 采购订单子表");
    let state = await editorState();
    assert.equal(state.sql, expected);
    assert.equal(state.start, state.rawSql.lastIndexOf("''") + 1);
    assert.equal(state.start, state.end);
    assert.equal(await page.evaluate(commands => window.dbCalls.filter(c => commands.includes(c.cmd)).length, execCommands), 0);
    assert.equal(await page.getByRole("dialog", { name: "填写查询参数" }).count(), 0);
    passed.push("template accepted without execution; caret is between empty quotes");
    await page.screenshot({ path: fileURLToPath(new URL("主子表模板.png", artifacts)) });
    await page.keyboard.insertText(example);
    state = await editorState();
    assert.equal(state.sql, expected.replace("= ''", "= '" + example + "'"));
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(({ commands, bill }) => window.dbCalls.some(c => commands.includes(c.cmd) && c.args.sql.includes(bill)), { commands: execCommands, bill: example });
    assert.equal(await page.getByRole("dialog", { name: "填写查询参数" }).count(), 0);
    passed.push("manual bill literal executes through the existing SQL path without parameter dialog");
    await page.screenshot({ path: fileURLToPath(new URL("手工单号查询.png", artifacts)) });
    await page.keyboard.press("Control+z");
    assert.equal((await editorState()).sql, expected);
    passed.push("undo removes manual bill without losing the template");
    rows = await suggest("采购订单"); await accept(rows, "采购订单 · 按单号关联 采购订单子表");
    assert.equal((await editorState()).sql, expected);
    passed.push("exact Chinese main-table name also finds the template");
    const script = "SELECT 1 FROM dual;\npo_order;";
    rows = await suggest(script, script.length - 1); await accept(rows, "采购订单 · 按单号关联 采购订单子表");
    assert.equal((await editorState()).sql, "SELECT 1 FROM dual;\n" + expected);
    passed.push("existing neighboring statement and semicolon are preserved");
    rows = await suggest("SELECT a.*, b.* FROM po_order a LEFT JOIN po_order_b b ON a.pk_order=b.pk_order WHERE 单号");
    await accept(rows, "单据号过滤");
    state = await editorState();
    assert.ok(state.sql.endsWith("WHERE a.VBILLCODE = ''"));
    assert.equal(state.sql.slice(state.start - 1, state.end + 1), "''");
    passed.push("WHERE keyword assistance inserts the alias-qualified field and quote caret");
    rows = await suggest("SELECT * FROM po_order");
    assert.equal((await rows.allInnerTexts()).some(text => text.includes("按单号")), false);
    passed.push("FROM suggestions remain table names");
    rows = await suggest("po_order"); await accept(rows, "采购订单 · 关联查询 采购订单子表");
    state = await editorState();
    assert.equal(state.sql, expected.replace("a.vbillcode = ''", ""));
    assert.equal(state.start, state.rawSql.lastIndexOf("WHERE ") + 6);
    await page.locator(".suggest-widget.visible").waitFor();
    passed.push("general query opens the field picker automatically at WHERE");
    await page.screenshot({ path: fileURLToPath(new URL("通用查询字段候选.png", artifacts)) });
    await page.keyboard.insertText("物料");
    rows = page.locator(".suggest-widget.visible .monaco-list-row");
    await rows.filter({ hasText: "pk_material · 等于" }).first().waitFor();
    await accept(rows, "pk_material · 等于");
    state = await editorState();
    assert.ok(state.sql.endsWith("WHERE b.pk_material = '';"));
    assert.equal(state.start, state.rawSql.lastIndexOf("''") + 1);
    await page.keyboard.insertText("MAT1");
    await page.keyboard.press("End"); await page.keyboard.press("ArrowLeft");
    await page.keyboard.insertText("\n  AND 数量");
    await rows.filter({ hasText: "nnum · 大于" }).first().waitFor();
    await accept(rows, "nnum · 大于");
    assert.ok((await editorState()).sql.endsWith("AND b.nnum > ;"));
    await page.keyboard.insertText("100");
    await page.keyboard.press("End"); await page.keyboard.press("ArrowLeft");
    await page.keyboard.insertText("\n  AND 组织");
    await rows.filter({ hasText: "pk_org · 等于" }).first().waitFor();
    await accept(rows, "pk_org · 等于"); await page.keyboard.insertText("ORG1");
    state = await editorState();
    assert.ok(state.sql.replace(/\n[ \t]+/g, "\n").endsWith("WHERE b.pk_material = 'MAT1'\nAND b.nnum > 100\nAND a.pk_org = 'ORG1';"));
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(commands => window.dbCalls.some(c => commands.includes(c.cmd) && c.args.sql.includes("b.nnum > 100") && c.args.sql.includes("a.pk_org = 'ORG1'")), execCommands);
    assert.equal(await page.getByRole("dialog", { name: "填写查询参数" }).count(), 0);
    passed.push("Chinese field search composes child text, numeric and parent conditions and executes literal SQL");
    await page.screenshot({ path: fileURLToPath(new URL("通用多条件查询.png", artifacts)) });
    rows = await suggest("SELECT * FROM po_order a WHERE 创建日期"); await accept(rows, "created_at · 时间范围");
    await page.keyboard.insertText("2026-11-01"); await page.keyboard.press("Tab"); await page.keyboard.insertText("2026-12-01");
    assert.equal((await editorState()).sql, "SELECT * FROM po_order a WHERE a.created_at >= DATE '2026-11-01' AND a.created_at < DATE '2026-12-01'");
    rows = await suggest("SELECT * FROM po_order a WHERE 单据日期"); await accept(rows, "dbilldate · 等于");
    assert.equal((await editorState()).sql, "SELECT * FROM po_order a WHERE a.dbilldate = ''");
    passed.push("date range Tab stops work while NC character dates remain quoted text");
    rows = await suggest("SELECT * FROM po_order a WHERE a.pk_org "); await accept(rows, "IN · 值列表");
    await page.keyboard.insertText("ORG1"); await page.keyboard.press("Tab"); await page.keyboard.insertText("ORG2");
    assert.equal((await editorState()).sql, "SELECT * FROM po_order a WHERE a.pk_org IN ('ORG1', 'ORG2')");
    passed.push("operator picker preserves the typed field and fills IN values through Tab");
    rows = await suggest("SELECT * FROM po_order a LEFT JOIN po_order_b b ON a.pk_order=b.pk_order AND 物料");
    await accept(rows, "pk_material · 等于");
    assert.equal((await editorState()).sql, "SELECT * FROM po_order a LEFT JOIN po_order_b b ON a.pk_order=b.pk_order AND b.pk_material = ''");
    passed.push("ON filters stay inside ON without changing LEFT JOIN semantics");
    rows = await suggest("custom_head"); await accept(rows, "通用主表 · 关联查询 通用明细");
    assert.equal((await editorState()).sql, "SELECT a.*, b.*\nFROM custom_head a\nLEFT JOIN custom_lines b\n    ON a.head_id = b.parent_id\nWHERE ;");
    passed.push("a table without vbillcode can generate the same general query");
    rows = await suggest("销售订单");
    assert.equal((await rows.allInnerTexts()).filter(text => text.includes("按单号关联")).length, 2);
    await page.screenshot({ path: fileURLToPath(new URL("销售单关联候选.png", artifacts)) });
    await accept(rows, "销售订单 · 按单号关联 销售明细");
    state = await editorState();
    assert.equal(state.sql, "SELECT a.*, b.*\nFROM so_sale a\nLEFT JOIN sale_details b\n    ON a.sale_id = b.head_ref\nWHERE a.vbillcode = '';");
    assert.equal(state.start, state.rawSql.lastIndexOf("''") + 1);
    passed.push("sales bill lists two independent related-table choices and inserts the selected column pair");
    rows = await suggest("ic_receipt"); await accept(rows, "入库单 · 按单号关联 入库明细");
    state = await editorState();
    assert.equal(state.sql, "SELECT a.*, b.*\nFROM ic_receipt a\nLEFT JOIN warehouse_rows b\n    ON a.receipt_key = b.receipt_ref\nWHERE a.vbillcode = '';");
    assert.equal(state.start, state.rawSql.lastIndexOf("''") + 1);
    await page.screenshot({ path: fileURLToPath(new URL("入库单模板.png", artifacts)) });
    passed.push("receipt bill with unrelated table and key names uses the same generic assistance");
    await page.evaluate(async () => { window.billNoRelations = true; (await import("/src/lib/sqlBusiness.ts")).clearSqlBusinessCache(); });
    rows = await suggest("po_order");
    assert.equal((await rows.allInnerTexts()).some(text => text.includes("按单号关联")), false);
    await accept(rows, "采购订单 · 按单号查主表");
    assert.equal((await editorState()).sql, "SELECT a.*\nFROM po_order a\nWHERE a.vbillcode = '';");
    passed.push("missing metadata falls back to main-table query even for purchase orders");
    await page.evaluate(async () => { window.billNoRelations = false; (await import("/src/lib/sqlBusiness.ts")).clearSqlBusinessCache(); });
    rows = await suggest("po_order"); await accept(rows, "采购订单 · 按单号关联 采购订单子表");
    await page.setViewportSize({ width: 850, height: 780 });
    await page.screenshot({ path: fileURLToPath(new URL("窄窗模板.png", artifacts)) });
    await page.evaluate(async () => (await import("/src/lib/theme.ts")).applyTheme("dark"));
    await page.waitForFunction(() => document.documentElement.classList.contains("dark") && !document.documentElement.classList.contains("theme-transition"));
    await page.screenshot({ path: fileURLToPath(new URL("深色模板.png", artifacts)) });
    assert.deepEqual(errors, []);
    await writeFile(new URL("验收结果.json", artifacts), JSON.stringify({ passed, errors }, null, 2));
    console.log(JSON.stringify({ passed, errors }));
  } catch (error) {
    console.error(JSON.stringify({ errors, body: (await page.locator("body").innerText()).slice(0, 1200) }));
    throw error;
  } finally { await browser.close(); }
});
