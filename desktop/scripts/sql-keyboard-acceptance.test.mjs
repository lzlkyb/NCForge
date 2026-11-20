// The app uses real Monaco and the shared workbench IPC fixture. No external database is required.
/* global window, getComputedStyle */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.GLASS_PREVIEW_URL || "http://127.0.0.1:1435";
const artifacts = new URL(process.env.UI_ARTIFACT_DIR || "../../.codex-artifacts/sql-keyboard-assist/", import.meta.url);
const fixture = await readFile(new URL("./db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
const matched = fixture.match(/const bootstrap=`([\s\S]*?)`;/);
assert.ok(matched);
const tables = {
  so_saleorder: "销售订单",
  so_saleorder_b: "销售订单明细",
  po_order: "采购订单",
  po_alt_order: "其他采购主表",
  po_order_b: "采购订单明细",
  key_child: "键字段明细",
  key_parent: "键字段主表",
  join_order: "采购单",
  join_country: "国家地区",
  join_store: "收货仓库",
  join_org: "仓库所属组织",
};
const column = (name, type, pk = false) => ({ name, type, full: type, pk });
const schemaColumns = Object.fromEntries(Object.keys(tables).map(name => [name, [
  column("PK_ORDER", "VARCHAR2", !name.endsWith("_b")),
  name.endsWith("_b") ? column("NNUM", "NUMBER") : column("VBILLCODE", "VARCHAR2"),
  ...Array.from({length:name === "po_order_b" ? 252 : 0}, (_, i) => column(`ITEM_FIELD_${i + 1}`, "VARCHAR2")),
]]));
schemaColumns.key_child = [column("AA_PLAIN", "VARCHAR2"), column("LINE_KEY", "VARCHAR2", true),
  column("SHARED_KEY", "VARCHAR2", true), column("PARENT_REFERENCE", "VARCHAR2")];
const foreignRows = [
  ["key_pair", "KEY_CHILD", "SHARED_KEY", "KEY_PARENT", "PK_ORDER", 1],
  ["key_pair", "KEY_CHILD", "PARENT_REFERENCE", "KEY_PARENT", "VBILLCODE", 2],
  ["tax_country", "JOIN_ORDER", "CTAXCOUNTRYID", "JOIN_COUNTRY", "PK_ORDER", 1],
  ["origin_country", "JOIN_ORDER", "CORIGCOUNTRYID", "JOIN_COUNTRY", "PK_ORDER", 1],
  ["warehouse", "JOIN_ORDER", "PK_STORE", "JOIN_STORE", "PK_ORDER", 1],
  ["warehouse_org", "JOIN_STORE", "PK_ORG", "JOIN_ORG", "PK_ORDER", 1],
];
const relationRows = [
  ["detail_order", "SO_SALEORDER_B", "PK_ORDER", "SO_SALEORDER", "PK_ORDER", 1],
  ["detail_purchase", "PO_ORDER_B", "PK_ORDER", "PO_ORDER", "PK_ORDER", 1],
  ["detail_other", "PO_ORDER_B", "PK_ORDER", "PO_ALT_ORDER", "PK_ORDER", 1],
];
const relationHeaders = ["RELATION", "SOURCE_TABLE", "SOURCE_COLUMN", "TARGET_TABLE", "TARGET_COLUMN", "POSITION"];
const execCommands = ["db_exec", "db_exec_bound", "db_exec_result"];
const bootstrap = matched[1]
  .replace("if(cmd==='get_autostart')", "if(cmd==='check_update') return null; if(cmd==='get_autostart')")
  .replace("return {url:conn.url,user:conn.user,autoCommit:false};", "return {url:conn.url,user:conn.user,schema:'NC_TEST',autoCommit:false};")
  .replace("if(cmd==='db_tx') return {tx:tx()};", "if(cmd==='db_slot_acquire') return {slot:'sql-keyboard-1',tx:tx()}; if(cmd==='db_slot_release') return null; if(cmd==='db_tx') return {tx:tx()};")
  .replace("if(cmd==='db_exec_bound')", "if(cmd==='db_result_close') return null; if(cmd==='db_exec_result') return {kind:'rows',columns,rows:[[1,'A','甲']],hasMore:false,ms:10,tx:tx(),output:[]}; if(cmd==='db_exec_bound')")
  .replace("[{name:'TEST_TABLE',kind:'TABLE'},{name:'TEST_CHILD',kind:'TABLE'}]", JSON.stringify(Object.keys(tables).map(name => ({ name: name.toUpperCase(), kind: "TABLE" }))))
  .replace("{test_table:'测试主表',test_child:'测试子表'}", JSON.stringify(tables))
  .replace("if(args.kind==='tables')", "if(args.kind==='schemas') return {schemas:['NC_TEST'],current:'NC_TEST',user:'NC_TEST'}; if(args.kind==='tables')")
  .replace("if(args.kind==='columns') return {columns};", `if(args.kind==='columns') return {columns:${JSON.stringify(schemaColumns)}[String(args.arg).toLowerCase()] || []};`)
  .replace(/if\(cmd==='db_relations'\)[^\n]+/, `if(cmd==='db_relations') return {
    foreign:{kind:'rows',columns:${JSON.stringify(relationHeaders)}.map(name=>({name,type:'VARCHAR2'})),
      rows:${JSON.stringify(foreignRows)}.filter(r=>[r[1],r[3]].includes(String(args.table).toUpperCase())),hasMore:false},
    references:{kind:'rows',columns:${JSON.stringify(relationHeaders)}.map(name=>({name,type:'VARCHAR2'})),
      rows:${JSON.stringify(relationRows)}.filter(r=>[r[1],r[3]].includes(String(args.table).toUpperCase())),hasMore:false},
    notes:[],sharedSession:false};`)
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'',results:[],output:[]}");

async function openEditor(page, source = bootstrap, tableCount = Object.keys(schemaColumns).length) {
  page.setDefaultTimeout(8500);
  await page.route(origin+"/",async route=>{
    const response=await route.fetch();
    const body=(await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/,()=>'<script type="module">'+source+'</script>');
    await route.fulfill({response,body});
  });
  await page.goto(origin,{waitUntil:"domcontentloaded",timeout:60000});
  await page.locator(".app-side").getByRole("button",{name:/^数据库/}).click({timeout:40000});
  await page.locator("#dbx-conn-c").click({timeout:45000});
  await page.getByRole("textbox",{name:"SQL 查询编辑器",exact:true}).waitFor();
  await page.evaluate(async()=>{
    const path = "/src/lib/dbStore.ts";
    const store = window.performance.getEntriesByType("resource").find(entry => new URL(entry.name).pathname === path);
    window.billDb = await import(store?.name ?? path);
    window.billMonaco = (await import("/src/lib/monacoSetup.ts")).monaco;
  });
  await page.waitForFunction(n=>window.billDb.rtOf("c").tables?.length===n,tableCount);
  await page.getByRole("button",{name:"选择连接：NC测试库",exact:true}).waitFor();
}

test("SQL editing stays keyboard-driven and uses explicit previews", async () => {
  await mkdir(artifacts,{recursive:true});
  const browser=await chromium.launch({headless:true,channel:"msedge"});
  const page=await browser.newPage({viewport:{width:1440,height:880}});
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  const suggest=page.locator(".dbx-sql-overflow .suggest-widget.visible");
  const selected=suggest.locator(".monaco-list-row.focused");
  const menu=page.locator(".dbx-sql-action-view .action-widget");
  async function select(sql,from=sql.length,to=from){
    await page.evaluate(({sql,from,to})=>{
      const e=window.billMonaco.editor.getEditors().find(editor=>editor.getContainerDomNode().closest(".dbx-editor"));
      const m=e.getModel();
      m.setValue(sql);
      e.setSelection(window.billMonaco.Range.fromPositions(m.getPositionAt(from),m.getPositionAt(to)));
      e.focus();
    },{sql,from,to});
  }
  const read=()=>page.evaluate(()=>window.billMonaco.editor.getEditors().find(editor=>editor.getContainerDomNode().closest(".dbx-editor")).getValue().replace(/\r\n/g,"\n"));
  const action=id=>page.evaluate(id=>window.billMonaco.editor.getEditors().find(e=>e.getContainerDomNode().closest(".dbx-editor")).getAction(id).run(),id);
  async function focus(pattern){
    for(let n=0;n<25;n++){
      if (await selected.count() && pattern.test(await selected.first().innerText())) return;
      await page.keyboard.press("ArrowDown");
    }
    throw Error("没有找到候选 "+pattern+" "+await suggest.innerText());
  }
  async function pick(pattern){
    await focus(pattern);
    await page.keyboard.press("Enter");
  }
  try{
    await openEditor(page);
    const main="SELECT * FROM so_saleorder", detail=suggest.getByText(/追加 LEFT JOIN · 销售订单明细/);
    await select(main.slice(0,-1));
    await page.keyboard.type("r");
    await detail.waitFor();
    await page.screenshot({path:fileURLToPath(new URL("join-suggestions.png",artifacts))});
    await page.keyboard.press("Escape");
    assert.equal(await read(),main);

    await select(main.slice(0,-1));
    await page.keyboard.press("Control+Space");
    await suggest.getByText("so_saleorder",{exact:true}).waitFor();
    await focus(/^so_saleorder\s/);
    assert.equal(await suggest.locator(".dbx-sql-suggest-preview").isVisible(),false);
    await pick(/^so_saleorder\s/);
    await detail.waitFor();
    await page.keyboard.press("Escape");
    await suggest.waitFor({state:"hidden"});
    assert.equal(await read(),main);
    await page.keyboard.press("Control+Space");
    await detail.waitFor();
    await pick(/查看全部关联/);
    await menu.getByRole("checkbox", {name:"销售订单明细 · so_saleorder_b · pk_order",exact:true}).waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});
    assert.equal(await read(),main);
    await page.keyboard.press("Control+Space");
    await detail.waitFor();
    await focus(/销售订单明细/);
    const preview = suggest.locator(".dbx-sql-suggest-preview pre");
    await preview.waitFor();
    assert.equal(await preview.evaluate(node => getComputedStyle(node).whiteSpace), "pre-wrap");
    assert.match(await preview.innerText(), /so_saleorder\.pk_order/);
    assert.equal(await read(),main);
    await page.screenshot({path:fileURLToPath(new URL("join-preview.png",artifacts))});
    await page.keyboard.press("Enter");
    assert.match(await read(),/LEFT JOIN so_saleorder_b ON/);

    await page.keyboard.type(" WHERE ");
    await suggest.waitFor();
    await suggest.getByText("so_saleorder.vbillcode",{exact:true}).waitFor();
    await pick(/^so_saleorder\.vbillcode(?:\s|$)(?!\s*[=<>])/);
    assert.match(await read(),/WHERE so_saleorder\.vbillcode $/);
    await suggest.getByText("= · 等于",{exact:true}).waitFor();
    await pick(/^=(?:\s|$)/);
    assert.match(await read(),/WHERE so_saleorder\.vbillcode\s*= ''$/);

    const joinLine=main+" LEFT JOIN so_saleorder_b b ON";
    await select(joinLine);
    await page.keyboard.press("Space");
    await suggest.getByText("b → so_saleorder · NC类引用",{exact:true}).waitFor();
    await page.keyboard.press("Escape");

    await select(main,main.indexOf("*"));
    await page.keyboard.press("ArrowRight");
    await suggest.getByText(/展开 \* 为字段列表/).waitFor();
    const fieldPreview = preview;
    await fieldPreview.waitFor();
    assert.match(await fieldPreview.textContent(), /^SELECT pk_order,\s+vbillcode FROM so_saleorder$/);
    assert.equal(await page.locator(".suggest-details:visible").count(),0);
    assert.equal(await read(),main);
    await page.keyboard.press("Escape");
    await suggest.waitFor({state:"hidden"});
    assert.equal(await read(),main);
    await page.keyboard.press("Control+Space");
    await fieldPreview.waitFor();
    await pick(/展开 \* 为字段列表/);
    await page.waitForFunction(()=>window.billMonaco.editor.getEditors().find(e=>e.getContainerDomNode().closest(".dbx-editor")).getValue().includes("pk_order"));

    const keywordSource = main + " WHERE exp";
    await select(keywordSource);
    await page.keyboard.press("Control+Space");
    await pick(/展开 \* 为字段列表/);
    await preview.filter({hasText:/SELECT pk_order, vbillcode/}).waitFor();
    assert.equal(await read(), keywordSource);
    await page.keyboard.press("Escape");
    assert.equal(await read(), keywordSource);

    const batch=main+" WHERE so_saleorder.vbillcode \nSO-1\nSO-2";
    await select(batch,batch.indexOf("SO-1"),batch.length);
    assert.equal(await menu.isVisible(),false);
    await page.keyboard.press("Alt+Enter");
    await menu.getByText("转为 IN 条件",{exact:true}).waitFor();
    assert.equal(await menu.locator(".monaco-list-row.focused").count(),0);
    await page.keyboard.press("Enter");
    assert.equal(await read(),batch);
    await page.keyboard.press("ArrowDown");
    await menu.locator(".dbx-sql-action-preview pre").filter({hasText:/so_saleorder.vbillcode IN \('SO-1', 'SO-2'\)/}).waitFor();
    assert.equal(await read(),batch);
    await page.screenshot({path:fileURLToPath(new URL("selection-preview.png",artifacts))});
    await page.keyboard.press("Enter");
    await page.waitForFunction(()=>window.billMonaco.editor.getEditors().find(e=>e.getContainerDomNode().closest(".dbx-editor")).getValue().includes("IN ('SO-1', 'SO-2')"));

    const meaning="SELECT a.* FROM po_order a LEFT JOIN po_order_b b ON a.pk_order=b.pk_order WHERE b.nnum > 0";
    await select(meaning,meaning.indexOf("b.nnum")+2);
    await page.keyboard.press("Alt+Enter");
    await menu.getByText(/将此条件移入 ON/).waitFor();
    await page.keyboard.press("ArrowDown");
    await menu.locator(".dbx-sql-action-preview pre").filter({hasText:/AND \(b\.nnum > 0\)/}).waitFor();
    assert.equal(await read(),meaning);
    await page.screenshot({path:fileURLToPath(new URL("condition-preview.png",artifacts))});
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});
    assert.equal(await read(),meaning);
    await page.keyboard.press("Alt+Enter");
    await menu.getByText(/将此条件移入 ON/).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.billMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor")).getValue().includes("AND (b.nnum > 0)"));
    assert.doesNotMatch(await read(), /\bWHERE\b/);

    const insertSource = "SELECT * FROM so_saleorder;";
    await select(insertSource, insertSource.indexOf("so_saleorder") + 4);
    await action("ncforge.sql.insertTemplate");
    await preview.filter({hasText:/INSERT INTO so_saleorder/}).waitFor();
    assert.match(await preview.textContent(), /VALUES \(PK_ORDER, VBILLCODE\)/);
    assert.equal(await read(), insertSource);
    await page.keyboard.press("Escape");
    await suggest.waitFor({state:"hidden"});
    assert.equal(await read(), insertSource);
    await action("ncforge.sql.insertTemplate");
    await preview.filter({hasText:/INSERT INTO so_saleorder/}).waitFor();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.billMonaco.editor.getEditors().find(e=>e.getContainerDomNode().closest(".dbx-editor")).getValue().includes("INSERT INTO so_saleorder"));
    await page.keyboard.press("Control+z");
    assert.equal(await read(), insertSource);

    const summary = "SELECT b.nnum FROM po_order_b b WHERE b.nnum > 0;";
    await select(summary, summary.indexOf("b.nnum"), summary.indexOf("b.nnum") + "b.nnum".length);
    await action("ncforge.sql.detailSummary");
    const primarySummary = suggest.locator(".monaco-list-row").filter({hasText:/^采购订单\s*PO_ORDER$/});
    const alternativeSummary = suggest.locator(".monaco-list-row").filter({hasText:/^其他采购主表\s*PO_ALT_ORDER$/});
    await primarySummary.waitFor();
    await alternativeSummary.waitFor();
    await preview.filter({hasText:/SUM\(c.NNUM\)/i}).waitFor();
    assert.equal(await read(), summary);
    await page.keyboard.press("Escape");
    await suggest.waitFor({state:"hidden"});
    assert.equal(await read(), summary);
    await action("ncforge.sql.detailSummary");
    await alternativeSummary.waitFor();
    const summaryBox = await suggest.boundingBox();
    await alternativeSummary.hover();
    await preview.filter({hasText:/FROM PO_ALT_ORDER p/i}).waitFor();
    assert.deepEqual(await suggest.boundingBox(), summaryBox);
    await page.screenshot({path:fileURLToPath(new URL("summary-preview.png",artifacts))});
    assert.equal(await read(), summary);
    await page.keyboard.press("Enter");
    assert.match(await read(), /FROM PO_ALT_ORDER p/i);
    await page.keyboard.press("Control+z");
    assert.equal(await read(), summary);

    await page.setViewportSize({width:560,height:650});
    await page.getByRole("button",{name:"关闭资源侧栏"}).click();
    await select(main);
    await page.keyboard.press("Control+Space");
    await detail.waitFor();
    await focus(/销售订单明细/);
    await preview.waitFor();
    for (const popup of [suggest, preview]) {
      const box = await popup.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 561);
    }
    assert.equal(await read(),main);
    await page.keyboard.press("Escape");
    await suggest.waitFor({state:"hidden"});

    const wideTable = "SELECT d.* FROM po_order_b d WHERE d.nnum > 0;";
    await select(wideTable,wideTable.indexOf("*"));
    await page.locator(".ncforge-sql-chip").filter({hasText:/^展开字段$/}).click();
    await fieldPreview.waitFor();
    await suggest.getByText("254 个字段",{exact:true}).waitFor();
    const rowBox = await selected.boundingBox(), previewBox = await fieldPreview.boundingBox(), fieldBox = await suggest.boundingBox();
    assert.ok(rowBox && previewBox && rowBox.x + rowBox.width < previewBox.x);
    assert.ok(fieldBox && fieldBox.x >= 0 && fieldBox.x + fieldBox.width <= 561 && fieldBox.y >= 0 && fieldBox.y + fieldBox.height <= 651);
    assert.match(await fieldPreview.textContent(), /^SELECT d\.pk_order,\s+d\.nnum/);
    assert.match(await fieldPreview.textContent(), /d\.item_field_252 FROM po_order_b d WHERE d\.nnum > 0;?$/);
    assert.equal(await fieldPreview.evaluate(node => node.scrollHeight > node.clientHeight && node.scrollWidth === node.clientWidth), true);
    assert.equal(await read(),wideTable);
    await suggest.screenshot({path:fileURLToPath(new URL("field-expansion-preview.png",artifacts))});
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => window.document.querySelector(".dbx-sql-suggest-preview pre")?.scrollTop > 0);
    assert.equal(await read(),wideTable);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.billMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor")).getValue().includes("d.item_field_252"));
    assert.match(await read(), /^SELECT d\.pk_order, d\.nnum, .*d\.item_field_252 FROM po_order_b d WHERE d\.nnum > 0;$/);
    await page.getByRole("button",{name:"切换深色"}).click();
    await page.evaluate(() => { window.document.documentElement.dataset.uiDensity = "compact"; });
    await select(wideTable,wideTable.indexOf("*"));
    await page.keyboard.press("Control+Space");
    await fieldPreview.waitFor();
    const darkBox = await suggest.boundingBox();
    assert.ok(darkBox && darkBox.x >= 0 && darkBox.x + darkBox.width <= 561);
    await suggest.screenshot({path:fileURLToPath(new URL("field-expansion-dark.png",artifacts))});
    await page.keyboard.press("Escape");
    assert.equal(await read(),wideTable);
    assert.deepEqual(await page.evaluate(commands=>window.dbCalls.filter(call=>commands.includes(call.cmd)),execCommands),[]);
    assert.deepEqual(errors,[]);
  }catch(error){
    console.log("editor SQL",await read().catch(()=>null));
    console.log("suggestions",await suggest.locator(".monaco-list-row").allInnerTexts());
    console.log("actions",await menu.locator(".monaco-list-row.action").allInnerTexts());
    console.log("page errors",errors);
    await page.screenshot({path:fileURLToPath(new URL("failure.png",artifacts))});
    throw error;
  }finally{await browser.close();}
});

test("SQL primary and foreign key labels fit the 560px completion list", async () => {
  await mkdir(artifacts,{recursive:true});
  const browser = await chromium.launch({headless:true,channel:"msedge"});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    await openEditor(page);
    await page.setViewportSize({ width: 560, height: 700 });
    const close = page.getByRole("button",{name:"关闭资源侧栏"});
    if (await close.isVisible()) await close.click();
    const qualified = "SELECT extremely_long_table_alias. FROM key_child extremely_long_table_alias;";
    await page.evaluate(sql => {
      const editor = window.billMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor"));
      editor.setValue(sql);
      editor.setPosition(editor.getModel().getPositionAt(sql.indexOf(". ") + 1));
      editor.focus();
    }, qualified);
    await page.keyboard.press("Control+Space");
    const suggest = page.locator(".dbx-sql-overflow .suggest-widget.visible");
    const row = text => suggest.locator(".monaco-list-row").filter({ hasText: text });
    const both = row(/^shared_key/), fk = row(/^parent_reference/), pk = row(/^line_key/), ordinary = row(/^aa_plain/);
    await both.locator(".dbx-sql-key-badges").waitFor();
    assert.equal(await primaryLabels(both), "主键外键");
    assert.equal(await primaryLabels(pk), "主键");
    assert.equal(await primaryLabels(fk), "外键");
    assert.equal(await ordinary.locator(".dbx-sql-key-badges:visible").count(), 0);
    assert.equal(await both.locator(".codicon-key").count(), 1);
    assert.equal(await fk.locator(".codicon-ncforge-column-foreign").count(), 1);
    assert.match(await both.locator(".dbx-sql-key-badges").getAttribute("title"), /联合主键.*LINE_KEY \+ SHARED_KEY[\s\S]*KEY_PARENT\.PK_ORDER/);
    for (const keyField of [both, fk, pk]) {
      const label = await keyField.locator(".dbx-sql-key-badges").boundingBox();
      const box = await suggest.boundingBox();
      assert.ok(label && box && label.x >= box.x && label.x + label.width <= box.x + box.width);
    }
    await suggest.screenshot({path:fileURLToPath(new URL("column-key-badges.png",artifacts))});
    await both.click();
    await page.waitForFunction(() => window.billMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor")).getValue().includes("extremely_long_table_alias.shared_key"));
  } finally { await browser.close(); }
});

test("SQL assist entries and previews leave the active code visible", async () => {
  await mkdir(artifacts, {recursive:true});
  const browser = await chromium.launch({headless:true,channel:"msedge"});
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = page.locator(".dbx-editor .ncforge-sql-chip");
  const suggest = page.locator(".dbx-sql-overflow .suggest-widget.visible");
  const menu = page.locator(".dbx-sql-action-view .action-widget");
  const edit = (sql, offset, anchor = offset) => page.evaluate(({sql, offset, anchor}) => {
    const editor = window.billMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor"));
    const model = editor.getModel();
    model.setValue(sql);
    const at = model.getPositionAt(offset), from = model.getPositionAt(anchor);
    editor.setScrollLeft(0);
    editor.setSelection(new window.billMonaco.Selection(from.lineNumber, from.column, at.lineNumber, at.column));
    editor.revealPosition(at);
    editor.focus();
  }, {sql, offset, anchor});
  const geometry = () => page.evaluate(() => {
    const editor = window.billMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor"));
    const model = editor.getModel(), at = editor.getPosition(), layout = editor.getLayoutInfo();
    const row = editor.getScrolledVisiblePosition(at), node = editor.getDomNode().getBoundingClientRect();
    const end = editor.getScrolledVisiblePosition({lineNumber:at.lineNumber,column:model.getLineMaxColumn(at.lineNumber)});
    return { top:node.top + row.top, bottom:node.top + row.top + row.height, end:node.left + end.left,
      gutter:node.left + layout.decorationsLeft, text:node.left + layout.contentLeft, selection:editor.getSelection() };
  });
  async function verifyEntry(name, placement) {
    await page.getByRole("button", {name:new RegExp(`^${name} ·`)}).waitFor();
    await page.locator(`.ncforge-sql-chip[data-placement="${placement}"]`).waitFor();
    const box = await button.boundingBox(), bounds = await geometry();
    assert.ok(box && box.y >= bounds.top - 1 && box.y + box.height <= bounds.bottom + 1, `${name} is on the editing row`);
    if (placement === "end") assert.ok(box.x >= bounds.end + 1, `${name} starts after the last SQL character`);
    else assert.ok(box.x >= bounds.gutter && box.x + box.width <= bounds.text, `${name} fits its margin slot`);
  }
  async function verifyPopup(popup, above = false) {
    await popup.waitFor();
    await button.waitFor({state:"hidden"});
    const box = await popup.boundingBox(), bounds = await geometry();
    assert.ok(box && (box.y + box.height <= bounds.top + 1 || !above && box.y >= bounds.bottom - 1),
      `popup overlaps the active line: ${JSON.stringify({box, bounds})}`);
  }
  try {
    await openEditor(page);
    const simple = "SELECT * FROM so_saleorder;";
    await edit(simple, simple.indexOf("*"));
    await verifyEntry("展开字段", "end");
    await page.locator(".dbx-sql-empty-hint").waitFor({state:"hidden"});
    await page.screenshot({path:fileURLToPath(new URL("entry-at-row-end.png", artifacts))});
    await button.click();
    await suggest.getByText("展开 * 为字段列表", {exact:true}).waitFor();
    await verifyPopup(suggest);
    await page.keyboard.press("Escape");
    await verifyEntry("展开字段", "end");

    const aliased = "SELECT * FROM so_saleorder s WHERE s.vbillcode = 'A';";
    await edit(aliased, aliased.indexOf("so_saleorder") + 2);
    await verifyEntry("主子表联查", "end");
    await button.click();
    await verifyPopup(menu);
    await page.keyboard.press("Escape");

    const condition = "SELECT p.* FROM po_order p LEFT JOIN po_order_b d ON p.pk_order = d.pk_order WHERE d.nnum > 0"
      + " AND p.pk_order IS NOT NULL".repeat(8) + ";";
    await edit(condition, condition.indexOf("d.nnum") + 2);
    await verifyEntry("关联修正", "gutter");
    assert.match(await button.getAttribute("title"), /Alt\+Enter$/);
    await button.click();
    await menu.getByText(/将此条件移入 ON/).waitFor();
    await verifyPopup(menu);
    await page.keyboard.press("Escape");

    await page.setViewportSize({width:560,height:600});
    const close = page.getByRole("button", {name:"关闭资源侧栏"});
    if (await close.isVisible()) await close.click();
    const long = "SELECT d.* FROM po_order_b d WHERE " + "d.nnum > 0 AND ".repeat(40) + "d.nnum > 0;";
    await edit(long, long.indexOf("*"));
    await verifyEntry("展开字段", "gutter");
    await page.evaluate(() => window.billMonaco.editor.getEditors()[0].setScrollLeft(540));
    await page.waitForFunction(() => window.billMonaco.editor.getEditors()[0].getScrollLeft() > 0);
    await verifyEntry("展开字段", "gutter");
    await page.evaluate(() => window.billMonaco.editor.getEditors()[0].updateOptions({wordWrap:"on"}));
    await verifyEntry("展开字段", "gutter");
    await page.screenshot({path:fileURLToPath(new URL("entry-in-gutter.png", artifacts))});
    await button.click();
    await suggest.getByText("254 个字段", {exact:true}).waitFor();
    await verifyPopup(suggest);
    await page.keyboard.press("Escape");

    const projection = "SELECT d.pk_order,\n d.nnum\nFROM po_order_b d;";
    await edit(projection, projection.indexOf("d.pk_order"), projection.indexOf("d.nnum") + "d.nnum".length);
    await page.getByRole("button", {name:/^选区操作 ·/}).waitFor();
    const selected = (await geometry()).selection;
    await button.click();
    await menu.getByText(/按所选字段检查重复/).waitFor();
    await verifyPopup(menu);
    assert.deepEqual((await geometry()).selection, selected, "reverse selection survives opening the popup");
    await page.keyboard.press("Escape");
    assert.deepEqual((await geometry()).selection, selected, "reverse selection survives closing the popup");

    await page.getByRole("button", {name:"更多数据库操作"}).click();
    await page.getByRole("menuitem", {name:"专注编辑器"}).click();
    const bottom = "SELECT 1 FROM dual;\n".repeat(45) + simple;
    await edit(bottom, bottom.lastIndexOf("*"));
    await page.keyboard.press("Control+Space");
    await suggest.getByText("展开 * 为字段列表", {exact:true}).waitFor();
    await verifyPopup(suggest, true);
    await page.keyboard.press("Escape");
    await edit(bottom, bottom.lastIndexOf("so_saleorder") + 2);
    await page.keyboard.press("Alt+Enter");
    await menu.getByText("SQL 预览", {exact:true}).waitFor();
    await verifyPopup(menu, true);
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({path:fileURLToPath(new URL("entry-failure.png", artifacts))});
    throw error;
  } finally { await browser.close(); }
});

async function primaryLabels(row) {
  return (await row.locator(".dbx-sql-key-badges > span:visible").allTextContents()).join("");
}

test("Large NC workbench keeps search, follow-up results and disconnected snapshots usable", async () => {
  const browser = await chromium.launch({headless:true,channel:"msedge"});
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixtureTables = JSON.stringify(Object.keys(tables).map(name => ({name:name.toUpperCase(),kind:"TABLE"})));
  const stress = bootstrap.replace(`return {tables:${fixtureTables}}`,
    `return {tables:[...${fixtureTables},...Array.from({length:${15000 - Object.keys(tables).length}},(_,i)=>({name:'FIXTURE_TABLE_'+i,kind:'TABLE'}))]}`)
    .replace("if(cmd==='db_exec_result') return",
      `if(cmd==='db_disconnect') return null;
       if(cmd==='db_exec_result' && /slow_probe/i.test(args.sql)) return new Promise(resolve=>{window.finishSlow=()=>resolve({kind:'rows',columns,rows:[[1,'A','甲']],hasMore:false,ms:100,tx:tx(),output:[]});});
       if(cmd==='db_exec_result' && /^select \\* from po_order/i.test(args.sql)) {
         const wide=['PK_ORDER','VBILLCODE',...Array.from({length:148},(_,i)=>'FIELD_'+i)].map(name=>({name,type:'VARCHAR2',precision:0,scale:0}));
         return {kind:'rows',columns:wide,rows:Array.from({length:500},(_,r)=>wide.map((_,c)=>c===0?'PO-'+r:c===1?'BILL-'+r:'value-'+r+'-'+c)),hasMore:true,ms:12,tx:tx(),output:[]};
       }
       if(cmd==='db_exec_bound') return {kind:'rows',columns:[{name:'PK_ORDER',type:'VARCHAR2'}],rows:[['PO-0']],hasMore:false,ms:12,tx:tx(),output:[]};
       if(cmd==='db_exec_result') return`);
  const grid = page.getByRole("grid", {name:"查询结果网格"});
  const primary = page.locator(".dbx-result-keep:not([hidden])").first();
  const timings = [];
  const editor = sql => page.evaluate(sql => {
    const e = window.billMonaco.editor.getEditors()[0];
    e.setValue(sql); e.setPosition({lineNumber:1,column:3}); e.focus();
  }, sql);
  const run = () => page.getByRole("button",{name:"执行当前语句",exact:true}).click();
  try {
    await openEditor(page, stress, 15000);
    await editor("SELECT * FROM po_order;");
    await run();
    await primary.getByText("已加载 500 行",{exact:true}).waitFor();
    assert.equal(await primary.locator("[role=grid]").getAttribute("aria-colcount"),"151");
    await page.getByRole("button",{name:"查找数据库对象",exact:true}).click();
    const search = page.getByRole("combobox",{name:"查找表名或中文名"});
    await search.fill("po_");
    assert.match(await page.getByRole("listbox",{name:"数据库对象结果"}).getByRole("option",{selected:true}).textContent(),/po_order.*NC_TEST/);
    await page.keyboard.press("Escape");

    await primary.getByRole("button",{name:"筛选已加载行"}).click();
    const filter = primary.getByRole("textbox",{name:"在结果中筛选"});
    await filter.fill("BILL-0");
    await primary.getByText("PO-0",{exact:true}).first().waitFor();
    await primary.getByText("PO-0",{exact:true}).first().click();
    const originalSelection = await primary.locator("[role=grid]").getAttribute("aria-activedescendant");
    assert.ok(originalSelection);
    await primary.getByRole("button",{name:"关联记录",exact:true}).click();
    const related = page.getByRole("dialog",{name:"追查关联记录"});
    await related.locator(".dbx-relation").filter({hasText:"PO_ORDER_B"}).getByRole("button",{name:"查看 SQL"}).click();
    const relationPreview = page.getByRole("dialog",{name:"追查 PO_ORDER_B"});
    assert.match(await relationPreview.getByLabel("SQL 预览",{exact:true}).innerText(),/NC_TEST\.PO_ORDER_B[\s\S]*PK_ORDER = :1/);
    await relationPreview.getByRole("button",{name:"执行查询"}).click();
    const back = page.getByRole("button",{name:"返回来源结果"});
    await back.waitFor();
    assert.deepEqual(await page.evaluate(()=>window.dbCalls.filter(call=>call.cmd==="db_exec_bound").slice(-1)[0].args.params),["PO-0"]);
    await back.click();
    assert.equal(await filter.inputValue(),"BILL-0");
    assert.equal(await primary.locator("[role=grid]").getAttribute("aria-activedescendant"),originalSelection);

    await filter.fill("not-loaded-42");
    await primary.getByText("已读取 500 行，当前范围无匹配。").waitFor();
    await primary.getByRole("button",{name:"数据库重查"}).click();
    const preview = page.getByRole("dialog",{name:"按条件重新查询"});
    assert.match(await preview.getByLabel("SQL 预览",{exact:true}).innerText(),/INSTR\(LOWER\(PK_ORDER\), LOWER\(:1\)\)/);
    await preview.getByRole("button",{name:"执行查询"}).click();
    await back.waitFor();
    await back.click();
    assert.equal(await filter.inputValue(),"not-loaded-42");
    await filter.fill("");

    // Measure the first frame with the selected result laid out. An extra frame
    // after the panel is ready would measure the display interval twice.
    const switches = await page.evaluate(async () => {
      const bar = window.document.querySelector(".dbx-result-head [role=tablist]");
      const tabs = [...bar.querySelectorAll("[role=tab]")].slice(0,2);
      const durations = [];
      for (let i = 0; i < 26; i++) {
        const start = window.performance.now();
        const next = (i + 1) % 2;
        tabs[next].click();
        const ready = await new Promise((resolve, reject) => {
          const frame = () => {
            const grid = window.document.querySelector(".dbx-result-panes > .dbx-result-keep:not([hidden]) [role=grid]");
            if (tabs[next].getAttribute("aria-selected") === "true" && grid?.getAttribute("aria-colcount") === (next ? "2" : "151") && grid.clientHeight > 0) {
              resolve(window.performance.now());
            } else if (window.performance.now() - start > 2000) reject(Error("result tab did not switch"));
            else window.requestAnimationFrame(frame);
          };
          window.requestAnimationFrame(frame);
        });
        if (i >= 2) durations.push(ready - start);
      }
      return durations;
    });
    timings.push(...switches);
    timings.sort((a,b)=>a-b);
    const p95 = timings[Math.ceil(timings.length * .95)-1];
    assert.ok(p95 <= 100, `warm result tab P95 ${p95.toFixed(1)}ms exceeds 100ms`);
    console.log(`15000 tables, 500×150 rows, warm result tab P95 ${p95.toFixed(1)}ms`);

    await editor("SELECT * FROM po_");
    const completionTimes = await page.evaluate(async () => {
      const e = window.billMonaco.editor.getEditors()[0];
      const model = e.getModel();
      e.setPosition(model.getPositionAt(model.getValueLength()));
      const pane = window.document.querySelector(".dbx-sql-overflow");
      const controller = e.getContribution("editor.contrib.suggestController");
      const times = [];
      for (let i = 0; i < 26; i++) {
        controller.cancelSuggestWidget();
        const start = window.performance.now();
        e.trigger("acceptance", "editor.action.triggerSuggest", {});
        await new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => { observer.disconnect(); reject(Error("SQL completion was not shown")); }, 2000);
          const check = () => {
            if (!pane.querySelector(".suggest-widget.visible .monaco-list-row")?.textContent.includes("po_")) return;
            window.clearTimeout(timeout); observer.disconnect();
            window.requestAnimationFrame(resolve);
          };
          const observer = new window.MutationObserver(check);
          observer.observe(pane, { attributes:true, childList:true, subtree:true });
          check();
        });
        if (i >= 2) times.push(window.performance.now() - start);
      }
      controller.cancelSuggestWidget();
      return times.sort((a,b)=>a-b);
    });
    const completionP95 = completionTimes[Math.ceil(completionTimes.length * .95)-1];
    assert.ok(completionP95 <= 100, `visible completion P95 ${completionP95.toFixed(1)}ms exceeds 100ms`);
    console.log(`15000 tables, visible table completion P95 ${completionP95.toFixed(1)}ms`);

    await page.evaluate(() => window.billDb.openSqlTab("c","SELECT 1 AS slow_probe FROM dual;"));
    await run();
    await page.waitForFunction(() => !!window.finishSlow);
    await page.evaluate(() => window.billDb.activateTab("acceptance-table"));
    await primary.getByText("PO-0",{exact:true}).first().click();
    await page.keyboard.press("ArrowDown");
    await primary.getByText("PO-1",{exact:true}).first().waitFor();
    assert.ok(await grid.count() || await primary.locator("[role=grid]").count());
    await page.evaluate(() => window.finishSlow());

    await page.evaluate(() => window.billDb.disconnect("c"));
    await primary.getByText("连接中断 · 只读快照",{exact:true}).waitFor();
    await primary.getByText("PO-0",{exact:true}).first().waitFor();
    assert.equal(await primary.getByRole("button",{name:/加载下/}).count(),0);
    await primary.getByRole("button",{name:"重新执行查询",exact:true}).click();
    const replay = page.getByRole("dialog",{name:"重新执行查询"});
    await replay.getByRole("button",{name:"执行查询"}).click();
    await back.waitFor();
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test("Saved SQL templates restore parameter types and explicit result column layouts", async () => {
  const browser = await chromium.launch({headless:true,channel:"msedge"});
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  const source = bootstrap.replace("if(cmd==='db_exec_bound') {", "if(cmd==='db_exec_bound') return {kind:'rows',columns:[{name:'PK_ORDER',type:'VARCHAR2'},{name:'VBILLCODE',type:'VARCHAR2'}],rows:[['P-1','B-1']],hasMore:false,ms:10,tx:tx(),output:[]}; if(cmd==='db_exec_bound') {");
  try {
    await openEditor(page, source);
    const sql = "SELECT * FROM po_order WHERE pk_order = :order_id";
    await page.evaluate(async sql => {
      const { addSnippet } = await import("/src/lib/dbSnippets.ts");
      addSnippet({ name:"按单号查采购订单",sql,connId:"c",schema:"NC_TEST",parameterTypes:{order_id:"number"} });
      const editor = window.billMonaco.editor.getEditors()[0];
      editor.setValue(sql); editor.setPosition({lineNumber:1,column:3});
    }, sql);
    const activeResult = page.locator(".dbx-result-keep:not([hidden])").first();
    const run = async () => {
      const prior = await page.evaluate(() => window.billDb.sqlTabOf("acceptance-table").results[0]?.id);
      await page.getByRole("button",{name:"执行当前语句",exact:true}).click();
      const dialog = page.getByRole("dialog",{name:"填写查询参数"});
      assert.equal(await dialog.getByLabel("参数 order_id 类型").inputValue(),"number");
      await dialog.getByRole("textbox").fill("42");
      await dialog.getByRole("button",{name:"执行查询"}).click();
      await page.waitForFunction(previous => {
        const entry = window.billDb.sqlTabOf("acceptance-table").results[0];
        return entry?.kind === "rows" && entry.id !== previous;
      }, prior);
      await activeResult.getByText("已加载 1 行",{exact:true}).waitFor();
    };
    await run();
    const display = activeResult.getByRole("button",{name:"显示选项"});
    await display.click();
    await page.getByRole("menuitem",{name:/结果列布局/}).click();
    const columns = page.getByRole("dialog",{name:"结果列布局"});
    await columns.getByRole("checkbox",{name:"vbillcode",exact:true}).uncheck();
    await columns.getByRole("button",{name:"完成",exact:true}).click();
    await display.click();
    await page.getByRole("menuitem",{name:"保存布局到查询模板",exact:true}).click();
    await page.evaluate(() => window.localStorage.removeItem("ncforge-db-grid:c:po_order"));
    await run();
    assert.equal(await activeResult.locator("[role=grid]").getAttribute("aria-colcount"),"2");
  } finally { await browser.close(); }
});

test("SQL batch JOIN previews, appends, continues from a joined source and undoes in one step", async () => {
  await mkdir(artifacts, {recursive:true});
  const browser = await chromium.launch({headless:true,channel:"msedge"});
  const page = await browser.newPage({viewport:{width:1180,height:800}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const menu = page.locator(".action-widget[data-sql-join-batch]");
  const preview = menu.locator(".dbx-sql-action-preview pre");
  const read = () => page.evaluate(() => window.billMonaco.editor.getEditors()[0].getValue());
  async function click(locator) {
    await locator.waitFor();
    const box = await locator.boundingBox();
    // Native Monaco menus release their pointer guard on the first movement.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps:2});
    await locator.click();
  }
  const original = "SELECT o.* FROM join_order o WHERE o.dr = 0;\nSELECT 1 FROM dual;";
  try {
    await openEditor(page);
    await page.evaluate(sql => {
      const editor = window.billMonaco.editor.getEditors()[0];
      editor.setValue(sql);
      editor.setPosition(editor.getModel().getPositionAt(sql.indexOf("join_order") + 2));
      editor.focus();
    }, original);
    await page.keyboard.press("Alt+Enter");
    const origin = menu.getByRole("checkbox", {name:/corigcountryid/});
    const tax = menu.getByRole("checkbox", {name:/ctaxcountryid/});
    await click(origin);
    assert.equal(await origin.isChecked(), true);
    await click(tax);
    await menu.getByRole("button", {name:"添加 2 条关联"}).waitFor();
    assert.equal(await tax.isChecked(), true);
    assert.equal(await origin.isChecked(), true);
    const planned = await preview.textContent();
    assert.match(planned, /LEFT JOIN join_country join_country_corigcountryid\s+ON join_country_corigcountryid.pk_order = o.corigcountryid/);
    assert.match(planned, /LEFT JOIN join_country join_country_ctaxcountryid\s+ON join_country_ctaxcountryid.pk_order = o.ctaxcountryid/);
    assert.equal(await read(), original);
    await page.screenshot({path:fileURLToPath(new URL("batch-join-preview.png", artifacts))});
    await page.keyboard.press("Enter");
    const more = page.getByRole("button", {name:/^继续添加关联 ·/});
    await more.waitFor();
    const first = await read();
    assert.ok(first.includes(planned) && first.indexOf(planned) < first.indexOf("WHERE"));
    assert.ok(first.endsWith("SELECT 1 FROM dual;"));
    await page.keyboard.press("Alt+Enter");
    await click(menu.getByRole("button", {name:"已添加（2）"}));
    await menu.locator(".option-disabled").filter({hasText:/ctaxcountryid/}).waitFor();
    assert.equal(await tax.count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await read(), first);
    await page.keyboard.press("Control+z");
    assert.equal(await read(), original);

    await page.setViewportSize({width:560,height:650});
    const close = page.getByRole("button", {name:"关闭资源侧栏"});
    if (await close.isVisible()) await close.click();
    await page.evaluate(sql => {
      const editor = window.billMonaco.editor.getEditors()[0];
      editor.setPosition(editor.getModel().getPositionAt(sql.indexOf("join_order") + 2));
      editor.focus();
    }, original);
    await page.keyboard.press("Alt+Enter");
    await click(menu.getByRole("checkbox", {name:/pk_store/}));
    await page.keyboard.press("Space");
    await menu.getByRole("button", {name:"添加关联",exact:true}).waitFor();
    await page.keyboard.press("Enter");
    await more.click();
    const source = menu.getByRole("combobox", {name:"关联来源"});
    await source.selectOption({label:"join_store"});
    await menu.getByRole("checkbox", {name:/仓库所属组织/}).waitFor();
    assert.match(await preview.textContent(), /join_store.pk_org/);
    await click(menu.getByRole("button", {name:"添加关联",exact:true}));
    await more.waitFor();
    const next = await read();
    assert.ok(next.indexOf("LEFT JOIN join_store") < next.indexOf("LEFT JOIN join_org") && next.indexOf("LEFT JOIN join_org") < next.indexOf("WHERE"));
    await page.screenshot({path:fileURLToPath(new URL("batch-join-continuation.png", artifacts))});
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({path:fileURLToPath(new URL("batch-join-failure.png", artifacts))});
    throw error;
  } finally { await browser.close(); }
});
