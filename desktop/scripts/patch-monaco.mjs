// Monaco 0.52.2 has unobserved highlight cancellations and a sticky-scroll model race.
// Keep valid updates and real errors; discard work tied to an expired document at the source.
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function patchWordHighlighter(source) {
  const calls = [
    "this.runDelayer.trigger(() => { this._onPositionChanged(e); })",
    "this.runDelayer.trigger(() => { this._run(); })",
  ];
  for (const call of calls) {
    if (source.includes(call + ".catch(onUnexpectedError);")) continue;
    if (source.split(call + ";").length !== 2) throw new Error("Monaco WordHighlighter changed; review cancellation patch before upgrading");
    source = source.replace(call + ";", call + ".catch(onUnexpectedError);");
  }
  return source;
}

export function patchStickyScroll(source) {
  const before = `        this._minRebuildFromLine = undefined;
        this._foldingModel = await FoldingController.get(this._editor)?.getFoldingModel() ?? undefined;
        this._widgetState = this.findScrollWidgetState();`;
  const after = `        this._minRebuildFromLine = undefined;
        const model = this._editor.getModel();
        const version = model?.getVersionId();
        const foldingModel = await FoldingController.get(this._editor)?.getFoldingModel() ?? undefined;
        if (!model || model.isDisposed() || this._editor.getModel() !== model || model.getVersionId() !== version) {
            return;
        }
        this._foldingModel = foldingModel;
        this._widgetState = this.findScrollWidgetState();`;
  // Folding can finish after an edit, close, or switch; its old ranges must never reach the new model.
  if (source.split(after).length === 2 && !source.includes(before)) return source;
  if (source.split(before).length !== 2 || source.includes(after)) throw new Error("Monaco StickyScroll changed; review model-lifecycle patch before upgrading");
  return source.replace(before, after);
}

export async function patchMonaco() {
  const root = new URL("../node_modules/monaco-editor/", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  if (pkg.version !== "0.52.2") throw new Error("Review Monaco lifecycle patches for version " + pkg.version);
  const changes = [];
  for (const [relativePath, patch] of [
    ["esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js", patchWordHighlighter],
    ["esm/vs/editor/contrib/stickyScroll/browser/stickyScrollController.js", patchStickyScroll],
  ]) {
    const path = new URL(relativePath, root);
    const before = await readFile(path, "utf8"), after = patch(before);
    if (after !== before) changes.push({ path, after });
  }
  for (const { path, after } of changes) await writeFile(path, after);
  // Vite does not hash edits inside node_modules. Invalidate only changed patches, preserving warm starts.
  if (changes.length) await unlink(new URL("../.vite/deps/_metadata.json", root)).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await patchMonaco();
