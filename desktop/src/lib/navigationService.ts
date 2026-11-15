import { useSyncExternalStore } from "react";
import { monaco } from "./monacoSetup";
import { currentModel, cursorAt } from "./editorActions";
import { context } from "./langProviderContext";
import { getLangView, langRequest, langCapabilityEpoch, navigate, loadJdtSource, moduleOfPath } from "./lang";
import { workspaceEpoch } from "./workspaceEpoch";
import { pathOfModel, getText } from "./editorStore";
import { getSession } from "./workspaceSession";
import { uriToPath, toLspPosition } from "./langConvert";
import { searchTypes, jarTypeUri } from "./typeSearch";
import { libraryUri, readLibraryFile, parseLibraryUri } from "./libraryFiles";
import { upmLookup } from "./upm";
import { filePathKey, readFile } from "./workspace";
import { selectRelationView } from "./codeRelations";
import { NAVIGATION_LABELS, navigationTargets, qualifiedTypeAt, targetSource, typeSearchQueries, type NavigationKind, type NavigationTarget } from "./navigationTargets";

type Model = ReturnType<typeof monaco.editor.createModel>;
export interface NavigationIntent { uri: string; line: number; column: number; version: number; epoch: number; capability: number; group?: "left" | "right"; }
export interface NavigationState { intent: NavigationIntent | null; kind: NavigationKind; title: string; items: NavigationTarget[]; loading: boolean; error: string; note: string; open: boolean; }
const EMPTY: NavigationState = { intent: null, kind: "definition", title: "", items: [], loading: false, error: "", note: "", open: false };
let state = EMPTY, sequence = 0;
const relationResults: Partial<Record<NavigationKind, NavigationState>> = {};
const listeners = new Set<() => void>();
const publish = (patch: Partial<NavigationState>) => {
  state = { ...state, ...patch };
  if (state.kind === "references" || state.kind === "assembly") {
    const previous = relationResults[state.kind];
    relationResults[state.kind] = previous && (state.loading || state.error) ? { ...state, items: previous.items, intent: previous.intent } : state;
  }
  listeners.forEach(cb => cb());
};
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const getNavigationState = () => state;
export const useNavigationState = () => useSyncExternalStore(subscribe, getNavigationState, getNavigationState);
export const getNavigationResult = (kind: NavigationKind) => relationResults[kind] ?? EMPTY;
export const useNavigationResult = (kind: NavigationKind) => useSyncExternalStore(subscribe, () => getNavigationResult(kind), () => EMPTY);
let restoreFocus = true;
export const navigationShouldRestoreFocus = () => restoreFocus;
export function closeNavigation() { restoreFocus = true; ++sequence; publish({ open: false, loading: false }); }
export function captureNavigation(model: Model, line: number, column: number): NavigationIntent {
  return { uri: model.uri.toString(), line, column, version: model.getVersionId(), epoch: workspaceEpoch(), capability: langCapabilityEpoch(), group: getSession().editorGroups?.focused ?? "left" };
}
export function currentNavigationIntent(): NavigationIntent | null {
  const model = currentModel(), position = cursorAt();
  return model && position ? captureNavigation(model, position.line, position.column) : null;
}
function resolveIntent(intent: NavigationIntent): Model | null {
  const model = monaco.editor.getModel(monaco.Uri.parse(intent.uri));
  return model && !model.isDisposed() && model.getVersionId() === intent.version && workspaceEpoch() === intent.epoch && langCapabilityEpoch() === intent.capability ? model : null;
}
const queryGroupCurrent = (intent: NavigationIntent) => {
  const session = getSession();
  // 本次查询绑定活动文档，保留的代码关系结果仍允许显式打开。
  return (!intent.group || intent.group === (session.editorGroups?.focused ?? "left")) && !!session.activePath
    && filePathKey(session.activePath) === filePathKey(uriToPath(intent.uri) ?? intent.uri);
};
async function query(model: Model, intent: NavigationIntent, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const path = pathOfModel(model), virtual = getSession().tabs.find(tab => tab.path === path)?.virtual;
  if (path?.startsWith("jdt://") && virtual === "source") {
    return langRequest(method, null, { textDocument: { uri: path }, position: toLspPosition(intent.line, intent.column), ...params });
  }
  const ctx = await context(model, { lineNumber: intent.line, column: intent.column });
  if (!ctx) {
    const view = getLangView();
    if (virtual) throw new Error("反编译文档的行号与二进制不同。请从源码调用点查询语义关系，或按完整类名搜索目标。");
    throw new Error(view.state === "indexing" || view.state === "starting" ? "代码智能正在建立索引，完成后请重试。" : "当前文件的代码智能未就绪，请启动代码智能或检查文件所在模块与依赖。");
  }
  return langRequest(method, ctx.path, { position: ctx.position, ...params });
}
const zeroRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
async function exactTypes(name: string): Promise<NavigationTarget[]> {
  const responses = await Promise.all(typeSearchQueries(name).map(query => searchTypes(query, 100)));
  const result = { workspace: responses.flatMap(result => result.workspace), jars: responses.flatMap(result => result.jars), indexing: responses.some(result => result.indexing), jarsPending: responses.some(result => result.jarsPending) };
  const targets = [...result.workspace, ...result.jars].filter(hit => name.includes(".") ? hit.name.replace(/\$/g, ".") === name.replace(/\$/g, ".") : hit.simple === name).map(hit => ({
    uri: hit.jar ? jarTypeUri(hit) : monaco.Uri.file(hit.file).toString(),
    range: { start: { line: Math.max(0, hit.line - 1), character: Math.max(0, hit.column - 1) }, end: { line: Math.max(0, hit.line - 1), character: Math.max(0, hit.column - 1) } },
    label: hit.name, source: hit.jar || hit.file, origin: hit.jar ? "library" as const : "source" as const, module: hit.module || undefined,
  }));
  if (!targets.length && (result.indexing || result.jarsPending)) throw new Error("类目录仍在建立索引，完成后请重试。");
  return targets.filter((target, index) => targets.findIndex(other => other.uri === target.uri && other.range.start.line === target.range.start.line && other.range.start.character === target.range.start.character) === index);
}
export async function openQualifiedType(name: string, intent: NavigationIntent): Promise<void> {
  if (!/^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*$/.test(name) || !resolveIntent(intent)) return;
  intent = { ...intent, group: intent.group ?? getSession().editorGroups?.focused ?? "left" };
  const request = ++sequence;
  publish({ ...EMPTY, intent, title: `打开类型 · ${name}`, loading: true, open: true });
  try {
    const targets = await exactTypes(name);
    if (request !== sequence) return;
    if (!resolveIntent(intent) || !queryGroupCurrent(intent)) { publish({ loading: false, error: "文件、工程或活动编辑器已变化，请重新查询。" }); return; }
    publish({ items: targets, loading: false, error: targets.length ? "" : `没有找到 ${name}，请检查工程源码和库索引。` });
    if (targets.length === 1) await chooseNavigationTarget(targets[0]);
  } catch (error) { if (request === sequence) publish({ loading: false, error: String(error).replace(/^Error: /, "") }); }
}
async function assembly(model: Model, intent: NavigationIntent): Promise<{ targets: NavigationTarget[]; note: string }> {
  const name = qualifiedTypeAt(model.getValue(), intent.line, intent.column);
  if (!name) throw new Error("请把光标放在 NC 服务接口或 lookup 中的接口类名上。");
  const hits = await upmLookup(name);
  const out: NavigationTarget[] = [];
  const notes = new Set<string>();
  for (const hit of hits.slice(0, 100)) {
    out.push({ uri: monaco.Uri.file(hit.path).toString(), range: zeroRange, label: `${hit.interface} → ${hit.implementation} · UPM 注册`, source: hit.path, module: hit.module, origin: "assembly" });
    try { for (const target of await exactTypes(hit.implementation)) out.push({ ...target, label: `${hit.implementation} · 配置注册的实现`, module: hit.module }); }
    catch (error) { notes.add(String(error).replace(/^Error: /, "")); }
  }
  return { targets: out, note: [...notes].join(" ") };
}
async function fieldReferences(model: Model, intent: NavigationIntent): Promise<{ references: unknown; truncated?: boolean } | null> {
  try {
    const result = await query(model, intent, "workspace/executeCommand", { command: "ncforge.fieldAccesses", arguments: [{ uri: "", line: intent.line - 1, character: intent.column - 1 }] }) as { references?: unknown; truncated?: boolean } | null;
    return result && Array.isArray(result.references) ? result as { references: unknown; truncated?: boolean } : null;
  } catch { return null; } // Non-field symbols continue through standard semantic references.
}
export async function openNavigation(kind: NavigationKind, supplied = currentNavigationIntent(), preview = false): Promise<void> {
  if (!supplied) return;
  supplied = { ...supplied, group: supplied.group ?? getSession().editorGroups?.focused ?? "left" };
  const request = ++sequence, model = resolveIntent(supplied);
  publish({ ...EMPTY, open: true, kind, title: NAVIGATION_LABELS[kind], intent: supplied, loading: true });
  if (!model || !queryGroupCurrent(supplied)) { publish({ loading: false, error: "文件、工程或活动编辑器已变化，请在当前位置重新执行。" }); return; }
  try {
    let targets: NavigationTarget[], extraNote = "";
    if (kind === "assembly") { const result = await assembly(model, supplied); targets = result.targets; extraNote = result.note; }
    else {
      const method = kind === "super" ? "java/findLinks" : `textDocument/${kind === "type" ? "typeDefinition" : kind}`;
      const params = kind === "references" ? { context: { includeDeclaration: false } } : kind === "super" ? {
        type: "superImplementation", position: { textDocument: { uri: model.uri.toString() }, position: toLspPosition(supplied.line, supplied.column) },
      } : {};
      const fields = kind === "references" ? await fieldReferences(model, supplied) : null;
      targets = navigationTargets(fields ? fields.references : await query(model, supplied, method, params));
      if (fields?.truncated) extraNote = "字段引用查询达到数量或时间上限，请缩小工程范围。";
      if (!targets.length && kind === "definition") {
        const name = qualifiedTypeAt(model.getValue(), supplied.line, supplied.column);
        if (name) targets = await exactTypes(name);
      }
    }
    if (request !== sequence) return;
    if (!resolveIntent(supplied) || !queryGroupCurrent(supplied)) { publish({ loading: false, error: "查询期间文件、工程或活动编辑器发生变化，请重新查询。" }); return; }
    targets = targets.map(target => ({ ...target, module: target.module ?? moduleOfPath(uriToPath(target.uri) ?? "") ?? undefined }));
    const total = targets.length;
    const message = "没有找到目标。请检查接口是否有实现、源码根和工程依赖是否完整。", relation = kind === "references" || kind === "assembly";
    publish({ items: targets.slice(0, 400), loading: false, note: [total > 400 ? `共 ${total} 处，显示前 400 处，请按模块或来源缩小范围。` : kind === "assembly" ? "来自 UPM 配置注册；运行时实际对象需在调试中确认。" : "", extraNote, !total && relation ? message : ""].filter(Boolean).join(" "), error: total || relation ? "" : message });
    if (targets.length === 1 && !preview && kind !== "references" && kind !== "assembly") await chooseNavigationTarget(targets[0]);
    if (kind === "references" || kind === "assembly") { selectRelationView(kind); publish({ open: false }); }
  } catch (error) { if (request === sequence) publish({ loading: false, error: String(error).replace(/^Error: /, "") }); }
}
export async function chooseNavigationTarget(target: NavigationTarget, right = false, intent = state.intent): Promise<void> {
  if (!intent || !resolveIntent(intent) || state.open && intent === state.intent && !queryGroupCurrent(intent)) {
    const error = "查询后文件或工程发生变化，请重新查询。";
    if (!intent || intent === state.intent) publish({ error });
    else { for (const kind of ["references", "assembly"] as const) if (relationResults[kind]?.intent === intent) relationResults[kind] = { ...relationResults[kind]!, error }; listeners.forEach(cb => cb()); }
    return;
  }
  const request = sequence, path = uriToPath(target.uri), line = target.range.start.line + 1, column = target.range.start.character + 1;
  const opened = await navigate(path ? { kind: "file", path, line, column, right } : { kind: "jdt", uri: target.uri, line, column, right });
  if (opened && request === sequence) { restoreFocus = false; ++sequence; publish({ open: false, loading: false }); }
}
export async function navigationPreview(target: NavigationTarget): Promise<{ text: string; note: string }> {
  const path = uriToPath(target.uri), library = parseLibraryUri(target.uri);
  if (path) return { text: getText(path) ?? (await readFile(path)).text, note: "源码预览" };
  if (library) { const result = await readLibraryFile(library); return { text: result.text, note: result.decompiled ? "反编译只读预览，行号不等于原始源码" : "库文件只读预览" }; }
  const result = await loadJdtSource(target.uri, true);
  return { text: result.text, note: result.text.includes("Failed to get sources") ? "签名预览；打开后尝试反编译实现" : "库源码只读预览" };
}
/** Library names are precise candidates, not evidence that the class is on the semantic classpath. */
export function libraryNavigationTarget(source: string, entry: string, archive: boolean, label: string): NavigationTarget {
  const uri = libraryUri({ source, entry, archive });
  return { uri, range: zeroRange, label, source: targetSource(uri), origin: "library" };
}
