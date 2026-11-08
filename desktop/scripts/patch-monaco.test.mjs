import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { patchEditorNls, patchMonaco, patchStickyScroll, patchWordHighlighter } from "./patch-monaco.mjs";

const source = "this.runDelayer.trigger(() => { this._onPositionChanged(e); });\nthis.runDelayer.trigger(() => { this._run(); });";
test("delayed highlight cancellation is observed at both call sites, preserving other errors", async () => {
  const patched = patchWordHighlighter(source), seen = [];
  const error = new Error("real highlight failure");
  const run = new Function("e", "onUnexpectedError", patched);
  run.call({ runDelayer: { trigger: () => Promise.reject(error) } }, {}, e => seen.push(e));
  await Promise.resolve();
  assert.deepEqual(seen, [error, error]);
  assert.equal(patchWordHighlighter(patched), patched);
});
test("upstream source drift fails visibly instead of silently skipping a fix", () => {
  assert.throws(() => patchWordHighlighter("different implementation"), /changed/);
  assert.throws(() => patchStickyScroll("different implementation"), /changed/);
  assert.throws(() => patchEditorNls("different implementation"), /changed/);
});

// Run the actual installed Monaco method so the regression covers its await boundary.
await patchMonaco();
const stickySource = await readFile(new URL("../node_modules/monaco-editor/esm/vs/editor/contrib/stickyScroll/browser/stickyScrollController.js", import.meta.url), "utf8");
assert.equal(patchStickyScroll(stickySource), stickySource);
const methodStart = stickySource.indexOf("    async _updateState(rebuildFromLine) {");
const methodEnd = stickySource.indexOf("    async _resetState() {", methodStart);
assert.ok(methodStart >= 0 && methodEnd > methodStart);
const stickyMethod = stickySource.slice(methodStart, methodEnd);
function startStickyUpdate() {
  let version = 1, disposed = false, rendered = 0;
  const model = { getVersionId: () => version, isDisposed: () => disposed };
  let currentModel = model;
  let resolve, reject;
  const folding = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  const previous = { startLineNumbers: [] };
  const controller = {
    _editor: { getModel: () => currentModel }, _foldingModel: null, _widgetState: previous,
    _stickyScrollVisibleContextKey: { set() {} }, _stickyScrollWidget: { setState() {} },
    findScrollWidgetState() { rendered++; return { startLineNumbers: [1] }; },
  };
  const update = new Function("FoldingController", `return ({${stickyMethod}})._updateState;`)({
    get: () => ({ getFoldingModel: () => folding }),
  });
  return {
    controller, previous, resolve, reject, rendered: () => rendered,
    pending: update.call(controller, 0),
    edit: () => { version++; }, switchModel: () => { currentModel = { ...model }; },
    close: () => { currentModel = null; }, dispose: () => { disposed = true; },
  };
}
for (const change of ["edit", "switchModel", "close", "dispose"]) {
  test(`sticky scroll rejects stale folding after ${change}`, async () => {
    const h = startStickyUpdate();
    h[change](); h.resolve({ stale: true });
    await h.pending;
    assert.equal(h.rendered(), 0);
    assert.equal(h.controller._foldingModel, null);
    assert.equal(h.controller._widgetState, h.previous);
  });
}
test("sticky scroll still renders an unchanged document", async () => {
  const h = startStickyUpdate(), folding = { current: true };
  h.resolve(folding); await h.pending;
  assert.equal(h.rendered(), 1);
  assert.equal(h.controller._foldingModel, folding);
});
test("sticky scroll keeps real folding failures visible", async () => {
  const h = startStickyUpdate(), error = new Error("real folding failure");
  h.reject(error);
  await assert.rejects(h.pending, e => e === error);
});

const { localize, localize2 } = await import(new URL("../node_modules/monaco-editor/esm/vs/nls.js", import.meta.url));
test("editor localization is applied by the startup patch and remains idempotent", async () => {
  const nlsSource = await readFile(new URL("../node_modules/monaco-editor/esm/vs/nls.js", import.meta.url), "utf8");
  assert.equal(patchEditorNls(nlsSource), nlsSource);
  assert.equal(nlsSource.split("const ncforgeEditorNls =").length, 2);
});

test("installed editor context menus and peek submenus display Chinese", () => {
  for (const [english, chinese] of [
    ["Go to Definition", "转到定义"], ["Go to Declaration", "转到声明"],
    ["Go to Type Definition", "转到类型定义"], ["Go to Implementations", "转到实现"],
    ["Go to References", "转到引用"], ["Peek", "速览"],
    ["Peek Definition", "速览定义"], ["Peek Declaration", "速览声明"],
    ["Peek Type Definition", "速览类型定义"], ["Peek Implementations", "速览实现"],
    ["Peek References", "速览引用"], ["Change All Occurrences", "更改所有匹配项"],
    ["Format Document", "格式化文档"], ["Format Selection", "格式化选定内容"],
    ["Cut", "剪切"], ["Copy", "复制"], ["Paste", "粘贴"], ["Copy As", "复制为"],
  ]) assert.equal(localize("menu.label", english), chinese);
});

test("localized commands retain their original English aliases and access keys", () => {
  assert.deepEqual(localize2("actions.goToDecl.label", "Go to Definition"), {
    value: "转到定义", original: "Go to Definition",
  });
  assert.equal(localize({ key: "miCut", comment: ["&& denotes a mnemonic"] }, "Cu&&t"), "剪切(&&T)");
});

test("editor messages preserve interpolation and untranslated or numeric fallbacks", () => {
  assert.equal(localize("noResultWord", "No definition found for '{0}'", "Customer"), "未找到“Customer”的定义");
  assert.equal(localize("unknown", "Unknown message {0}", 3), "Unknown message 3");
  assert.equal(localize("unknown", "__proto__"), "__proto__");
  assert.equal(localize(99999, "Numeric fallback {0}", 4), "Numeric fallback 4");
});
