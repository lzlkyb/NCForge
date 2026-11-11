// 代码智能（jdt.ls）的前端侧：状态仓库、事件订阅、文档同步、诊断展示、自动启动。
//
// 模块级单例：文件页切走会卸载组件，但 jdt.ls 进程与已打开的文档不能跟着丢。
// 后端只认真实文件路径（影子工程的 URI 映射在 Rust 侧完成），这里不碰**文件** URI；
// 唯一的例外是 `jdt://`——它本来就是语言服务的地址，反编译要用它定位 jar 与条目。
import { beginOperation } from "./operations";
import { useSyncExternalStore } from "react";
import { forEachModel, onModelLifecycle, openVirtualModel } from "./editorStore";
import { workspaceEpoch } from "./workspaceEpoch";
import { isStubSource, severityName, toMonacoRange, uriToPath, type LspRange } from "./langConvert";
import { decompileClass, decompileHeader } from "./decompile";
import { friendlyError } from "./friendlyError";
import { monaco } from "./monacoSetup";
import { setCodeDiags, type CodeDiag } from "./diagStore";
import { getConfig } from "./appConfig";
import { invoke, listen } from "./tauri";
import { getSession } from "./workspaceSession";

export type LangState = "stopped" | "starting" | "indexing" | "ready" | "error";

export interface LangStatus {
  state: LangState;
  module: string | null;
  message: string;
  sourceFiles: number;
  jarCount: number;
  /** 读取 lang_status 失败：state 是上次的值、不是确定结论，UI 应显示「状态未知」。 */
  unknown?: boolean;
}

/** 状态 + 诊断是否已稳定。 */
interface ViewCore extends LangStatus {
  /** 就绪后约 12 秒内 jdt.ls 还在补算索引，诊断里会有假的「找不到类」，不显示。 */
  settled: boolean;
}

/** 页面用的视图：状态 + 诊断是否稳定 + 设置里的两个开关（状态栏据此决定显示「启动」按钮还是不显示）。 */
export interface LangView extends ViewCore {
  enabled: boolean;
  autoStart: boolean;
}

/** 设置页里的代码智能偏好（来自 AppConfig）。 */
export interface LangPrefs {
  lang_enabled: boolean;
  lang_auto_start: boolean;
}

/**
 * 诊断「稳定」的判定，不用固定等待。
 *
 * 原来是一个写死的 12 秒：一到点就把这期间收到的**未纠正**诊断全刷到编辑器上。
 * 而实测 gl 模块的稳定期是 20~40 秒，12 秒时 jdt.ls 还在补算索引，编辑器里
 * 满屏红线和「找不到 XXX 类」的幻影错误——用户会真的去改那些根本没问题的代码。
 *
 * 改为三个条件一起看：总时长够久（下限）、距上次诊断推送够久（说明它安静了）、
 * 以及一个无论如何都要放开的上限（服务彻底不推诊断时不能永远不显示）。
 */
const SETTLE_MIN_MS = 8_000;
const SETTLE_IDLE_MS = 5_000;
const SETTLE_MAX_MS = 60_000;
/** 稳定检测的轮询粒度。 */
const SETTLE_POLL_MS = 1_000;
/** 连续切标签时不要频繁重启语言服务。 */
const START_DEBOUNCE_MS = 1_500;
/** 文档变更同步的防抖。 */
const CHANGE_DEBOUNCE_MS = 150;
/** 诊断标记的 owner，清除时只清自己的。 */
const MARKER_OWNER = "jdt.ls";

const STOPPED: LangStatus = { state: "stopped", module: null, message: "", sourceFiles: 0, jarCount: 0 };

let prefs = { enabled: true, autoStart: true };
let view: LangView = { ...STOPPED, settled: false, ...prefs };
let capabilityEpoch = 0;
/** 服务重启时即使工作区和文件未变，旧 JDT 候选的 request id 也已经失效。 */
export const langCapabilityEpoch = (): number => capabilityEpoch;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
/** 服务进入 ready 的时刻。 */
let readyAt = 0;
/** 最后一次收到诊断推送的时刻（0 = 还没收到过任何诊断）。 */
let lastDiagAt = 0;
const listeners = new Set<() => void>();

function setView(next: ViewCore): void {
  view = { ...next, ...prefs };
  listeners.forEach((l) => l());
}

/** 设置页改了开关后调用。关掉总开关时后端会自己停服务并发 stopped 事件。 */
export function applyLangPrefs(p: LangPrefs): void {
  prefs = { enabled: p.lang_enabled, autoStart: p.lang_auto_start };
  setView(view);
}

export function getLangView(): LangView {
  return view;
}

export function useLangView(): LangView {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => view,
    () => view,
  );
}

const readyListeners = new Set<(ready: boolean) => void>();

/** 语言服务「就绪 ⇄ 非就绪」的订阅；注册时先按当前状态回调一次。给语义着色这类非 React 的常驻订阅用。 */
export function onLangReadyChange(cb: (ready: boolean) => void): () => void {
  readyListeners.add(cb);
  cb(langReady());
  return () => {
    readyListeners.delete(cb);
  };
}

/** 补全、跳转等请求能不能发。 */
export function langReady(): boolean {
  return view.state === "ready";
}

// ───────────────────── 路径与模块 ─────────────────────

/** `path` 在工作区下的模块名（工作区根下的第一级目录）；不在工作区内返回 null。 */
export function moduleOfPath(path: string): string | null {
  const root = getSession().root;
  if (!root) return null;
  const prefix = root.replace(/[\\/]+$/, "") + "\\";
  if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const seg = path.slice(prefix.length).split("\\")[0];
  return seg && path.length > prefix.length + seg.length ? seg : null;
}

/** 这个文件当前是不是由语言服务负责：是 .java，且属于正在服务的模块。 */
export function inLangModule(path: string): boolean {
  if (!path.toLowerCase().endsWith(".java") || !view.module) return false;
  return moduleOfPath(path)?.toLowerCase() === view.module.toLowerCase();
}

// ───────────────────── 文档同步 ─────────────────────

type Model = ReturnType<typeof monaco.editor.createModel>;

interface Doc {
  model: Model;
  version: number;
  syncedVersion: number;
  opened: boolean;
  pending: Promise<void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  sub: { dispose(): void };
  /**
   * 从 `editsBase` 版本起累积的局部改动（LSP 增量格式）。`null` = 这段时间里有说不清的改动
   * （整篇替换、事件没带明细、改动太碎），下一次必须发全文。
   */
  edits: LspChange[] | null;
  editsBase: number;
}

/** LSP `TextDocumentContentChangeEvent` 的增量形态。行列从 0 起，列按 UTF-16（与 Monaco 一致）。 */
interface LspChange {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  rangeLength: number;
  text: string;
}
/** 一次同步里最多带多少条增量；再碎就不如发一次全文。 */
const MAX_INCREMENTAL_EDITS = 200;

type ContentEvent = { isFlush?: boolean; changes?: readonly { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; rangeLength: number; text: string }[] };

/**
 * 把一次 Monaco 内容事件并进文档的待发增量。
 *
 * 顺序直接沿用 Monaco 的 `changes`：VS Code 扩展宿主也是原样转成 LSP 增量的，
 * 同一事件里的多处改动（多光标）已按「依次应用」排好。
 */
function recordEdits(doc: Doc, e: ContentEvent | undefined): void {
  if (!doc.edits) return;
  if (!e?.changes || e.isFlush || doc.edits.length + e.changes.length > MAX_INCREMENTAL_EDITS) {
    doc.edits = null;
    return;
  }
  for (const c of e.changes) {
    doc.edits.push({
      range: {
        start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
        end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
      },
      rangeLength: c.rangeLength,
      text: c.text,
    });
  }
}

const docs = new Map<string, Doc>();
const closingDocs = new Map<string, Promise<void>>();

function notify(method: string, path: string, params: Record<string, unknown>): Promise<void> {
  return invoke<unknown>("lang_notify", { method, path, params })
    .then(() => undefined);
}

function syncDoc(path: string, doc: Doc): Promise<void> {
  const version = doc.version;
  // 快速路径：这个版本已经确实发给 jdt.ls 了。每次补全 / 悬停 / 跳转前都会 flushDoc，
  // 没有新改动时不该再 getValue() 拷一遍整篇。只看「已发出」而不看「已排队」：
  // 排队中的那次可能因为服务未就绪而空转，不能拿它当成已同步。
  if (doc.syncedVersion >= version) return doc.pending;
  // 增量只在「已打开、且这段改动都有明细」时可用；否则照旧拷全文。
  // 切下这一段：之后的改动从 version 起重新累积。
  const base = doc.editsBase;
  const edits = doc.opened ? doc.edits : null;
  const text = edits ? null : doc.model.getValue();
  doc.edits = [];
  doc.editsBase = version;
  // 等待已发出的通知，而不只是等防抖定时器；IPC 写入必须按文档版本串行。
  const pending = doc.pending.catch(() => {}).then(async () => {
    if (docs.get(path) !== doc || !langReady() || !inLangModule(path) || doc.syncedVersion >= version) return;
    if (edits && doc.opened && doc.syncedVersion === base) {
      // 服务端手里正好是 base 版本，增量能接上
      await notify("textDocument/didChange", path, { textDocument: { version }, contentChanges: edits });
      doc.syncedVersion = version;
      return;
    }
    if (text === null) {
      // 本想发增量，但前一次没发成（失败 / 服务未就绪），服务端版本对不上：
      // 按当前最新内容发一次全文，并把累积点挂到最新版本
      const latest = doc.version;
      const full = doc.model.getValue();
      doc.edits = [];
      doc.editsBase = latest;
      await notify(doc.opened ? "textDocument/didChange" : "textDocument/didOpen", path,
        doc.opened
          ? { textDocument: { version: latest }, contentChanges: [{ text: full }] }
          : { textDocument: { languageId: "java", version: latest, text: full } });
      doc.opened = true;
      doc.syncedVersion = latest;
      return;
    }
    await notify(doc.opened ? "textDocument/didChange" : "textDocument/didOpen", path,
      doc.opened
        ? { textDocument: { version }, contentChanges: [{ text }] }
        : { textDocument: { languageId: "java", version, text } });
    doc.opened = true;
    doc.syncedVersion = version;
  });
  doc.pending = pending;
  // 自动同步失败不产生未处理异常；补全前的 flushDoc 仍能取得真实失败并重试。
  void pending.catch(() => {});
  return pending;
}

function openDoc(path: string, model: Model): void {
  if (docs.has(path)) return;
  const doc: Doc = {
    model,
    version: 1,
    syncedVersion: 0,
    opened: false,
    pending: closingDocs.get(path) ?? Promise.resolve(),
    timer: undefined,
    edits: [],
    editsBase: 1,
    sub: model.onDidChangeContent((e?: ContentEvent) => {
      doc.version += 1;
      recordEdits(doc, e);
      clearTimeout(doc.timer);
      doc.timer = setTimeout(() => void flushDoc(path).catch(() => {}), CHANGE_DEBOUNCE_MS);
    }),
  };
  docs.set(path, doc);
  void syncDoc(path, doc);
}

function closeDoc(path: string): void {
  const doc = docs.get(path);
  if (!doc) return;
  clearTimeout(doc.timer);
  doc.sub.dispose();
  docs.delete(path);
  const closing = doc.pending.catch(() => {}).then(async () => {
    if (closingDocs.get(path) === closing && doc.opened && langReady() && inLangModule(path)) {
      await notify("textDocument/didClose", path, { textDocument: {} });
    }
  });
  closingDocs.set(path, closing);
  void closing.catch(() => {}).then(() => {
    if (closingDocs.get(path) === closing) closingDocs.delete(path);
  });
}

/**
 * 把还没发出去的修改立即发给 jdt.ls。补全、跳转前必须先 await，否则算的是旧文本。
 *
 * 为什么必须 await：`didChange` 与随后的 `request` 是两次独立 IPC，两次
 * spawn_blocking 之间没有任何顺序保证。请求帧先到时，jdt.ls 按**改动前**的文本
 * 算补全位置——表现是补全结果整体错位几行，而且只在打字快时偶发，极难复现。
 * await 的是「Rust 已把通知写完 stdin」，这才真正建立了先后。
 */
export async function flushDoc(path: string): Promise<void> {
  const doc = docs.get(path);
  if (!doc) return;
  clearTimeout(doc.timer);
  doc.timer = undefined;
  await syncDoc(path, doc);
}

/** 服务端已不在：只丢本地记录，不再给它发 didClose。 */
function forgetDocs(): void {
  docs.forEach((d) => {
    clearTimeout(d.timer);
    d.sub.dispose();
  });
  docs.clear();
  closingDocs.clear();
}

function syncAll(): void {
  forEachModel((path, model) => {
    if (inLangModule(path)) openDoc(path, model);
  });
}

// ───────────────────── 诊断 ─────────────────────

interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
}

/** 最近一次收到的诊断（键 = 小写路径）。未稳定时只放这里不显示。 */
const latestDiags = new Map<string, LspDiagnostic[]>();

/** 键 → 真实路径。`latestDiags` 的键是小写路径（拿来比对 model），但面板要显示原样路径。 */
const diagPaths = new Map<string, string>();

/**
 * 把最新一批诊断摊平发给 `diagStore`，供「问题」面板与「跳到下一处」使用。
 *
 * 只在**整批刷新的时机**调（静默下来时、以及打开的文件收到新诊断时），不在每收到一个
 * 文档的诊断时就调：建索引期间 jdt.ls 会在几百毫秒里连推十几份，逐份发布等于让面板
 * 跟着不停地重建列表。
 */
function publishDiags(): void {
  const out: CodeDiag[] = [];
  latestDiags.forEach((list, key) => {
    const path = diagPaths.get(key) ?? key;
    for (const d of list) {
      const sev = severityName(d.severity);
      out.push({
        path,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: sev === "Error" ? "error" : sev === "Warning" ? "warning" : "info",
        message: d.message,
      });
    }
  });
  setCodeDiags(out);
}

function applyMarkers(lowerPath: string): void {
  const diags = latestDiags.get(lowerPath) ?? [];
  forEachModel((path, model) => {
    if (path.toLowerCase() !== lowerPath) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      diags.map((d) => ({
        ...toMonacoRange(d.range),
        message: d.message,
        severity: monaco.MarkerSeverity[severityName(d.severity)],
        source: d.source ?? MARKER_OWNER,
      })),
    );
  });
}

function clearMarkers(): void {
  latestDiags.clear();
  diagPaths.clear();
  monaco.editor.removeAllMarkers(MARKER_OWNER);
  publishDiags();
}

function onDiagnostics(params: { uri: string; diagnostics: LspDiagnostic[] }): void {
  const path = uriToPath(params.uri);
  if (!path) return;
  const key = path.toLowerCase();
  lastDiagAt = Date.now();
  latestDiags.set(key, params.diagnostics ?? []);
  diagPaths.set(key, path);
  if (view.settled) {
    applyMarkers(key);
    publishDiags();
  }
}

// ───────────────────── 状态变化 ─────────────────────

/**
 * 起一轮「等诊断安静下来」的轮询。
 *
 * 不用一次性定时器：jdt.ls 在建索引期间会持续推诊断，固定时长一到就刷标记，
 * 等于把还在变的结果当最终结论。这里每隔一秒看一眼「它安静了没有」。
 */
function armSettle(): void {
  clearTimeout(settleTimer);
  const tick = () => {
    if (view.state !== "ready") return; // 状态已经变了，这一轮作废
    const now = Date.now();
    const since = now - readyAt;
    const idle = now - (lastDiagAt || readyAt);
    if (since >= SETTLE_MAX_MS || (since >= SETTLE_MIN_MS && idle >= SETTLE_IDLE_MS)) {
      setView({ ...view, settled: true });
      latestDiags.forEach((_, key) => applyMarkers(key));
      // 一次刷完再发：面板要在所有文档的标记都对齐之后才更新列表
      publishDiags();
      return;
    }
    settleTimer = setTimeout(tick, SETTLE_POLL_MS);
  };
  settleTimer = setTimeout(tick, SETTLE_POLL_MS);
}

function onStatus(next: LangStatus): void {
  const prev = view.state;
  if ((prev === "ready") !== (next.state === "ready")) {
    capabilityEpoch++;
    const ready = next.state === "ready";
    // 放进微任务：让本次的 setView 先落地，订阅方在回调里读 langReady() 才是新状态。
    // 直接同步调会在「即将停止」时读到旧的 ready，向已经停掉的服务发请求。
    queueMicrotask(() => readyListeners.forEach((cb) => cb(ready)));
  }
  if (next.state === "ready" && prev !== "ready") {
    readyAt = Date.now();
    lastDiagAt = 0;
    armSettle();
    setView({ ...next, settled: false });
    syncAll();
    return;
  }
  if (next.state !== "ready" && next.state !== "indexing") {
    // 服务停了 / 在重启 / 出错：旧文档与诊断都作废
    clearTimeout(settleTimer);
    forgetDocs();
    clearMarkers();
    setView({ ...next, settled: false });
    return;
  }
  setView({ ...next, settled: prev === "ready" ? view.settled : false });
}

let started = false;

/** 应用启动后调用一次（幂等）：订阅后端事件、同步已有状态、挂上 model 生命周期。 */
export async function initLang(): Promise<void> {
  if (started) return;
  started = true;
  onModelLifecycle(
    (path, model) => {
      if (view.state === "ready" && inLangModule(path)) openDoc(path, model);
    },
    (path) => closeDoc(path),
  );
  await listen<LangStatus>("lang-status", onStatus);
  await listen<{ method: string; params: { uri: string; diagnostics: LspDiagnostic[] } }>(
    "lang-notify",
    (e) => {
      if (e.method === "textDocument/publishDiagnostics") onDiagnostics(e.params);
    },
  );
  await refreshLangStatus();
  void getConfig().then(applyLangPrefs).catch(() => {});
}

/**
 * 重新拉一次后端状态。
 *
 * `unknown` 只会在 `lang_status` 失败时出现：读不到不等于「已停止」，jdt.ls 可能仍在跑，
 * 所以保留上次状态并标记不确定，由状态栏显示「状态未知」并提供重试入口。
 * 拿到确定结论后必须把标记清掉，否则那条「不确定」会一直挂在状态栏上。
 */
export async function refreshLangStatus(): Promise<boolean> {
  try {
    const cur = await invoke<LangStatus>("lang_status");
    if (cur.state === "stopped") {
      // 后端明确说没在跑：这是确定结论，直接如实反映（并清掉上次的模块 / 报错残留）
      setView({ ...STOPPED, settled: false });
    } else {
      onStatus(cur);
    }
    return true;
  } catch (e) {
    setView({ ...view, unknown: true, message: friendlyError(e), settled: false });
    return false;
  }
}

// ───────────────────── 启动与请求 ─────────────────────

let startTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * lang_start / lang_stop 的串行队列。
 *
 * 为什么必须串行：切工作区是 `void stopLang()` 不等完成的，而防抖里的 start 可能
 * 紧跟着发出去；两条 IPC 到后端是两个独立的 spawn_blocking，先后没有任何保证。
 * 一旦撞上「launch 已记下旧 cancel_epoch、stop 随即把它加一」的时序，刚拉起的
 * jdt.ls 会在登记前被当作「停止意图已作废」杀掉——约 700MB 的进程白起一轮，
 * 状态栏还停在「正在建立索引」。排队之后，start 只在 stop 的后端处理彻底结束后
 * 才会发出去。
 *
 * 前一个任务失败也继续跑下一个：失败只影响调用方看到的 promise，不毒死队列。
 */
let langQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(job: () => Promise<T>): Promise<T> {
  const next = langQueue.then(job, job);
  langQueue = next.catch(() => {});
  return next;
}

/**
 * 启动意图的代际：`ensureLang` 调度防抖时记下当前代际，停服务 / 手动启动 / 重启
 * 都会自增它。启动任务真正**执行**前再核一次代际——它可能排在在途 stop 的后面
 * （后端杀 jdt.ls 要一两秒），这期间又停过一次（连续切工作区），说明目标模块
 * 已不属于任何当前工作区，必须放弃，否则会给旧路径白拉一个约 700MB 的进程。
 */
let intentGen = 0;

/** 记下一轮新的启动意图，作废之前排队的全部旧意图。 */
function freshIntent(): number {
  return (intentGen += 1);
}

/**
 * 打开 / 切到一个 .java 文件时调用：该文件所在模块还没有语言服务就拉起（切模块 = 重启）。
 * 同一模块上次失败过不自动重试，避免循环弹错；用户可以手动重启。
 */
export function ensureLang(path: string): void {
  if (!prefs.enabled || !prefs.autoStart) return;
  if (!path.toLowerCase().endsWith(".java")) return;
  const module = moduleOfPath(path);
  if (!module) return;
  if (view.module?.toLowerCase() === module.toLowerCase() && view.state !== "stopped") return;
  clearTimeout(startTimer);
  const gen = intentGen;
  startTimer = setTimeout(() => {
    void serialize(async () => {
      // 排队等到执行这一刻再核代际：这期间停过服务，目标模块就已经过期
      if (gen !== intentGen) return;
      await invoke("lang_start", { path }).catch(() => {
        // 失败原因已经由 lang-status(error) 事件带给状态栏
      });
    });
  }, START_DEBOUNCE_MS);
}

/** 「自动启动」关掉时，状态栏的「启动」按钮走这里：不防抖、不看自动开关。 */
export function startLangNow(path: string): void {
  const operation = beginOperation({ key: "language.control", label: "请求启动代码智能", scope: path, page: "files", path, phase: "等待旧请求结束并准备语言服务" });
  if (!operation) return;
  clearTimeout(startTimer);
  // 手动启动就是最新意图：防抖里排着的旧目标作废，免得同一模块连起两轮。
  const gen = freshIntent();
  void serialize(async () => {
    if (gen !== intentGen) { operation.finish("cancelled", "目标已变化，未启动旧模块"); return; }
    operation.update({ phase: "启动语言服务并完成握手" });
    await invoke("lang_start", { path });
    // lang_start 只完成拉起与握手，索引的 ServiceReady 是之后的后端事件。
    operation.finish(gen === intentGen ? "success" : "cancelled", gen === intentGen ? "启动请求已处理；索引是否就绪以状态栏为准" : "工程已变化，请查看当前代码智能状态");
  }).catch(error => operation.finish(gen !== intentGen || String(error instanceof Error ? error.message : error).startsWith("启动已取消") ? "cancelled" : "failed", String(error)));
}

/** 关掉语言服务（换工作区时调用：旧模块的影子工程对新工作区没有意义）。 */
export function stopLang(): Promise<void> {
  clearTimeout(startTimer);
  freshIntent();
  return serialize(() => invoke<void>("lang_stop").catch(() => {}));
}

/** 手动重启（状态栏点「重试」）。 */
export async function restartLang(path: string): Promise<void> {
  const operation = beginOperation({ key: "language.control", label: "请求重启代码智能", scope: path, page: "files", path, phase: "停止旧语言服务" });
  if (!operation) return;
  clearTimeout(startTimer);
  const gen = freshIntent();
  try {
    await serialize(() => invoke("lang_stop"));
    await serialize(async () => {
      // 停的途中又停过一次（比如接着切了工作区）：重启的目标也过期了。
      if (gen !== intentGen) { operation.finish("cancelled", "目标已变化，未重启旧模块"); return; }
      operation.update({ phase: "启动语言服务并完成握手" });
      await invoke("lang_start", { path });
      operation.finish(gen === intentGen ? "success" : "cancelled", gen === intentGen ? "重启请求已处理；索引是否就绪以状态栏为准" : "工程已变化，请查看当前代码智能状态");
    });
  } catch (error) {
    operation.finish(gen !== intentGen || String(error instanceof Error ? error.message : error).startsWith("启动已取消") ? "cancelled" : "failed", String(error));
    throw error;
  }
}

export function langRequest<T>(
  method: string,
  path: string | null,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<T> {
  return invoke<T>("lang_request", { method, path, params, timeoutMs });
}

// ───────────────────── jar 内类源码与跳转 ─────────────────────

const jdtText = new Map<string, Promise<JdtSource>>();
/** 已缓存正文的大小（UTF-16 字节估算）。只记已经拿到、确定留下的。 */
const jdtBytes = new Map<string, number>();
let jdtTotal = 0;
let jdtEpoch = workspaceEpoch();
/**
 * jar 内类正文缓存上限。反编译结果动辄几百 KB，一天点几百个类不淘汰会一直涨。
 * 按最近使用淘汰；淘汰只丢文本，再打开时重新问一次 jdt.ls，不影响已打开的标签（model 自己持有文本）。
 */
export const JDT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const JDT_CACHE_MAX_ENTRIES = 300;

function jdtForget(uri: string): void {
  jdtText.delete(uri);
  jdtTotal -= jdtBytes.get(uri) ?? 0;
  jdtBytes.delete(uri);
}

/** 记下一份留在缓存里的正文，并把它挂到最近使用的一端；超限就从最久没用的开始淘汰。 */
function jdtKeep(uri: string, p: Promise<JdtSource>, text: string): void {
  if (jdtText.get(uri) !== p) return; // 等待期间被 force / 换工作区替掉了
  if (text.length * 2 > JDT_CACHE_MAX_BYTES) {
    jdtForget(uri); // 单个超限正文仍可打开，但不应挤掉缓存或永久突破预算。
    return;
  }
  jdtTotal -= jdtBytes.get(uri) ?? 0;
  jdtText.delete(uri);
  jdtText.set(uri, p);
  jdtBytes.set(uri, text.length * 2);
  jdtTotal += text.length * 2;
  for (const old of jdtText.keys()) {
    if (jdtTotal <= JDT_CACHE_MAX_BYTES && jdtText.size <= JDT_CACHE_MAX_ENTRIES) break;
    if (old !== uri) jdtForget(old);
  }
}

/** 测试用：当前缓存条数与字节数。 */
export function jdtCacheStats(): { entries: number; bytes: number } {
  return { entries: jdtText.size, bytes: jdtTotal };
}

/** `loadJdtSource` 的产物：正文 + 它是不是反编译出来的。 */
export interface JdtSource {
  /** 给只读 model 用的正文：真源码 / CFR 反编译结果 / 签名桩。 */
  text: string;
  /** 这份正文是 CFR 反编译的，不是原始源码。 */
  decompiled: boolean;
  /** 反编译失败的原因（此时 `text` 仍是桩）。成功或本来就有源码时为空。 */
  decompileError?: string;
}

/**
 * 拿 `jdt://` 类的正文。三条路按代价从低到高：
 *
 * 1. 源码包地址（`*_src.jar`）→ 直读包内 `.java` 原文（带注释，不起 JVM）；
 * 2. 其余地址 → 先问 jdt.ls 的 source lookup，拿到桩再让后端用 CFR 反编译一次。
 *
 * 桩本身只有方法签名，点进去看不到实现——NC 的 jar 里只有 27.8% 带 `_src.jar`，
 * 现场补丁包更是几乎全裸，所以「桩 → 反编译」是常态路径而不是兜底。
 * 反编译失败不抛错：降级成桩，并把原因带回去由界面提示一次（见 `useFileSession`）。
 */
/** 本地类型索引给 jar 类合成的地址标记：见到它就不问语言服务，直接让后端反编译。 */
const DIRECT_DECOMPILE = "?=ncforge-decompile";

/** 直接走 CFR 反编译；失败抛友好错误（调用方提示后不激活标签）。 */
async function decompileOnly(uri: string): Promise<JdtSource> {
  try {
    const r = await decompileClass(uri);
    return { text: decompileHeader(r.jar) + r.source, decompiled: true };
  } catch (e) {
    throw new Error(friendlyError(e));
  }
}

/**
 * 源码包（`_src.jar`）里的 `.java` 直读通道。
 *
 * `_src.jar` 被 `is_runtime_archive` 有意排除在 classpath 外（源码不是字节码），
 * jdt.ls 与 CFR 的 jar 候选里都没有它，而包内全部 STORED——读出来就是带注释的
 * 原文，比反编译更真也更快（不起 JVM）。点开「jar 内注释」命中走这条直路。
 */
async function readSrcFile(uri: string): Promise<JdtSource> {
  return { text: await invoke<string>("read_src_file", { uri }), decompiled: false };
}

async function fetchJdtSource(uri: string): Promise<JdtSource> {
  if (uri.includes(DIRECT_DECOMPILE)) {
    // 合成地址带标记：不是 jdt.ls 认识的 URI，问它只会得到错误；直接走 CFR。
    return decompileOnly(uri);
  }
  // 🔴 源码包地址（jar 段是 `*_src.jar`）：先直读 .java 原文。读不到（组件卸载、
  // 条目缺失）再落通用链路，别让「点开注释」整个不可用。
  if (/_src\.jar\//i.test(uri)) {
    try {
      return await readSrcFile(uri);
    } catch {
      // 直读失败：下面照常问 jdt.ls / CFR
    }
  }
  // 不带标记（`preferSource`）：先问 jdt.ls 的 source lookup，它有源码
  // （与编译 jar 同名的 `_src.jar`）就直接给原文——**带注释**。
  // 🔴 合成 URI 万一不被 jdt.ls 认识，请求会 reject 而不是返回桩：必须退到 CFR，
  // 否则「打开 jar 里的类」整个不可用。CFR 也不成就把错抛出去，由界面提示
  // 「读不到」——比塞一份来路不明的假桩诚实。
  let text: string;
  try {
    text = await langRequest<string>("java/classFileContents", null, { uri }, 60_000);
  } catch {
    return decompileOnly(uri);
  }
  if (!isStubSource(text)) return { text, decompiled: false };
  try {
    const r = await decompileClass(uri);
    return { text: decompileHeader(r.jar) + r.source, decompiled: true };
  } catch (e) {
    return { text, decompiled: false, decompileError: friendlyError(e) };
  }
}

/**
 * 取 `jdt://` 类的源码（或反编译桩）并确保只读 model 存在。
 *
 * 缓存的只是**文本**，model 每次都在这里确保（`openVirtualModel` 幂等）：标签关掉时 model 会被销毁，
 * 若连 model 一起缓存，再次跳到同一个类就会命中缓存、不重建 model，编辑器显示空白。
 *
 * 只有「真拿到内容」的结果才留在缓存里：
 * - 请求本身失败 → 删掉，下次还能再试；
 * - 反编译失败退回签名桩 → 也删掉。桩没有信息量，而用户很可能马上去设置里下载
 *   CFR 组件；留着这份缓存会让「装好组件后还是只能看桩」变成必须重启才能摆脱的状态。
 *
 * `force` 给「标签已经是桩、用户又点了一次」用：明确要求重新问一次 jdt.ls + 反编译。
 *
 * `peek` 给「只是预览」的调用方（provideDefinition 为每个跳转目标预建 model）：
 * 这些 model 走预览队列，超上限按最近使用淘汰，peek 未必成标签页，不能无限攒。
 * 默认正式身份：转正已存在的预览 model（摘牌），之后随标签页关闭而销毁。
 */
export async function loadJdtSource(
  uri: string,
  peek = false,
  force = false,
): Promise<JdtSource> {
  const epoch=workspaceEpoch();
  if (peek) {
    // 预览是给「跳转前先看一眼」用的，多数候选不会被真正打开。反编译要起一次 JVM
    // （实测 0.6 s），为一个可能不打开的候选付这个代价不值得——而且 provideDefinition
    // 一次可能预建好几个目标，并发起 JVM 更糟。
    // 所以预览只拿 jdt.ls 的原样内容（有源码就是源码，没有就是桩）；真正打开时
    // 走下面那条路，用 `replace` 把桩换成反编译结果。
    const text = await langRequest<string>("java/classFileContents", null, { uri }, 60_000);
    if(epoch===workspaceEpoch()) openVirtualModel(uri, text, { peek: true });
    return { text, decompiled: false };
  }
  // 换了工作区：同一个 jdt:// 在新工程里可能指向别的 jar，旧文本整体作废
  if (epoch !== jdtEpoch) {
    jdtText.clear();
    jdtBytes.clear();
    jdtTotal = 0;
    jdtEpoch = epoch;
  }
  if (force) jdtForget(uri);
  let p = jdtText.get(uri);
  if (!p) {
    p = fetchJdtSource(uri);
    jdtText.set(uri, p);
  }
  let src: JdtSource;
  try {
    src = await p;
  } catch (e) {
    if (jdtText.get(uri) === p) jdtForget(uri);
    throw e;
  }
  if (src.decompileError) {
    if (jdtText.get(uri) === p) jdtForget(uri);
  } else jdtKeep(uri, p, src.text);
  // `replace`：预览可能已经用桩建过 model，这里要把内容换成完整版
  if(epoch===workspaceEpoch()) openVirtualModel(uri, src.text, { replace: true });
  return src;
}

export type NavTarget =
  | { kind: "file"; path: string; line: number; column: number }
  | { kind: "jdt"; uri: string; line: number; column: number };

let navHandler: ((t: NavTarget) => void) | null = null;

/** 文件页挂载时登记「怎么打开一个跳转目标」；卸载时传 null。 */
export function setNavHandler(h: ((t: NavTarget) => void) | null): void {
  navHandler = h;
}

export function navigate(t: NavTarget): void {
  navHandler?.(t);
}
