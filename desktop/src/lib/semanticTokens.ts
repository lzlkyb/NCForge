// 语义着色：把 jdt.ls 0.57 的语义 token 接成 Monaco 的 DocumentSemanticTokensProvider。
//
// 0.57 没有标准 LSP 的 `textDocument/semanticTokens/full`，也没开 draft 的
// `textDocument/semanticHighlighting` 推送；只有 executeCommand
// `java.project.provideSemanticTokens`（返回标准 5 元组增量流，见 `tests/semantic_tokens_live.rs`）。
// 走**拉取**而不是 draft 推送：推送要客户端按行维护缓存、跟着编辑做行位移，错一行就永久错位；
// 拉取整份重算，正好是 Monaco provider 的形状，正确性成本最低。
import { pathOfModel } from "./editorStore";
import { flushDoc, inLangModule, langCapabilityEpoch, langReady, langRequest, onLangReadyChange } from "./lang";
import { monaco } from "./monacoSetup";
import { JAVA_CONSTANT_KIND, javaSemanticToken } from "./javaColors";
import { workspaceEpoch } from "./workspaceEpoch";
import { invoke } from "./tauri";

/** deprecated 修饰统一映射到这个附加类型：Monaco 的主题选择器按 `类型.修饰1.修饰2` 匹配，
 *  修饰顺序不定（public+deprecated / deprecated+protected…），只有换类型才能稳定画删除线。 */
export const DEPRECATED_TOKEN_TYPE = "deprecated";

export interface SemanticLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

type Model = ReturnType<typeof monaco.editor.createModel>;

/**
 * 校验并转成 Monaco 的 `data`：5 元组增量流（Δline, Δstart, length, type, modifiers）。
 * 形状不对就整份丢弃——宁可这次不着色，也不把乱数喂给 Monaco（它会断言/错位）。
 */
export function toTokenData(raw: unknown): Uint32Array | null {
  if (!Array.isArray(raw) || raw.length % 5 !== 0) return null;
  const data = new Uint32Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    const v = raw[i];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffffffff) return null;
    if (i % 5 === 2 && v === 0) return null; // 长度 0 的 token 非法
    data[i] = v;
  }
  return data;
}

/** 服务端 legend 的形状校验，并追加 DEPRECATED_TOKEN_TYPE。 */
export function parseLegend(v: unknown): SemanticLegend | null {
  const o = v as { tokenTypes?: unknown; tokenModifiers?: unknown } | null;
  const strings = (x: unknown): x is string[] =>
    Array.isArray(x) && x.every((s) => typeof s === "string");
  if (!o || !strings(o.tokenTypes) || !strings(o.tokenModifiers)) return null;
  if (o.tokenTypes.length === 0) return null;
  return {
    tokenTypes: [...o.tokenTypes, DEPRECATED_TOKEN_TYPE],
    tokenModifiers: o.tokenModifiers,
  };
}

/** `deprecated` 在 modifiers 里的位掩码；没有这个修饰符就返回 0。 */
export function deprecatedBit(legend: SemanticLegend): number {
  const i = legend.tokenModifiers.indexOf("deprecated");
  return i < 0 || i > 30 ? 0 : 1 << i;
}

/** 把带 deprecated 位的 token 改成附加类型（原地改 data，它必须是 toTokenData 的产物）。 */
export function markDeprecated(data: Uint32Array, bit: number, typeIndex: number): void {
  if (bit === 0) return;
  for (let i = 4; i < data.length; i += 5) {
    if (data[i] & bit) data[i - 1] = typeIndex;
  }
}

/** 每个文件最近一次的结果，按 model 版本号复用（Monaco 会因配置/语言变化重复询问）。 */
const cache = new WeakMap<Model, { version: number; session: number; workspace: number; data: Uint32Array }>();
const changeListeners = new Set<() => void>();
let legend: SemanticLegend | null = null;
let provider: monaco.languages.DocumentSemanticTokensProvider | null = null;
let pending: Promise<void> | null = null;
let wired = false;

function fireChange(): void {
  changeListeners.forEach((cb) => cb());
}

/** A field needs both modifiers to be rendered as a Java constant. */
export function markConstants(data: Uint32Array, legend: SemanticLegend, constantIndex: number): void {
  const field = legend.tokenTypes.indexOf("property");
  const staticIndex = legend.tokenModifiers.indexOf("static");
  const readonlyIndex = legend.tokenModifiers.indexOf("readonly");
  if (field < 0 || staticIndex < 0 || readonlyIndex < 0 || staticIndex > 30 || readonlyIndex > 30) return;
  const mask = (1 << staticIndex) | (1 << readonlyIndex);
  for (let i = 3; i < data.length; i += 5) {
    if (data[i] === field && (data[i + 1] & mask) === mask) data[i] = constantIndex;
  }
}

async function fetchLegend(): Promise<SemanticLegend | null> {
  const res = await langRequest<unknown>(
    "workspace/executeCommand",
    null,
    { command: "java.project.getSemanticTokensLegend", arguments: [] },
    15_000,
  ).catch(() => null);
  return parseLegend(res);
}

function makeProvider(l: SemanticLegend): monaco.languages.DocumentSemanticTokensProvider {
  const bit = deprecatedBit(l);
  const deprecatedIndex = l.tokenTypes.length - 1;
  const constantIndex = l.tokenTypes.length;
  const types = [...l.tokenTypes, JAVA_CONSTANT_KIND].map(javaSemanticToken);
  return {
    getLegend: () => ({ tokenTypes: types, tokenModifiers: l.tokenModifiers }),
    provideDocumentSemanticTokens: async (model, _lastResultId, cancel) => {
      const path = pathOfModel(model);
      if (!path || !langReady() || !inLangModule(path)) return null;
      // 版本要在发请求**之前**取：等回复期间再编辑，结果对应的是旧文本，不能记到新版本上
      const version = model.getVersionId();
      const session = langCapabilityEpoch();
      const workspace = workspaceEpoch();
      const current = () => !cancel.isCancellationRequested && !model.isDisposed()
        && model.getVersionId() === version && langCapabilityEpoch() === session
        && workspaceEpoch() === workspace && langReady() && inLangModule(path);
      if (!current()) return null;
      const hit = cache.get(model);
      if (hit?.version === version && hit.session === session && hit.workspace === workspace) {
        return { resultId: String(version), data: hit.data };
      }
      const synced = await flushDoc(path).then(() => true, () => false);
      if (!synced || !current()) return null;
      const res = await invoke<{ data?: unknown }>("lang_semantic_tokens", { path }).catch(() => null);
      if (!current()) return null;
      const data = toTokenData(res?.data);
      if (!data) return null;
      markConstants(data, l, constantIndex);
      markDeprecated(data, bit, deprecatedIndex);
      cache.set(model, { version, session, workspace, data });
      return { resultId: String(version), data };
    },
    // resultId 只是 model 版本号，服务端没有要回收的资源
    releaseDocumentSemanticTokens: () => {},
    onDidChange: (cb) => {
      changeListeners.add(cb);
      return { dispose: () => changeListeners.delete(cb) };
    },
  };
}

/** 取 legend 并注册 provider（幂等）。legend 拿不到就不注册：类型索引对不上会全歪。 */
function ensureProvider(): Promise<void> {
  if (provider) return Promise.resolve();
  if (pending) return pending;
  pending = (async () => {
    const l = legend ?? (await fetchLegend());
    if (!l) return;
    legend = l;
    provider = makeProvider(l);
    monaco.languages.registerDocumentSemanticTokensProvider("java", provider);
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/**
 * 应用启动后调用一次（幂等）：服务就绪后注册 provider；服务切换后旧缓存失效并通知 Monaco 重取
 * （否则标签页里会一直挂着旧会话的颜色）。
 */
export function initSemanticTokens(): void {
  if (wired) return;
  wired = true;
  onLangReadyChange((ready) => {
    if (ready) {
      // 就绪时也要通知一次：服务重启后旧缓存失效，不主动重拉的话 Monaco 会一直
      // 保持「无 token」状态，直到用户下一次改动文件。
      void ensureProvider().then(() => fireChange());
      return;
    }
    fireChange();
  });
}
