// 把 jdt.ls 的能力挂到 Monaco：补全、悬停、签名提示、跳转定义。
// 所有请求都带真实文件路径（由后端换成影子工程 URI）；服务未就绪或文件不属于当前模块时一律返回 null，
// 让 Monaco 退回到自带的「当前文档单词补全」，不弹错。
import { pathOfModel } from "./editorStore";
import { searchWorkspace, type SearchHit } from "./search";
import { getSession } from "./workspaceSession";
import { flushDoc, inLangModule, langReady, langRequest, loadJdtSource, navigate } from "./lang";
import {
  completionKindName,
  contentsToMarkdown,
  declarationPattern,
  isIdentifier,
  toLspPosition,
  toMonacoRange,
  toTargets,
  uriToPath,
  type LspPosition,
  type LspRange,
} from "./langConvert";
import { monaco } from "./monacoSetup";
import { toast } from "../components/ui/toast";

type Model = ReturnType<typeof monaco.editor.createModel>;
type Pos = { lineNumber: number; column: number };

/** 补全过慢就放弃，不让弹窗一直转。 */
const COMPLETION_TIMEOUT_MS = 15_000;

/**
 * 超过这个行数就不再请求语义补全。
 *
 * 阈值与文件页「大文件降级」一致（2000 行）：这个量级下 jdt.ls 的补全实测恒为 0，
 * 请求本身白等 15 秒。降级提示条已经说明了这件事。
 */
const HEAVY_LINES = 2000;

/** Monaco 的 uri 字符串 → jdt.ls 给出的原始地址。打开跳转目标时要用原始地址查。 */
const originalUri = new Map<string, string>();
/** 这个映射只增不减会线性泄漏；跳转目标地址没有长期价值，超上限直接清空。 */
const ORIGINAL_URI_MAX = 500;

function rememberUri(monacoUri: string, original: string): void {
  originalUri.set(monacoUri, original);
  if (originalUri.size > ORIGINAL_URI_MAX) originalUri.clear();
}

/**
 * 最近一次「服务就绪但请求失败」的原因。只留最后一条——这里不需要历史，
 * 留历史就是内存泄漏。
 */
let lastFailure: { method: string; message: string } | null = null;
/** 提示节流：同一类问题 60 秒内只打扰一次。 */
let lastNotifyAt = 0;

interface Ctx {
  path: string;
  position: LspPosition;
}

/**
 * 能不能走语言服务；能就先把没发出去的修改发过去再返回（必须 await）。
 *
 * `await flushDoc` 不是可选的：didChange 与随后的 request 是两次独立 IPC，
 * 不建立先后的话补全会按改动前的文本算位置。
 */
async function context(model: Model, pos: Pos): Promise<Ctx | null> {
  const path = pathOfModel(model);
  if (!path || !langReady() || !inLangModule(path)) return null;
  await flushDoc(path);
  return { path, position: toLspPosition(pos.lineNumber, pos.column) };
}

async function ask<T>(
  method: string,
  ctx: Ctx,
  timeoutMs?: number,
): Promise<T | null> {
  try {
    const res = await langRequest<T>(method, ctx.path, { position: ctx.position }, timeoutMs);
    lastFailure = null;
    return res;
  } catch (e) {
    // 超时、服务重启中等：先静默退回，不打断输入；要不要提示由调用方决定
    lastFailure = { method, message: String(e) };
    return null;
  }
}

/**
 * 「服务明明就绪，却没有响应」要说出来。
 *
 * 以前所有失败都被 catch 成 null，Monaco 静默退化成「当前文档单词补全」：
 * 用户看到的是「补全只剩本文件里的词」，没有任何说明；某个 6433 行的文件
 * 补全恒为 0 也正是这样被藏了大半年。
 */
function notifyStalled(what: string): void {
  if (!lastFailure) return;
  const now = Date.now();
  if (now - lastNotifyAt < 60_000) return;
  lastNotifyAt = now;
  toast(`语义${what}没有响应，已退回本地提示（${lastFailure.message}）`, "warning");
}

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: unknown;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  textEdit?: { newText: string; range?: LspRange; replace?: LspRange };
  additionalTextEdits?: { newText: string; range: LspRange }[];
}

interface LspSignature {
  label: string;
  documentation?: unknown;
  parameters?: { label: string | [number, number]; documentation?: unknown }[];
}

function markdown(doc: unknown): { value: string } | undefined {
  const parts = contentsToMarkdown(doc);
  return parts.length ? { value: parts.join("\n\n") } : undefined;
}

type Loc = { uri: ReturnType<typeof monaco.Uri.parse>; range: ReturnType<typeof toMonacoRange> };

/**
 * 轻量模式的跳转：jdt.ls 不可用（关闭 / 还没就绪 / 文件不在当前模块）时，
 * 按光标下的类名在工作区里找 `类名.java` 的声明行。只找工作区里的源码（NC 标准类在 jar 里，跳不到），
 * 也不认方法和变量——这就是「有限跳转」的全部范围。
 */
/**
 * 按类名缓存搜索结果。Monaco 在按住 Ctrl 移动鼠标时会对经过的每个单词调 provideDefinition，
 * 没有缓存就是每个单词一次全工作区扫描。工作区里的类声明短时间内不会变。
 */
const LIGHT_CACHE_MS = 30_000;
/** 缓存条目上限：Ctrl+悬停会扫过大量单词，不设上限就是长会话里的线性泄漏。 */
const LIGHT_CACHE_MAX = 200;
const lightCache = new Map<string, { at: number; hits: Promise<SearchHit[] | null> }>();

function searchDeclarations(word: string): Promise<SearchHit[] | null> {
  const cached = lightCache.get(word);
  if (cached && Date.now() - cached.at < LIGHT_CACHE_MS) return cached.hits;
  const hits = searchWorkspace({
    text: declarationPattern(word),
    regex: true,
    caseSensitive: true,
    include: `${word}.java`,
    maxResults: 5,
  })
    .then((r) => r.hits)
    .catch(() => null);
  lightCache.set(word, { at: Date.now(), hits });
  // Map 保持插入顺序：超上限就淘汰最早插入的那条
  if (lightCache.size > LIGHT_CACHE_MAX) {
    const oldest = lightCache.keys().next().value;
    if (oldest !== undefined) lightCache.delete(oldest);
  }
  return hits;
}

async function lightDefinition(model: Model, pos: Pos): Promise<Loc[] | null> {
  const path = pathOfModel(model);
  const root = getSession().root;
  if (!path || !root || !path.toLowerCase().endsWith(".java")) return null;
  const word = model.getWordAtPosition(pos)?.word;
  // 类名按 Java 习惯大写开头；小写开头的是变量 / 方法，这个模式本来就跳不到，别白扫一遍盘
  if (!word || !isIdentifier(word) || !/^[A-Z]/.test(word)) return null;
  const found = await searchDeclarations(word);
  if (!found) return null;
  const res = { hits: found };
  const base = root.replace(/[\\/]+$/, "");
  return res.hits.map((h) => {
    const abs = `${base}\\${h.path.replace(/\//g, "\\")}`;
    const lspUri = encodeURI(`file:///${abs.replace(/\\/g, "/")}`);
    const uri = monaco.Uri.parse(lspUri);
    rememberUri(uri.toString(), lspUri);
    const col = Math.max(0, h.text.indexOf(word, h.ranges[0]?.start ?? 0));
    return {
      uri,
      range: toMonacoRange({
        start: { line: h.line - 1, character: col },
        end: { line: h.line - 1, character: col + word.length },
      }),
    };
  });
}

let registered = false;

/** 注册一次（幂等）。需在 Monaco 初始化之后、第一个编辑器创建之前调用。 */
export function registerLangProviders(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider("java", {
    triggerCharacters: ["."],
    provideCompletionItems: async (model, position) => {
      // 大文件不请求：这个量级下 jdt.ls 补全恒为 0，白等 15 秒还会顶掉输入手感
      if (model.getLineCount() > HEAVY_LINES) return null;
      const ctx = await context(model, position);
      if (!ctx) return null;
      const res = await ask<{ items?: LspCompletionItem[]; isIncomplete?: boolean } | LspCompletionItem[]>(
        "textDocument/completion",
        ctx,
        COMPLETION_TIMEOUT_MS,
      );
      if (!res) {
        notifyStalled("补全");
        return null;
      }
      const items = Array.isArray(res) ? res : (res.items ?? []);
      const word = model.getWordUntilPosition(position);
      const fallback = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      };
      return {
        incomplete: !Array.isArray(res) && !!res.isIncomplete,
        suggestions: items.map((it) => {
          const edit = it.textEdit;
          const range = edit?.range ?? edit?.replace;
          return {
            label: it.label,
            kind: monaco.languages.CompletionItemKind[completionKindName(it.kind)],
            insertText: edit?.newText ?? it.insertText ?? it.label,
            range: range ? toMonacoRange(range) : fallback,
            detail: it.detail,
            documentation: markdown(it.documentation),
            sortText: it.sortText,
            filterText: it.filterText,
            // 补全未导入的类时 jdt.ls 会附带 import 行；只改编辑器里的内容，落盘仍由用户保存
            additionalTextEdits: it.additionalTextEdits?.map((e) => ({
              range: toMonacoRange(e.range),
              text: e.newText,
            })),
          };
        }),
      };
    },
  });

  monaco.languages.registerHoverProvider("java", {
    provideHover: async (model, position) => {
      const ctx = await context(model, position);
      if (!ctx) return null;
      const res = await ask<{ contents?: unknown; range?: LspRange }>("textDocument/hover", ctx);
      const parts = contentsToMarkdown(res?.contents);
      if (!res || parts.length === 0) return null;
      return {
        range: res.range ? toMonacoRange(res.range) : undefined,
        contents: parts.map((value) => ({ value })),
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider("java", {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp: async (model, position) => {
      const ctx = await context(model, position);
      if (!ctx) return null;
      const res = await ask<{
        signatures?: LspSignature[];
        activeSignature?: number;
        activeParameter?: number;
      }>("textDocument/signatureHelp", ctx);
      if (!res?.signatures?.length) return null;
      return {
        value: {
          signatures: res.signatures.map((s) => ({
            label: s.label,
            documentation: markdown(s.documentation),
            parameters: (s.parameters ?? []).map((p) => ({
              label: p.label,
              documentation: markdown(p.documentation),
            })),
          })),
          activeSignature: res.activeSignature ?? 0,
          activeParameter: res.activeParameter ?? 0,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerDefinitionProvider("java", {
    provideDefinition: async (model, position) => {
      const ctx = await context(model, position);
      if (!ctx) return lightDefinition(model, position);
      const res = await ask<unknown>("textDocument/definition", ctx);
      const out: Loc[] = [];
      for (const t of toTargets(res)) {
        // jar 内的类：先把源码取来建好只读 model，Monaco 才能解析这个目标
        if (t.uri.startsWith("jdt://")) {
          try {
            await loadJdtSource(t.uri);
          } catch {
            continue;
          }
        }
        const uri = monaco.Uri.parse(t.uri);
        rememberUri(uri.toString(), t.uri);
        out.push({ uri, range: toMonacoRange(t.range) });
      }
      return out;
    },
  });

  // F12 / Ctrl+点击跳到另一个文件时，Monaco 自己不会换标签，交给文件页打开。
  monaco.editor.registerEditorOpener({
    openCodeEditor: (_source, resource, selection) => {
      const orig = originalUri.get(resource.toString()) ?? resource.toString();
      const line =
        selection && "startLineNumber" in selection
          ? selection.startLineNumber
          : ((selection as Pos | undefined)?.lineNumber ?? 1);
      const column =
        selection && "startColumn" in selection
          ? selection.startColumn
          : ((selection as Pos | undefined)?.column ?? 1);
      if (orig.startsWith("jdt://")) {
        navigate({ kind: "jdt", uri: orig, line, column });
        return true;
      }
      const path = uriToPath(orig);
      if (!path) return false;
      navigate({ kind: "file", path, line, column });
      return true;
    },
  });
}
