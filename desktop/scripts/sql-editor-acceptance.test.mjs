// Full app and real Monaco, sharing the existing mocked database fixture.
/* global window, document, getComputedStyle, localStorage */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.GLASS_PREVIEW_URL || "http://localhost:1425";
const artifacts = new URL("../../docs/sql-editor-fix-20261105/", import.meta.url);
// Keep all database calls in the established mock: this regression never opens a business connection.
const fixture = await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
const matched = fixture.match(/const bootstrap=`([\s\S]*?)`;/);
assert.ok(matched, "Database IPC fixture must be available");
const table = "{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}";
assert.ok(matched[1].includes(table), "Review SQL fixture when the database bootstrap changes");
const bootstrap = matched[1].replace(table, "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'',results:[],output:[]}")
  .replace("if(cmd==='db_exec_bound')", "if(cmd==='db_exec' || cmd==='db_exec_bound')")
  .replace("ms:10,tx:tx()", "ms:10,output:[],tx:tx()")
  .replace("if(cmd==='db_tx')", "if(cmd==='db_slot_acquire') return {slot:'sql-1',tx:tx()}; if(cmd==='db_tx')")
  .replace("await import('/src/main.tsx');", "localStorage.setItem('ncforge-db-result-height','300'); await import('/src/main.tsx');");

test("SQL editor: empty initialization, focus, input, execution, resize and tab return", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], measurements = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(origin + "/", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/, '<script type="module">' + bootstrap + '</script>');
    assert.ok(body.includes("mockWindows")); await route.fulfill({ response, body });
  });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click();
    const input = page.getByRole("textbox", { name: "SQL 查询编辑器", exact: true });
    await input.focus();
    for (const [name, width, height, dark] of [["empty-wide",1280,900,false],["empty-low",1024,540,false],["empty-narrow",560,700,false],["empty-dark-low",1024,540,true],["scale-125",819,614,false]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async dark => { const theme = await import("/src/lib/theme.ts"); theme.applyTheme(dark ? "dark" : "light"); }, dark);
      await page.waitForFunction(() => {
        const main = document.querySelector(".dbx-console-main")?.getBoundingClientRect();
        const editor = document.querySelector(".dbx-editor")?.getBoundingClientRect();
        const result = document.querySelector(".dbx-res")?.getBoundingClientRect();
        return main && editor && result && editor.height >= 140 && result.bottom <= main.bottom + 1 && !document.documentElement.classList.contains("theme-transition");
      });
      const info = await page.evaluate(async () => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { width:r.width,height:r.height,bottom:r.bottom }; };
        const { monaco } = await import("/src/lib/monacoSetup.ts");
        const editor = monaco.editor.getEditors().find(e => e.getContainerDomNode().closest(".dbx-editor"));
        const inputStyle = getComputedStyle(document.querySelector(".dbx-editor textarea"));
        return { main:box(".dbx-console-main"),editor:box(".dbx-editor"),result:box(".dbx-res"),layout:editor.getLayoutInfo(),border:inputStyle.borderWidth,outline:inputStyle.outlineStyle,text:editor.getModel().getValue() };
      });
      assert.equal(info.text, ""); assert.ok(info.layout.contentLeft >= 30); assert.ok(info.layout.lineNumbersWidth > 0);
      assert.equal(info.border, "0px"); assert.equal(info.outline, "none");
      assert.ok(Math.abs(info.layout.height - info.editor.height) <= 1);
      measurements.push({ name, ...info });
      await page.screenshot({ path: fileURLToPath(new URL(name + ".png", artifacts)) });
    }
    await input.focus(); await page.keyboard.type("select 1 from dual;");
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => window.dbCalls.some(c => ["db_exec", "db_exec_bound"].includes(c.cmd) && c.args.sql.trim() === "select 1 from dual"));
    await page.getByRole("gridcell", { name: "甲", exact: true }).waitFor();
    await page.locator(".app-side").getByRole("button", { name: /^代码$/ }).click();
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click();
    await input.focus();
    assert.equal(await page.evaluate(async () => { const {monaco}=await import("/src/lib/monacoSetup.ts");return monaco.editor.getEditors().find(e=>e.getContainerDomNode().closest(".dbx-editor")).getModel().getValue(); }), "select 1 from dual;");
    const splitter = page.getByRole("separator", { name: "调整结果区高度" });
    await splitter.focus(); await page.keyboard.press("End");
    await page.waitForFunction(() => Number(document.querySelector('.dbx-splitbar').getAttribute('aria-valuenow')) === Number(document.querySelector('.dbx-splitbar').getAttribute('aria-valuemax')));
    await page.keyboard.press("Home");
    await page.waitForFunction(() => Number(document.querySelector('.dbx-splitbar').getAttribute('aria-valuenow')) === 90);
    await splitter.hover();
    const bar = await splitter.boundingBox();
    assert.ok(bar);
    assert.ok(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('dbx-splitbar'), { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 }), "Pointer must hit the rendered splitter after keyboard resize");
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width / 2, bar.y - 48, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const bar = document.querySelector('.dbx-splitbar');
      return Number(bar.getAttribute('aria-valuenow')) > Number(bar.getAttribute('aria-valuemin')) &&
        Number(bar.getAttribute('aria-valuenow')) <= Number(bar.getAttribute('aria-valuemax')) &&
        localStorage.getItem('ncforge-db-result-height') === bar.getAttribute('aria-valuenow');
    });
    await page.screenshot({ path: fileURLToPath(new URL("query-result.png", artifacts)) });
    assert.deepEqual(errors, []);
    await writeFile(new URL("measurements.json",artifacts), JSON.stringify({ errors, measurements, passed:["Empty SQL layout","Focus styles","Input and Ctrl+Enter via mocked IPC","Resize limits","Draft survives navigation","Keyboard split limits","Pointer split limits and persistence"] }, null, 2));
  } catch (error) {
    console.log(await page.evaluate(() => ({calls:window.dbCalls.filter(c=>c.cmd.startsWith('db_')), result:document.querySelector('.dbx-res')?.textContent, split: document.querySelector('.dbx-splitbar')?.outerHTML, savedHeight: localStorage.getItem('ncforge-db-result-height'), errors:[...document.querySelectorAll('.toast')].map(el=>el.textContent)})));
    throw error;
  } finally { await browser.close(); }
});
