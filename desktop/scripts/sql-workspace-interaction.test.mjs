/* global window, navigator, document */
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";

const origin = process.env.GLASS_PREVIEW_URL || "http://localhost:1420";
const fixture = await readFile(new URL("./db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
const bootstrap = fixture.match(/const bootstrap=`([\s\S]*?)`;/)[1]
  .replace("if(cmd==='db_tx')", "if(cmd==='db_slot_acquire') return {slot:'interaction-slot',tx:tx()}; if(cmd==='db_slot_release') return null; if(cmd==='db_tx')")
  .replace("if(cmd==='db_exec_bound')", "if(cmd==='db_exec_bound' || cmd==='db_exec_result' || cmd==='db_exec')")
  .replace("hasMore:false,ms:10,tx:tx()", "hasMore:false,ms:10,output:[],tx:tx()")
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}", "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'',results:[],output:[]}");

test("SQL workbench preserves exact selection, independent result views and keyboard focus", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.route(origin + "/", async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, () => '<script type="module">' + bootstrap + '</script>');
      await route.fulfill({ response, body });
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click({ timeout: 30000 });
    await page.getByRole("textbox", { name: "SQL 查询编辑器", exact: true }).waitFor();
    await page.evaluate(async () => {
      const { monaco } = await import("/src/lib/monacoSetup.ts");
      window.workspaceEditor = monaco.editor.getEditors().find(editor => editor.getContainerDomNode().closest(".dbx-editor"));
      const storePath = "/src/lib/dbStore.ts";
      const loadedStore = window.performance.getEntriesByType("resource").find(entry => new URL(entry.name).pathname === storePath);
      window.workspaceDb = await import(loadedStore?.name ?? storePath);
      await window.workspaceDb.connect("c");
    });

    const script = Array.from({ length: 90 }, (_, i) => `SELECT ${i + 1} /* 中文 */ FROM dual;`).join("\n");
    await page.evaluate(sql => { const e = window.workspaceEditor; e.setValue(sql); e.setPosition({ lineNumber: 1, column: 1 }); e.setScrollTop(0); }, script);
    await page.getByRole("navigation", { name: "语句大纲" }).waitFor();
    const dragCoordinates = fromEnd => page.evaluate(fromEnd => {
      const e = window.workspaceEditor, m = e.getModel(), dom = e.getDomNode();
      const lineNumber = fromEnd ? m.getLineCount() : 1;
      const position = { lineNumber, column: fromEnd ? m.getLineMaxColumn(lineNumber) : 1 };
      e.setPosition(position);
      e.setScrollTop(fromEnd ? e.getScrollHeight() : 0);
      const rect = dom.getBoundingClientRect(), point = e.getScrolledVisiblePosition(position);
      return { x: rect.left + point.left + 1, y: rect.top + point.top + point.height / 2, top: rect.top, bottom: rect.bottom };
    }, fromEnd);
    for (const fromEnd of [false, true]) {
      const position = await dragCoordinates(fromEnd);
      const startTop = await page.evaluate(() => window.workspaceEditor.getScrollTop());
      await page.mouse.move(position.x, position.y);
      await page.mouse.down();
      await page.mouse.move(position.x, fromEnd ? position.top + 4 : position.bottom - 4, { steps: 12 });
      await page.waitForFunction(({ fromEnd, startTop }) => fromEnd ? window.workspaceEditor.getScrollTop() < startTop : window.workspaceEditor.getScrollTop() > startTop, { fromEnd, startTop });
      await page.mouse.move(position.x, fromEnd ? position.top - 86 : position.bottom + 108, { steps: 20 });
      try {
        await page.waitForFunction(() => {
          const e = window.workspaceEditor, m = e.getModel();
          return m.getValueInRange(e.getSelection()) === m.getValue();
        });
      } catch (error) {
        const editorState = await page.evaluate(({ x, y }) => {
          const e = window.workspaceEditor, t = e.getTargetAtClientPoint(x, y);
          return { selection: e.getSelection(), scrollTop: e.getScrollTop(), scrollHeight: e.getScrollHeight(), height: e.getLayoutInfo().height, originType: t?.type, originPosition: t?.position };
        }, position);
        throw new Error(JSON.stringify({ fromEnd, position, editorState, pageErrors }), { cause: error });
      }
      await page.mouse.up();
      const after = await page.evaluate(() => window.workspaceEditor.getDomNode().getBoundingClientRect().top);
      assert.equal(after, position.top);
      const execute = page.getByRole("button", { name: "执行选中 SQL", exact: true });
      await execute.waitFor();
      assert.match(await execute.getAttribute("title"), /第 1–90 行/);
      await page.keyboard.press("Control+c");
      await page.waitForFunction(async sql => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n") === sql, script);
    }

    await page.evaluate(() => {
      const columns = Array.from({ length: 24 }, (_, i) => ({ name: i === 0 ? "ID" : i === 1 ? "RANK_KEY" : `COL_${i}`, type: i < 2 ? "NUMBER" : "VARCHAR2", full: i < 2 ? "NUMBER" : "VARCHAR2(50)" }));
      const rows = Array.from({ length: 300 }, (_, r) => columns.map((_, c) => c === 0 ? r + 1 : c === 1 ? [1, 500, 501][r] ?? r : `row-${r + 1}-${c}`));
      const common = { index: 1, kind: "rows", sql: "SELECT * FROM TEST_TABLE", columns, rows, hasMore: false, updateCount: -1, ms: 10 };
      const sets = [{ columns, rows, hasMore: false }, { columns, rows: rows.slice(50), hasMore: false }];
      const output = Array.from({ length: 140 }, (_, i) => ({ at: i, text: `日志 ${i + 1}`, tone: "info" }));
      window.workspaceDb.patchTab("acceptance-table", { results: [{ ...common, id: "main-grid", sets }, { ...common, id: "other-grid", index: 2 }], view: "main-grid", output });
    });
    const grid = page.locator(".dbx-grid:visible");
    const cells = grid.locator("[role=gridcell]");
    await grid.waitFor().catch(async error => {
      const layout = await page.evaluate(() => ({
        view: window.workspaceDb.sqlTabOf("acceptance-table")?.view,
        results: window.workspaceDb.sqlTabOf("acceptance-table")?.results.map(r => r.id),
        boxes: Array.from(document.querySelectorAll(".dbx-res,.dbx-result-panes,.dbx-result-keep,.dbx-result-view,.dbx-rset,.dbx-grid"), el => [el.className, el.hidden, el.clientHeight]),
      }));
      throw new Error(JSON.stringify({ pageErrors, layout }), { cause: error });
    });
    await page.getByRole("button", { name: "显示选项" }).click();
    await page.getByRole("menuitem", { name: /^结果列布局/ }).click();
    const columnsDialog = page.getByRole("dialog", { name: "结果列布局" });
    await columnsDialog.getByLabel("固定", { exact: true }).first().check();
    await columnsDialog.getByRole("button", { name: "完成" }).click();
    const gridBox = await grid.boundingBox();
    const cellBox = await cells.first().boundingBox();
    await page.mouse.move(cellBox.x + 9, cellBox.y + cellBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gridBox.x + gridBox.width - 7, gridBox.y + gridBox.height - 7, { steps: 16 });
    await page.waitForFunction(() => { const e = document.querySelector(".dbx-grid"); return e.scrollTop > 35 && e.scrollLeft > 35; });
    await page.mouse.up();
    const stopped = await grid.evaluate(e => [e.scrollTop, e.scrollLeft]);
    await page.mouse.move(gridBox.x + gridBox.width - 5, gridBox.y + gridBox.height - 5);
    assert.deepEqual(await grid.evaluate(e => [e.scrollTop, e.scrollLeft]), stopped);
    await page.mouse.move(gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gridBox.x + 8, gridBox.y + 4, { steps: 12 });
    await page.waitForFunction(([top, left]) => {
      const e = document.querySelector(".dbx-grid");
      return e.scrollTop < top && e.scrollLeft < left;
    }, stopped);
    await page.mouse.up();
    await grid.evaluate(e => { e.scrollTop = e.scrollLeft = 0; });
    await grid.locator('[id$="-0-0"]').click();
    for (const key of ["Shift+ArrowDown", "Shift+ArrowDown", "Shift+ArrowRight"]) await page.keyboard.press(key);
    await grid.locator('[id$="-0-0"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "复制 6 个单元格" }).click();
    await page.waitForFunction(async () => (await navigator.clipboard.readText()).split(/\r?\n/).length === 3);
    await grid.getByRole("button", { name: /^RANK_KEY，/ }).click();
    await page.getByRole("status").filter({ hasText: "选区已调整" }).waitFor();
    await grid.focus(); await page.keyboard.press("Control+c");
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === "501");

    await page.getByRole("button", { name: "筛选已加载行", exact: true }).click();
    await page.getByRole("textbox", { name: "在结果中筛选" }).fill("row");
    await grid.evaluate(e => { e.scrollTop = 650; e.scrollLeft = 220; });
    await page.getByRole("tab", { name: /^结果集 2/ }).click();
    await page.getByRole("tab", { name: /^结果集 1/ }).click();
    assert.equal(await page.getByRole("textbox", { name: "在结果中筛选" }).inputValue(), "row");
    assert.deepEqual(await grid.evaluate(e => [e.scrollTop, e.scrollLeft]), [650, 220]);
    await grid.focus(); await page.keyboard.press("Control+g");
    const jump = page.getByRole("dialog", { name: "跳转到行列" });
    await jump.getByLabel(/^行号/).fill("250");
    await jump.getByLabel(/^列号/).fill("20");
    await jump.getByRole("button", { name: "跳转", exact: true }).click();
    await page.waitForFunction(() => { const e = document.activeElement; const id = e?.getAttribute("aria-activedescendant"); return e?.classList.contains("dbx-grid") && id?.endsWith("-19") && !!document.getElementById(id); });

    await page.getByRole("tab", { name: /^查询 2/ }).click();
    await grid.evaluate(e => { e.scrollTop = 500; e.scrollLeft = 240; });
    await page.evaluate(() => {
      const db = window.workspaceDb, tab = db.sqlTabOf("acceptance-table");
      db.patchTab(tab.id, { results: tab.results.map(r => r.id === "other-grid" ? { ...r, rows: [...r.rows, ...r.rows.slice(0, 50)] } : r) });
    });
    await grid.getAttribute("aria-rowcount").then(count => assert.equal(count, "351"));
    assert.deepEqual(await grid.evaluate(e => [e.scrollTop, e.scrollLeft]), [500, 240]);

    await page.getByRole("tab", { name: /^输出/ }).click();
    const output = page.locator(".dbx-output");
    await output.evaluate(e => { e.scrollTop = 120; });
    await page.waitForTimeout(80);
    await page.evaluate(() => { const db = window.workspaceDb, tab = db.sqlTabOf("acceptance-table"); db.patchTab(tab.id, { output: [...tab.output, { at: 141, tone: "info", text: "新增日志" }] }); });
    await page.getByText("1 条新输出").waitFor();
    assert.equal(await output.evaluate(e => e.scrollTop), 120);
    await page.getByRole("button", { name: "跳到底部" }).click();
    assert.ok(await output.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop < 2));

    await page.getByRole("tab", { name: /^查询 1/ }).click();
    await page.getByRole("button", { name: "固定结果", exact: true }).click();
    await page.evaluate(() => { const e = window.workspaceEditor; e.setValue("SELECT 999 FROM TEST_TABLE;"); e.setPosition({ lineNumber: 1, column: 8 }); e.focus(); });
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => {
      const t = window.workspaceDb.sqlTabOf("acceptance-table");
      return t?.results.some(r => r.id === "main-grid" && r.pinned && r.archived) && t.results.some(r => r.sql.includes("999")) && !t.run;
    });
    const rerun = await page.evaluate(() => window.workspaceDb.sqlTabOf("acceptance-table").results.find(r => r.sql.includes("999")));
    assert.equal(rerun.kind, "rows", rerun.error);
    await page.getByRole("button", { name: "取消固定结果", exact: true }).waitFor();
    await page.getByRole("button", { name: "双栏", exact: true }).click();
    assert.equal(await grid.count(), 2);
    await page.setViewportSize({ width: 560, height: 720 });
    if (await page.getByRole("button", { name: "关闭资源侧栏" }).isVisible()) await page.getByRole("button", { name: "关闭资源侧栏" }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.equal(await grid.count(), 2);
    assert.deepEqual(pageErrors, []);
  } finally { await browser.close(); }
});
