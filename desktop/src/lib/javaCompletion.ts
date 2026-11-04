import { monaco } from "./monacoSetup";
import { langReady, inLangModule, langRequest, flushDoc, langCapabilityEpoch } from "./lang";
import { context } from "./langProviderContext";
import { completionKindName, contentsToMarkdown, toMonacoRange, type LspRange } from "./langConvert";
import { workspaceEpoch } from "./workspaceEpoch";
import { toast } from "../components/ui/toast";
import { trackOperation } from "./operations";

interface LspItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: unknown;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { newText: string; range?: LspRange; insert?: LspRange; replace?: LspRange };
  additionalTextEdits?: { newText: string; range: LspRange }[];
  deprecated?: boolean;
  tags?: number[];
  preselect?: boolean;
  data?: unknown;
}
type Model = monaco.editor.ITextModel;
type Item = monaco.languages.CompletionItem;
interface Snapshot {
  model: Model;
  owner?: monaco.editor.ICodeEditor;
  version: number;
  epoch: number;
  capabilityEpoch: number;
  path: string;
  fallback: monaco.IRange;
  text: string;
  start: number;
  end: number;
}
const TIMEOUT_MS = 15_000;
// 与生产 java.completion.maxResults 一致；老 jdt.ls 满额时仍可能报告 isIncomplete=false。
const MAX_RESULTS = 50;
let lastErrorAt = -Infinity;
function reportFailure(error: unknown): void {
  if (Date.now() - lastErrorAt < 60_000) return;
  lastErrorAt = Date.now();
  toast(`代码补全暂时不可用，请稍后重试（${String(error)}）`, "warning");
}

/** 允许在同一候选前缀内继续输入；其它编辑使旧 import、替换范围作废。 */
function continuation(s: Snapshot): number | null {
  if (s.model.isDisposed() || (s.owner && s.owner.getModel() !== s.model) || s.epoch !== workspaceEpoch() || s.capabilityEpoch !== langCapabilityEpoch() || !langReady() || !inLangModule(s.path)) return null;
  if (s.model.getVersionId() === s.version) return 0;
  const current = s.model.getValue(), before = s.text.slice(0, s.start), after = s.text.slice(s.end);
  if (!current.startsWith(before) || !current.endsWith(after)) return null;
  const word = current.slice(s.start, current.length - after.length);
  return /^[\p{L}\p{N}_$]*$/u.test(word) ? current.length - s.text.length : null;
}

function convert(it: LspItem, s: Snapshot, delta = 0): Item {
  const rangeOf = (range: LspRange) => toMonacoRange({
    start: { ...range.start, character: range.start.character + (range.start.line === s.fallback.endLineNumber - 1 && range.start.character >= s.fallback.endColumn - 1 ? delta : 0) },
    end: { ...range.end, character: range.end.character + (range.end.line === s.fallback.endLineNumber - 1 && range.end.character >= s.fallback.endColumn - 1 ? delta : 0) },
  });
  const edit = it.textEdit;
  const insertText = edit?.newText ?? it.insertText ?? it.label;
  const parts = contentsToMarkdown(it.documentation);
  return {
    label: it.label,
    kind: monaco.languages.CompletionItemKind[completionKindName(it.kind)],
    insertText,
    insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range: edit?.insert && edit.replace ? { insert: rangeOf(edit.insert), replace: rangeOf(edit.replace) }
      : edit?.range || edit?.replace ? rangeOf((edit.range ?? edit.replace)!) : { ...s.fallback, endColumn: s.fallback.endColumn + delta },
    detail: it.detail, documentation: parts.length ? { value: parts.join("\n\n") } : undefined,
    sortText: it.sortText, filterText: it.filterText, preselect: it.preselect,
    tags: it.deprecated || it.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
    additionalTextEdits: it.additionalTextEdits?.map(e => ({ range: rangeOf(e.range), text: e.newText })),
    command: (it.kind === 2 || it.kind === 4) && insertText.includes("(")
      ? { id: "editor.action.triggerParameterHints", title: "显示参数提示" } : undefined,
  };
}

export function registerJavaCompletion(): void {
  // WeakMap 随候选列表回收，不能把每次输入的整份文本永久放进全局缓存。
  const metadata = new WeakMap<Item, { original: LspItem; snapshot: Snapshot; resolving?: Promise<void>; resolved?: { item: LspItem; snapshot: Snapshot } }>();
  monaco.languages.registerCompletionItemProvider("java", {
    triggerCharacters: [".", "@", "#", "*"],
    provideCompletionItems: async (model, position, trigger, token) => {
      if (token.isCancellationRequested || model.isDisposed()) return null;
      const version = model.getVersionId(), epoch = workspaceEpoch(), capabilityEpoch = langCapabilityEpoch();
      try {
        const ctx = await context(model, position);
        if (!ctx || token.isCancellationRequested || model.getVersionId() !== version) return null;
        const word = model.getWordUntilPosition(position);
        const linePrefix = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1).trimEnd();
        // 全库目录只参与类名位置；对象点号之后仍只显示 JDT 的真实成员。
        const discover = /^[A-Z][\p{L}\p{N}_$]+$/u.test(word.word) && !linePrefix.endsWith(".");
        const extra = discover ? langRequest<LspItem[]>("ncforge/typeCompletion", ctx.path, { prefix: word.word }, TIMEOUT_MS).catch(() => []) : Promise.resolve([]);
        const res = await langRequest<{ items?: LspItem[]; isIncomplete?: boolean } | LspItem[]>(
          "textDocument/completion", ctx.path, { position: ctx.position, context: {
            triggerKind: trigger.triggerKind + 1,
            ...(trigger.triggerCharacter ? { triggerCharacter: trigger.triggerCharacter } : {}),
          } }, TIMEOUT_MS);
        const external = await extra;
        if ((!res && !external.length) || token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version || workspaceEpoch() !== epoch || langCapabilityEpoch() !== capabilityEpoch || !langReady() || !inLangModule(ctx.path)) return null;
        const list = Array.isArray(res) ? res : (res?.items ?? []);
        const known = new Set(list.map(it => it.detail));
        if (Array.isArray(external)) list.push(...external.filter(it => !known.has((it.data as { ncfType?: string } | undefined)?.ncfType)));
        const snapshot: Snapshot = { model, owner: monaco.editor.getEditors().find(editor => editor.getModel() === model && editor.hasTextFocus()), version, epoch, capabilityEpoch, path: ctx.path,
          text: model.getValue(), start: model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn }), end: model.getOffsetAt(position),
          fallback: { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn } };
        return {
          incomplete: discover || (!Array.isArray(res) && !!res?.isIncomplete) || list.length >= MAX_RESULTS,
          suggestions: list.map(original => { const item = convert(original, snapshot); metadata.set(item, { original, snapshot }); return item; }),
        };
      } catch (error) {
        if (!token.isCancellationRequested && !model.isDisposed() && model.getVersionId() === version && workspaceEpoch() === epoch) reportFailure(error);
        return null;
      }
    },
    resolveCompletionItem: async (item, token) => {
      const data = metadata.get(item);
      if (!data) return item;
      const delta = continuation(data.snapshot);
      if (delta === null) { item.additionalTextEdits = undefined; item.command = undefined; return item; }
      if (token.isCancellationRequested) return item;
      if (data.resolved) { Object.assign(item, convert(data.resolved.item, data.resolved.snapshot, continuation(data.resolved.snapshot) ?? delta)); return item; }
      if (!data.resolving) {
        data.resolving = (async () => {
            const ncType = (data.original.data as { ncfType?: string } | undefined)?.ncfType;
            if (ncType) await flushDoc(data.snapshot.path);
            const before = continuation(data.snapshot);
            if (before === null) return;
            // NC resolve 会按最新前缀重新请求 JDT，返回的范围已包含这次增长。
            // 普通 resolve 仍基于旧候选；两种范围必须各自记录产生时的文档。
            const resolvedSnapshot = ncType ? { ...data.snapshot, version: data.snapshot.model.getVersionId(), text: data.snapshot.model.getValue(),
              end: data.snapshot.end + before, fallback: { ...data.snapshot.fallback, endColumn: data.snapshot.fallback.endColumn + before } } : data.snapshot;
            const resolved = ncType
              ? await trackOperation({ key: "lang.include-type:" + data.snapshot.epoch + ":" + data.snapshot.capabilityEpoch + ":" + data.snapshot.path + ":" + data.snapshot.version + ":" + data.snapshot.end + ":" + ncType, label: "载入 NC 类依赖", page: "files", phase: ncType }, () => langRequest<LspItem>("ncforge/resolveTypeCompletion", data.snapshot.path, {
                  name: ncType, position: { line: data.snapshot.fallback.endLineNumber - 1, character: data.snapshot.fallback.endColumn - 1 + before },
                }, TIMEOUT_MS))
              : await langRequest<LspItem>("completionItem/resolve", null, data.original as unknown as Record<string, unknown>, TIMEOUT_MS);
            const delta = continuation(data.snapshot);
            // 请求可以共享，取消令牌属于各个调用者；一个预览取消不能丢掉另一个接受操作的导入。
            if (resolved && delta !== null) {
              data.resolved = { item: { ...data.original, ...resolved }, snapshot: resolvedSnapshot };
            }
        })().finally(() => { data.resolving = undefined; });
      }
      try { await data.resolving; }
      catch (error) {
        if ((data.original.data as { ncfType?: string } | undefined)?.ncfType && !token.isCancellationRequested && continuation(data.snapshot) !== null) reportFailure(error);
        // 列表仍可使用；失败后允许再次选中重试。
      }
      const currentDelta = continuation(data.snapshot);
      const resolved = metadata.get(item)?.resolved;
      if (currentDelta === null) { item.additionalTextEdits = undefined; item.command = undefined; }
      // Monaco 的预览与接受可能复用同一个 item.resolve Promise；给仍有效的 item 补齐数据，
      // UI 是否继续展示由 Monaco 的取消令牌决定，不能让预览取消吞掉接受后的 import。
      else if (resolved) Object.assign(item, convert(resolved.item, resolved.snapshot, continuation(resolved.snapshot) ?? currentDelta));
      return item;
    },
  });
}
