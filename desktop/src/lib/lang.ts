// 代码智能（jdt.ls）的前端侧：状态仓库、事件订阅、文档同步、诊断展示、自动启动。
//
// 模块级单例：文件页切走会卸载组件，但 jdt.ls 进程与已打开的文档不能跟着丢。
// 后端只认真实文件路径（影子工程的 URI 映射在 Rust 侧完成），这里永远不碰 URI。
import { useSyncExternalStore } from "react";
import { forEachModel, onModelLifecycle, openVirtualModel } from "./editorStore";
import { severityName, toMonacoRange, uriToPath, type LspRange } from "./langConvert";
import { monaco } from "./monacoSetup";
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
  timer: ReturnType<typeof setTimeout> | undefined;
  sub: { dispose(): void };
}

const docs = new Map<string, Doc>();

function notify(method: string, path: string, params: Record<string, unknown>): Promise<void> {
  return invoke<unknown>("lang_notify", { method, path, params })
    .then(() => undefined)
    .catch(() => undefined);
}

function openDoc(path: string, model: Model): void {
  if (docs.has(path)) return;
  const doc: Doc = {
    model,
    version: 1,
    timer: undefined,
    sub: model.onDidChangeContent(() => {
      doc.version += 1;
      clearTimeout(doc.timer);
      doc.timer = setTimeout(() => void flushDoc(path), CHANGE_DEBOUNCE_MS);
    }),
  };
  docs.set(path, doc);
  void notify("textDocument/didOpen", path, {
    textDocument: { languageId: "java", version: 1, text: model.getValue() },
  });
}

function closeDoc(path: string): void {
  const doc = docs.get(path);
  if (!doc) return;
  clearTimeout(doc.timer);
  doc.sub.dispose();
  docs.delete(path);
  if (view.state === "ready") void notify("textDocument/didClose", path, { textDocument: {} });
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
  if (!doc || doc.timer === undefined) return;
  clearTimeout(doc.timer);
  doc.timer = undefined;
  await notify("textDocument/didChange", path, {
    textDocument: { version: doc.version },
    contentChanges: [{ text: doc.model.getValue() }],
  });
}

/** 服务端已不在：只丢本地记录，不再给它发 didClose。 */
function forgetDocs(): void {
  docs.forEach((d) => {
    clearTimeout(d.timer);
    d.sub.dispose();
  });
  docs.clear();
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
  monaco.editor.removeAllMarkers(MARKER_OWNER);
}

function onDiagnostics(params: { uri: string; diagnostics: LspDiagnostic[] }): void {
  const path = uriToPath(params.uri);
  if (!path) return;
  const key = path.toLowerCase();
  lastDiagAt = Date.now();
  latestDiags.set(key, params.diagnostics ?? []);
  if (view.settled) applyMarkers(key);
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
      return;
    }
    settleTimer = setTimeout(tick, SETTLE_POLL_MS);
  };
  settleTimer = setTimeout(tick, SETTLE_POLL_MS);
}

function onStatus(next: LangStatus): void {
  const prev = view.state;
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
  const cur = await invoke<LangStatus>("lang_status").catch(() => STOPPED);
  if (cur.state !== "stopped") onStatus(cur);
  void getConfig().then(applyLangPrefs).catch(() => {});
}

// ───────────────────── 启动与请求 ─────────────────────

let startTimer: ReturnType<typeof setTimeout> | undefined;

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
  startTimer = setTimeout(() => {
    void invoke("lang_start", { path }).catch(() => {
      // 失败原因已经由 lang-status(error) 事件带给状态栏
    });
  }, START_DEBOUNCE_MS);
}

/** 「自动启动」关掉时，状态栏的「启动」按钮走这里：不防抖、不看自动开关。 */
export function startLangNow(path: string): void {
  void invoke("lang_start", { path }).catch(() => {});
}

/** 关掉语言服务（换工作区时调用：旧模块的影子工程对新工作区没有意义）。 */
export function stopLang(): Promise<void> {
  clearTimeout(startTimer);
  return invoke<void>("lang_stop").catch(() => {});
}

/** 手动重启（状态栏点「重试」）。 */
export async function restartLang(path: string): Promise<void> {
  await invoke("lang_stop");
  await invoke("lang_start", { path });
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

const jdtText = new Map<string, Promise<string>>();

/**
 * 取 `jdt://` 类的源码（或反编译桩）并确保只读 model 存在。
 *
 * 缓存的只是**文本**，model 每次都在这里确保（`openVirtualModel` 幂等）：标签关掉时 model 会被销毁，
 * 若连 model 一起缓存，再次跳到同一个类就会命中缓存、不重建 model，编辑器显示空白。
 */
export async function loadJdtSource(uri: string): Promise<string> {
  let p = jdtText.get(uri);
  if (!p) {
    p = langRequest<string>("java/classFileContents", null, { uri }, 60_000);
    jdtText.set(uri, p);
    // 失败不缓存，下次还能再试
    p.catch(() => jdtText.delete(uri));
  }
  const text = await p;
  openVirtualModel(uri, text);
  return text;
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
