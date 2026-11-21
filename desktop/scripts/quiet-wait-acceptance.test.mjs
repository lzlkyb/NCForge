// Real frontend, deferred IPC fixture. No database or workspace writes.
/* global document, window */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.UI_PREVIEW_URL || "http://127.0.0.1:1427";
const artifacts = new URL("../../target/quiet-wait-db/", import.meta.url);
const source = await readFile(new URL("db-workbench-acceptance.test.mjs", import.meta.url), "utf8");
const fixture = source.match(/const bootstrap=`([\s\S]*?)`;/)?.[1];
assert.ok(fixture);
const bootstrap = fixture
  .replace("mockIPC((cmd,args)=>{", "mockIPC(async(cmd,args)=>{")
  .replace("if(cmd==='db_exec_bound') {", `if(cmd==='db_slot_acquire') return {slot:'quiet-slot',tx:tx()};
 if(cmd==='db_exec' || cmd==='db_exec_result' || cmd==='db_exec_bound') {
  if(window.delayQuery) await new Promise(resolve=>{ window.completeQuery = resolve; });`)
  .replace("ms:10,tx:tx()", "ms:10,output:[],tx:tx()")
  .replace("throw Error('DB acceptance IPC not configured: '+cmd);", "return null;")
  .replace("{kind:'table',id:'acceptance-table',connId:'c',table:'TEST_TABLE',sub:'data'}",
    "{kind:'sql',id:'acceptance-table',connId:'c',title:'SQL 1',sql:'select * from TEST_TABLE;',maxRows:500,timeoutSec:60}");

test("slow query and background feedback leave the working editor and results in place", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route(origin + "/", async route => {
      const response = await route.fetch();
      const original = await response.text();
      const body = original.replace(/<script type="module" src="\/src\/main\.tsx[^"]*"><\/script>/,
        () => '<script type="module">' + bootstrap + '</script>');
      assert.notEqual(body, original);
      await route.fulfill({ response, body });
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".app-side").getByRole("button", { name: /^数据库/ }).click();
    const editor = page.getByRole("textbox", { name: "SQL 查询编辑器", exact: true });
    await editor.waitFor();
    await editor.focus();
    await editor.press("Control+Enter");
    const grid = page.locator(".dbx-result-view .dbx-grid").first();
    await grid.waitFor();
    const result = page.locator('.dbx-result-view[role="tabpanel"]');
    const bounds = await result.boundingBox();
    const head = page.locator(".dbx-result-head");
    const header = await head.boundingBox();
    const resultTabs = await head.getByRole("tab").count();
    await page.evaluate(() => {
      window.delayQuery = true;
      window.retainedResult = document.querySelector(".dbx-result-view .dbx-grid");
    });
    await editor.focus();
    await editor.press("Control+Enter");
    await page.waitForFunction(() => typeof window.completeQuery === "function");
    await page.waitForFunction(() => document.querySelector(".dbx-query-status")?.textContent?.includes("上次结果"));
    await editor.press("End");
    await page.keyboard.type(" -- draft");
    const draft = await editor.inputValue();
    const caret = await editor.evaluate(el => el.selectionStart);
    await page.locator(".dbx-query-time").filter({ hasText: /已用 [1-9]\d* 秒/ }).waitFor();
    assert.equal(await editor.evaluate(el => document.activeElement === el), true);
    assert.equal(await editor.evaluate(el => el.selectionStart), caret);
    assert.deepEqual(await result.boundingBox(), bounds);
    assert.deepEqual(await head.boundingBox(), header);
    assert.equal(await head.getByRole("tab").count(), resultTabs);
    assert.equal(await page.evaluate(() => window.retainedResult === document.querySelector(".dbx-result-view .dbx-grid")), true);
    assert.equal(await result.locator("canvas").count(), 0);
    assert.equal(await page.locator(".op-panel").count(), 0);
    await page.screenshot({ path: fileURLToPath(new URL("slow-query.png", artifacts)) });

    await page.locator(".app-side").getByRole("button", { name: /^设置/ }).click();
    const trigger = page.locator(".wb-status .op-status");
    await trigger.getByText(/进行中/).waitFor();
    await page.evaluate(() => window.completeQuery());
    await trigger.getByText(/任务/, { exact: true }).waitFor();
    assert.equal(await page.locator(".op-panel").count(), 0);
    await trigger.click();
    const panel = page.locator('.op-panel[data-anchor="bottom"]');
    await panel.waitFor();
    await panel.locator(".op-row").filter({ hasText: "执行 SQL" }).first().getByRole("button", { name: "返回来源" }).click();
    await editor.waitFor();
    assert.equal(await editor.inputValue(), draft);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
