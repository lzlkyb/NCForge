// Monaco 0.52.2 has unobserved highlight cancellations and a sticky-scroll model race.
// Keep valid updates and real errors; discard work tied to an expired document at the source.
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Monaco's ESM build keeps string keys, so its AMD language packs cannot translate these menus.
const EDITOR_MENU_ZH_CN = {
  "Go to Definition": "转到定义", "Go to Declaration": "转到声明",
  "Go to Type Definition": "转到类型定义", "Go to Implementations": "转到实现",
  "Go to References": "转到引用", "Go to Any Symbol": "转到任意符号",
  "Peek": "速览", "Peek Definition": "速览定义", "Peek Declaration": "速览声明",
  "Peek Type Definition": "速览类型定义", "Peek Implementations": "速览实现", "Peek References": "速览引用",
  "Change All Occurrences": "更改所有匹配项", "Format Document": "格式化文档", "Format Selection": "格式化选定内容",
  "Cut": "剪切", "Copy": "复制", "Paste": "粘贴", "Copy As": "复制为",
  "Copy With Syntax Highlighting": "复制并保留语法高亮",
  "Go to &&Definition": "转到定义(&&D)", "Go to &&Declaration": "转到声明(&&D)",
  "Go to &&Type Definition": "转到类型定义(&&T)", "Go to &&Implementations": "转到实现(&&I)",
  "Go to &&References": "转到引用(&&R)", "Cu&&t": "剪切(&&T)", "&&Copy": "复制(&&C)", "&&Paste": "粘贴(&&P)",
  "No definition found for '{0}'": "未找到“{0}”的定义",
};

export function patchEditorNls(source) {
  // Replace our table on repeated runs so wording updates also invalidate Vite's dependency cache.
  source = source.replace(/^const ncforgeEditorNls = new Map\(Object\.entries\(.*\)\);\r?\n/m, "");
  for (const [before, after] of [
    ["    return _format(message, args);", "    return _format(ncforgeEditorNls.get(message) ?? message, args);"],
    ["        message = originalMessage;", "        message = ncforgeEditorNls.get(originalMessage) ?? originalMessage;"],
  ]) {
    if (source.split(after).length === 2 && !source.includes(before)) continue;
    if (source.split(before).length !== 2 || source.includes(after)) throw new Error("Monaco NLS changed; review editor-menu localization before upgrading");
    source = source.replace(before, after);
  }
  if (source.split("const isPseudo =").length !== 2) throw new Error("Monaco NLS changed; review editor-menu localization before upgrading");
  return source.replace("const isPseudo =", "const ncforgeEditorNls = new Map(Object.entries(" + JSON.stringify(EDITOR_MENU_ZH_CN) + "));\nconst isPseudo =");
}

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
    ["esm/vs/nls.js", patchEditorNls],
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
