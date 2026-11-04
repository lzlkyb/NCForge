import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { patchMonaco, patchStickyScroll, patchWordHighlighter } from "./patch-monaco.mjs";

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
