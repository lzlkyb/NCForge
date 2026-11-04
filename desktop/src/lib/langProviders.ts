// 把 jdt.ls 的能力挂到 Monaco：补全、悬停、签名提示、跳转定义。
// 所有请求都带真实文件路径（由后端换成影子工程 URI）；服务未就绪或文件不属于当前模块时一律返回 null，
// 让 Monaco 退回到自带的「当前文档单词补全」，不弹错。
import { pathOfModel } from "./editorStore";
import { searchWorkspace, type SearchHit } from "./search";
import { getSession } from "./workspaceSession";
import { langRequest, loadJdtSource, navigate, langCapabilityEpoch } from "./lang";
import { workspaceEpoch } from "./workspaceEpoch";
import {
  contentsToMarkdown,
  declarationPattern,
  isIdentifier,
  toMonacoRange,
  toTargets,
  uriToPath,
  type LspRange,
} from "./langConvert";
import { monaco } from "./monacoSetup";
import { registerJavaCompletion } from "./javaCompletion";
import { context, type Ctx } from "./langProviderContext";
export { context, type Ctx } from "./langProviderContext";

type Model = ReturnType<typeof monaco.editor.createModel>;
type Pos = { lineNumber: number; column: number };

/** Monaco 的 uri 字符串 → jdt.ls 给出的原始地址。打开跳转目标时要用原始地址查。 */
const originalUri = new Map<string, string>();
/** 这个映射只增不减会线性泄漏；跳转目标地址没有长期价值，超上限直接清空。 */
const ORIGINAL_URI_MAX = 500;

function rememberUri(monacoUri: string, original: string): void {
  originalUri.set(monacoUri, original);
  if (originalUri.size > ORIGINAL_URI_MAX) originalUri.clear();
}

export async function ask<T>(
  method: string,
  ctx: Ctx,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T | null> {
  try {
    return await langRequest<T>(method, ctx.path, { position: ctx.position, ...params }, timeoutMs);
  } catch {
    // 超时、服务重启中等：先静默退回，不打断输入；要不要提示由调用方决定
    return null;
  }
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

  registerJavaCompletion();

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
    signatureHelpRetriggerCharacters: [")"],
    provideSignatureHelp: async (model, position, token, trigger) => {
      const version = model.getVersionId(), epoch = workspaceEpoch(), capabilityEpoch = langCapabilityEpoch();
      const current = () => !token.isCancellationRequested && !model.isDisposed()
        && model.getVersionId() === version && workspaceEpoch() === epoch && langCapabilityEpoch() === capabilityEpoch;
      if (!current()) return null;
      const ctx = await context(model, position);
      if (!ctx || !current()) return null;
      const res = await ask<{
        signatures?: LspSignature[];
        activeSignature?: number;
        activeParameter?: number;
      }>("textDocument/signatureHelp", ctx, { context: {
        triggerKind: trigger.triggerKind, isRetrigger: trigger.isRetrigger,
        ...(trigger.triggerCharacter ? { triggerCharacter: trigger.triggerCharacter } : {}),
      } });
      if (!res?.signatures?.length || !current()) return null;
      const activeSignature = Math.max(0, Math.min(res.activeSignature ?? 0, res.signatures.length - 1));
      const activeParameter = Math.max(0, Math.min(res.activeParameter ?? 0, (res.signatures[activeSignature].parameters?.length ?? 1) - 1));
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
          activeSignature, activeParameter,
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
        // jar 内的类：先把源码取来建好只读 model，Monaco 才能解析这个目标。
        // peek 身份：用户多半只是看一眼 peek 窗口，不成标签页，model 走预览队列按上限淘汰
        if (t.uri.startsWith("jdt://")) {
          try {
            await loadJdtSource(t.uri, true);
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
