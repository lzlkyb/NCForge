// The app uses real Monaco and the shared workbench IPC fixture. No external database is required.
/* global window, getComputedStyle */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.GLASS_PREVIEW_URL || "http://127.0.0.1:1435";
const artifacts = new URL("../../.codex-artifacts/sql-keyboard-assist/", import.meta.url);
const fixture = await readFile(new URL("./db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
const matched = fixture.match(/const bootstrap=`([\s\S]*?)`;/);
assert.ok(matched);
const tables = {
  so_saleorder: "销售订单",
  so_saleorder_b: "销售订单明细",
  po_order: "采购订单",
  po_order_b: "采购订单明细",
};
const column = (name, type) => ({ name, type, full: type, pk: false });
const schemaColumns = Object.fromEntries(Object.keys(tables).map(name => [name, [
  column("PK_ORDER", "VARCHAR2"),
  name.endsWith("_b") ? column("NNUM", "NUMBER") : column("VBILLCODE", "VARCHAR2"),
]]));
const relationRows = [
  ["detail_order", "SO_SALEORDER_B", "PK_ORDER", "SO_SALEORDER", "PK_ORDER", 1],
  ["detail_purchase", "PO_ORDER_B", "PK_ORDER", "PO_ORDER", "PK_ORDER", 1],
];
const relationHeaders = ["RELATION", "SOURCE_TABLE", "SOURCE_COLUMN", "TARGET_TABLE", "TARGET_COLUMN", "POSITION"];
const execCommands = ["db_exec", "db_exec_bound", "db_exec_result"];
const bootstrap = matched[1]
  .replace("if(cmd==='get_autostart')", "if(cmd==='check_update') return null; if(cmd==='get_autostart')")
  .replace("return {url:conn.url,user:conn.user,autoCommit:false};", "return {url:conn.url,user:conn.user,schema:'NC_TEST',autoCommit:false};")
  .replace("if(cmd==='db_tx') return {tx:tx()};", "if(cmd==='db_slot_acquire') return {slot:'sql-keyboard-1',tx:tx()}; if(cmd==='db_slot_release') return null; if(cmd==='db_tx') return {tx:tx()};")
  .replace("[{name:'TEST_TABLE',kind:'TABLE'},{name:'TEST_CHILD',kind:'TABLE'}]", JSON.stringify(Object.keys(tables).map(name => ({ name: name.toUpperCase(), kind: "TABLE" }))))
  .replace("{test_table:'测试主表',test_child:'测试子表'}", JSON.stringify(tables))
  .replace("if(args.kind==='tables')", "if(args.kind==='schemas') return {schemas:['NC_TEST'],current:'NC_TEST',user:'NC_TEST'}; if(args.kind==='tables')")
  .replace("if(args.kind==='columns') return {columns};", `if(args.kind==='columns') return {columns:${JSON.stringify(schemaColumns)}[String(args.arg).toLowerCase()] || []};`)
  .replace(/if\(cmd==='db_relations'\)[^\n]+/, `if(cmd==='db_relations') return {
    foreign:{kind:'rows',columns:[],rows:[],hasMore:false},
    references:{kind:'rows',columns:${JSON.stringify(relationHeaders)}.map(name=>({name,type:'VARCHAR2'})),
      rows:${JSON.stringify(relationRows)}.filter(r=>[r[1],r[3]].includes(String(args.table).toUpperCase())),hasMore:false},
    notes:[],sharedSession:false};`)
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'',results:[],output:[]}");

test("SQL editing stays keyboard-driven and uses explicit previews", async () => {
  await mkdir(artifacts,{recursive:true});
  const browser=await chromium.launch({headless:true,channel:"msedge"});
  const page=await browser.newPage({viewport:{width:1440,height:880}});
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.setDefaultTimeout(8500);
  await page.route(origin+"/",async route=>{
    const response=await route.fetch();
    const body=(await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/,()=>'<script type="module">'+bootstrap+'</script>');
    await route.fulfill({response,body});
  });
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
  async function pick(pattern){
    for(let n=0;n<25;n++){
      if (await selected.count() && pattern.test(await selected.first().innerText())) { await page.keyboard.press("Enter"); return; }
      await page.keyboard.press("ArrowDown");
    }
    throw Error("没有找到候选 "+pattern+" "+await suggest.innerText());
  }
  try{
    await page.goto(origin,{waitUntil:"domcontentloaded",timeout:60000});
    await page.locator(".app-side").getByRole("button",{name:/^数据库/}).click({timeout:40000});
    await page.locator("#dbx-conn-c").click({timeout:45000});
    await page.getByRole("textbox",{name:"SQL 查询编辑器",exact:true}).waitFor();
    await page.evaluate(async()=>{window.billDb=await import("/src/lib/dbStore.ts");window.billMonaco=(await import("/src/lib/monacoSetup.ts")).monaco;});
    await page.waitForFunction(n=>window.billDb.rtOf("c").tables?.length===n,Object.keys(schemaColumns).length);
    const main="SELECT * FROM so_saleorder", detail=suggest.getByText(/追加 LEFT JOIN · 销售订单明细/);
    await select(main.slice(0,-1));
    await page.keyboard.type("r");
    await detail.waitFor();
    assert.equal(await selected.count(),0);
    await page.screenshot({path:fileURLToPath(new URL("join-suggestions.png",artifacts))});
    await page.keyboard.press("Enter");
    assert.equal(await read(),main+"\n");

    await select(main.slice(0,-1));
    await page.keyboard.press("Control+Space");
    await suggest.getByText("so_saleorder",{exact:true}).waitFor();
    await pick(/^so_saleorder\s/);
    await detail.waitFor();
    await page.keyboard.press("Escape");
    await suggest.waitFor({state:"hidden"});
    assert.equal(await read(),main);
    await page.keyboard.press("Control+Space");
    await detail.waitFor();
    await pick(/查看全部关联/);
    await menu.getByText("销售订单明细 · so_saleorder_b",{exact:true}).waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});
    assert.equal(await read(),main);
    await page.keyboard.press("Control+Space");
    await detail.waitFor();
    await page.keyboard.press("ArrowDown");
    assert.match(await selected.first().innerText(),/销售订单明细/);
    await page.keyboard.press("ArrowRight");
    const preview = page.locator(".suggest-details .monaco-tokenized-source");
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
    assert.equal(await selected.count(),0);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await page.locator(".suggest-details").getByText(/vbillcode/).waitFor();
    assert.equal(await read(),main);
    await pick(/展开 \* 为字段列表/);
    await page.waitForFunction(()=>window.billMonaco.editor.getEditors().find(e=>e.getContainerDomNode().closest(".dbx-editor")).getValue().includes("pk_order"));

    const batch=main+" WHERE so_saleorder.vbillcode \nSO-1\nSO-2";
    await select(batch,batch.indexOf("SO-1"),batch.length);
    await page.getByRole("button",{name:"选区操作 · Ctrl+.",exact:true}).waitFor();
    assert.equal(await menu.isVisible(),false);
    await page.keyboard.press("Control+.");
    await menu.getByText("转为 IN 条件",{exact:true}).waitFor();
    assert.equal(await menu.locator(".monaco-list-row.focused").count(),0);
    await page.keyboard.press("Enter");
    assert.equal(await read(),batch);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await menu.locator("details[open] pre").getByText(/so_saleorder.vbillcode IN \('SO-1', 'SO-2'\)/).waitFor();
    assert.equal(await read(),batch);
    await page.screenshot({path:fileURLToPath(new URL("selection-preview.png",artifacts))});
    await page.keyboard.press("Enter");
    await page.waitForFunction(()=>window.billMonaco.editor.getEditors().find(e=>e.getContainerDomNode().closest(".dbx-editor")).getValue().includes("IN ('SO-1', 'SO-2')"));

    const meaning="SELECT a.* FROM po_order a LEFT JOIN po_order_b b ON a.pk_order=b.pk_order WHERE b.nnum > 0";
    await select(meaning,meaning.indexOf("b.nnum")+2);
    await page.keyboard.press("Control+.");
    await menu.getByText(/将此条件移入 ON/).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await menu.locator("details[open] pre").getByText(/AND \(b\.nnum > 0\)/).waitFor();
    assert.equal(await read(),meaning);
    await page.screenshot({path:fileURLToPath(new URL("condition-preview.png",artifacts))});
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});
    assert.equal(await read(),meaning);
    await page.keyboard.press("Control+.");
    await menu.getByText(/将此条件移入 ON/).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.billMonaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor")).getValue().includes("AND (b.nnum > 0)"));
    assert.doesNotMatch(await read(), /\bWHERE\b/);

    await page.setViewportSize({width:560,height:650});
    await page.getByRole("button",{name:"关闭资源侧栏"}).click();
    await select(main);
    await page.keyboard.press("Control+Space");
    await detail.waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await preview.waitFor();
    for (const popup of [suggest, page.locator(".suggest-details")]) {
      const box = await popup.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 561);
    }
    assert.equal(await read(),main);
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
