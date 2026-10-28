// 编辑器模型仓库：每个打开的文件一个 Monaco model。
// 为什么不放 React state：model 是带撤销栈的命令式对象，切换标签页时必须原样保留（光标/撤销/滑动位置），
// 由 React 管理它的生命周期反而容易误销毁。React 只保存标签元数据（路径/编码/换行）。
import { monaco } from "./monacoSetup";
import { languageOf, type FileContent } from "./workspace";

type Model = ReturnType<typeof monaco.editor.createModel>;
type ViewState = ReturnType<ReturnType<typeof monaco.editor.create>["saveViewState"]>;

interface Entry {
  model: Model;
  /** 保存点对应的 alternative version id：改完又撤销回原样时能正确判定「未修改」。 */
  savedVersion: number;
  viewState: ViewState;
  lastDirty: boolean;
}

const entries = new Map<string, Entry>();
const dirtyListeners = new Set<(path: string, dirty: boolean) => void>();
/** model 的 uri 字符串 → 仓库里的键（真实路径或 jdt:// 地址）。Monaco 的 fsPath 会改盘符大小写，不能反推。 */
const pathByUri = new Map<string, string>();
const openListeners = new Set<(path: string, model: Model) => void>();
const closeListeners = new Set<(path: string) => void>();

/** 订阅 model 的创建与销毁（代码智能据此同步 didOpen / didClose）。返回取消订阅函数。 */
export function onModelLifecycle(
  onOpen: (path: string, model: Model) => void,
  onClose: (path: string) => void,
): () => void {
  openListeners.add(onOpen);
  closeListeners.add(onClose);
  return () => {
    openListeners.delete(onOpen);
    closeListeners.delete(onClose);
  };
}

/** model 对应的仓库键；不是本仓库创建的 model 返回 undefined。 */
export function pathOfModel(model: Model): string | undefined {
  return pathByUri.get(model.uri.toString());
}

/** 当前所有已打开的真实文件（不含虚拟 model）。 */
export function forEachModel(cb: (path: string, model: Model) => void): void {
  entries.forEach((e, path) => cb(path, e.model));
}

function register(path: string, entry: Entry): void {
  entries.set(path, entry);
  pathByUri.set(entry.model.uri.toString(), path);
  openListeners.forEach((cb) => cb(path, entry.model));
}

function unregister(path: string, entry: Entry): void {
  closeListeners.forEach((cb) => cb(path));
  pathByUri.delete(entry.model.uri.toString());
  entries.delete(path);
}

/**
 * 打开（或复用）一个只读的虚拟 model，如 jdt.ls 给出的 `jdt://` 类源码。
 * 键就是它的地址；内容一旦取到就不会再变（jar 不会在运行中改），所以不需要重新加载。
 */
export function openVirtualModel(uri: string, text: string): Model {
  const existing = entries.get(uri);
  if (existing) return existing.model;
  const model = monaco.editor.createModel(text, "java", monaco.Uri.parse(uri));
  const entry: Entry = {
    model,
    savedVersion: model.getAlternativeVersionId(),
    viewState: null,
    lastDirty: false,
  };
  register(uri, entry);
  return model;
}

/** 订阅「未保存」状态变化（只在 dirty 真正翻转时触发，不是每次击键）。返回取消订阅函数。 */
export function onDirtyChange(cb: (path: string, dirty: boolean) => void): () => void {
  dirtyListeners.add(cb);
  return () => dirtyListeners.delete(cb);
}

/** 打开（或复用）一个文件的 model。 */
export function openModel(path: string, content: FileContent): Model {
  const existing = entries.get(path);
  if (existing) return existing.model;
  const model = monaco.editor.createModel(content.text, languageOf(path), monaco.Uri.file(path));
  const entry: Entry = {
    model,
    savedVersion: model.getAlternativeVersionId(),
    viewState: null,
    lastDirty: false,
  };
  watch(path, entry);
  register(path, entry);
  return model;
}

/** 挂「未保存」监听。闭包里的 path 必须是创建时的路径，改名时要重新挂一次。 */
function watch(path: string, entry: Entry): void {
  const { model } = entry;
  model.onDidChangeContent(() => {
    const dirty = model.getAlternativeVersionId() !== entry.savedVersion;
    if (dirty !== entry.lastDirty) {
      entry.lastDirty = dirty;
      dirtyListeners.forEach((cb) => cb(path, dirty));
    }
  });
}

/**
 * 文件改名后把 model 挪到新路径。
 *
 * Monaco 的 uri 建好就不能改，只能带内容重建一份——撤销栈会丢，这是重命名要付的代价。
 * 原本「未保存」的，重建后仍算未保存（savedVersion 给一个不可能等于当前版本的值）。
 */
export function renameModel(oldPath: string, newPath: string): void {
  const e = entries.get(oldPath);
  if (!e) return;
  const text = e.model.getValue(monaco.editor.EndOfLinePreference.LF);
  const wasDirty = e.lastDirty;
  const viewState = e.viewState;
  unregister(oldPath, e);
  e.model.dispose();
  const model = monaco.editor.createModel(text, languageOf(newPath), monaco.Uri.file(newPath));
  const entry: Entry = {
    model,
    savedVersion: wasDirty ? -1 : model.getAlternativeVersionId(),
    viewState,
    lastDirty: wasDirty,
  };
  watch(newPath, entry);
  register(newPath, entry);
}

export function getModel(path: string): Model | undefined {
  return entries.get(path)?.model;
}

/** 编辑器里的文本，统一用 `\n`（后端按文件原换行还原）。 */
export function getText(path: string): string | undefined {
  return entries.get(path)?.model.getValue(monaco.editor.EndOfLinePreference.LF);
}

/** 保存成功后调用：把当前版本记为干净。 */
export function markSaved(path: string): void {
  const e = entries.get(path);
  if (!e) return;
  e.savedVersion = e.model.getAlternativeVersionId();
  if (e.lastDirty) {
    e.lastDirty = false;
    dirtyListeners.forEach((cb) => cb(path, false));
  }
}

/** 用磁盘上的新内容覆盖编辑器（异地修改后选择「重新加载」）。会清空撤销栈。 */
export function replaceContent(path: string, content: FileContent): void {
  const e = entries.get(path);
  if (!e) return;
  e.model.setValue(content.text);
  e.model.pushStackElement();
  markSaved(path);
}

export function saveViewState(path: string, state: ViewState): void {
  const e = entries.get(path);
  if (e) e.viewState = state;
}

export function getViewState(path: string): ViewState {
  return entries.get(path)?.viewState ?? null;
}

export function closeModel(path: string): void {
  const e = entries.get(path);
  if (!e) return;
  unregister(path, e);
  e.model.dispose();
}
