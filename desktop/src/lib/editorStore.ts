// 编辑器模型仓库：每个打开的文件一个 Monaco model。
// 为什么不放 React state：model 是带撤销栈的命令式对象，切换标签页时必须原样保留（光标/撤销/滑动位置），
// 由 React 管理它的生命周期反而容易误销毁。React 只保存标签元数据（路径/编码/换行）。
import { fileFormat } from "./fileFormats";
import { monaco } from "./monacoSetup";
import { emitDirty } from "./dirtyBus";
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
/** model 的 uri 字符串 → 仓库里的键（真实路径或 jdt:// 地址）。Monaco 的 fsPath 会改盘符大小写，不能反推。 */
const pathByUri = new Map<string, string>();
const openListeners = new Set<(path: string, model: Model) => void>();
const closeListeners = new Set<(path: string) => void>();

/**
 * 预览（peek）身份的只读 model 上限。
 *
 * F12 / Ctrl+点击逐层跳转时，`provideDefinition` 会为每个 jar 内的目标预建只读 model
 * （Monaco 要能解析目标 URI 才会去打开它），而用户多半只是看一眼 peek 窗口、并不成标签页。
 * 没有上限时这些 model 只进不出：跳十几层就悄悄攒下同等数量的常驻文档。
 */
const PEEK_MODEL_CAP = 32;
/** 预览身份的 model 键，按最近使用排序（末尾最新）。超上限时淘汰队首。 */
const peekOrder: string[] = [];

/** 预览模型被再次用到时刷新新鲜度（LRU：常用的不会被淘汰）。 */
function touchPeek(path: string): void {
  const i = peekOrder.indexOf(path);
  if (i < 0) return;
  peekOrder.splice(i, 1);
  peekOrder.push(path);
}

/** 把模型从预览队列里摘掉（转成正式身份、或被关闭时）。 */
function unqueuePeek(path: string): void {
  const i = peekOrder.indexOf(path);
  if (i >= 0) peekOrder.splice(i, 1);
}

/** 超上限时淘汰最旧的预览模型。正在编辑器里显示的那个刚被 touchModel 保活过，不会是最旧的。 */
function evictPeek(): void {
  while (peekOrder.length > PEEK_MODEL_CAP) {
    const oldest = peekOrder.shift();
    if (oldest === undefined) return;
    const e = entries.get(oldest);
    // 已经被关掉的（标签页关闭走 closeModel）：队列里只剩过期键，跳过即可
    if (!e) continue;
    unregister(oldest, e);
    e.model.dispose();
  }
}

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

/**
 * 只遍历「未保存」的 model。
 *
 * 搜索要把这些内容作为 overlay 传给后端：磁盘上还是旧内容，不覆盖的话
 * 「搜自己刚写的那行」搜不到——这比慢更让人以为工具坏了。
 */
export function forEachDirtyModel(cb: (path: string, model: Model) => void): void {
  entries.forEach((e, path) => {
    if (e.lastDirty) cb(path, e.model);
  });
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
 *
 * `peek: true` 表示这个 model 只是给预览窗口用的：进预览队列，数量超上限时按
 * 最近使用淘汰。默认（不传）是正式身份：要么本来就在队列里（转正、摘牌，之后不受
 * 上限约束），要么新建后不进队列——调用方保证它会成为标签页，由 closeModel 收尾。
 *
 * `replace: true` 允许覆盖已有内容。唯一的用处是「预览先给了签名桩，正式打开拿到了
 * 反编译结果」——内容确实会变的那一次（见 `lang.ts::loadJdtSource`）。覆盖会清掉
 * undo 栈与光标，只读 model 上无所谓；可编辑文件永远不走这个函数。
 */
export function openVirtualModel(
  uri: string,
  text: string,
  opts?: { peek?: boolean; replace?: boolean },
): Model {
  const existing = entries.get(uri);
  if (existing) {
    if (opts?.peek) touchPeek(uri);
    else unqueuePeek(uri);
    if (opts?.replace && existing.model.getValue() !== text) {
      admitModel(text, existing.model);
      existing.model.setValue(text);
      existing.savedVersion = existing.model.getAlternativeVersionId();
    }
    return existing.model;
  }
  admitModel(text);
  const model = monaco.editor.createModel(text, "java", monaco.Uri.parse(uri));
  const entry: Entry = {
    model,
    savedVersion: model.getAlternativeVersionId(),
    viewState: null,
    lastDirty: false,
  };
  register(uri, entry);
  if (opts?.peek) {
    peekOrder.push(uri);
    evictPeek();
  }
  return model;
}

/**
 * 保活正在显示的 model：预览身份（peek 队列里）的模型被编辑器显示时调用。
 * 转正路径（openJdt）已经摘了牌，这里是二道网——万一显示中的模型还在队列里，
 * 至少不会紧接着就被当成「最旧」淘汰掉。
 */
export function touchModel(path: string): void {
  touchPeek(path);
}

/** 订阅「未保存」状态变化见 `dirtyBus.onDirtyChange`——这里不再持有订阅者，免得把
 * workspaceSession 拖进 Monaco。 */

/** 打开（或复用）一个文件的 model。 */
const MODEL_TEXT_BUDGET = 64 * 1024 * 1024;
function admitModel(text: string, replacing?: Model): void {
  let bytes = text.length * 2;
  entries.forEach(entry => { if (entry.model !== replacing) bytes += entry.model.getValueLength() * 2; });
  // Admission preserves dirty buffers and undo history rather than silently discarding them.
  if (bytes > MODEL_TEXT_BUDGET) throw new Error("编辑器正文已达到 64 MiB 预算，请保存并关闭部分标签后重试");
}

export function openModel(path: string, content: FileContent): Model {
  const existing = entries.get(path);
  if (existing) return existing.model;
  admitModel(content.text);
  const model = monaco.editor.createModel(content.text, languageOf(path, content.text), monaco.Uri.file(path));
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
      emitDirty(path, dirty);
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
  const model = monaco.editor.createModel(text, languageOf(newPath, text), monaco.Uri.file(newPath));
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

/**
 * 按路径找 model，带大小写不敏感回退。
 *
 * 为什么不能只用 `getModel`：跨文件重命名拿到的路径来自 LSP，与标签里的路径
 * 可能大小写不一致（Windows 上盘符与目录名经常混用）。严格匹配漏掉的后果是
 * 「走了写盘那条路」——磁盘改了、编辑器还是旧内容，用户一保存就把改名悄悄
 * 撤回去，还不报任何错。
 */
export function findModel(path: string): Model | undefined {
  const direct = entries.get(path)?.model;
  if (direct) return direct;
  const lower = path.toLowerCase();
  for (const [key, e] of entries) {
    if (key.toLowerCase() === lower) return e.model;
  }
  return undefined;
}

/** 编辑器里的文本，统一用 `\n`（后端按文件原换行还原）。 */
export function getText(path: string): string | undefined {
  return entries.get(path)?.model.getValue(monaco.editor.EndOfLinePreference.LF);
}

/** 保存成功后调用：把当前版本记为干净。 */
export function markSaved(path: string, version?: number): void {
  const e = entries.get(path);
  if (!e) return;
  // 写盘耗时期间仍可打字：保存点只能是提交的版本，不能抹掉后续编辑。
  e.savedVersion = version ?? e.model.getAlternativeVersionId();
  const dirty = e.model.getAlternativeVersionId() !== e.savedVersion;
  if (!dirty && fileFormat(path).language === "xml-content") {
    const language = languageOf(path, e.model.getValue());
    if (language !== e.model.getLanguageId()) monaco.editor.setModelLanguage(e.model, language);
  }
  if (e.lastDirty !== dirty) {
    e.lastDirty = dirty;
    emitDirty(path, dirty);
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
  // 预览身份的也要摘牌：否则队列里留下一个已销毁的键，占额度还不淘汰任何东西
  unqueuePeek(path);
  unregister(path, e);
  e.model.dispose();
}
