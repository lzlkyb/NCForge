// 调用层级（Call Hierarchy）：光标所在的方法被谁调用、它又调用了谁。
//
// jdt.ls 0.57 自带 `CallHierarchyHandler`（本机 jar 里核实过 `prepareCallHierarchy`
// 与 incoming/outgoing），客户端只要在 initialize 里声明 capabilities，它就会注册。
// 这里负责「准备 → 取两层 → 存快照」，渲染在底部面板的「调用层级」标签里。
//
// 只取一层（incoming / outgoing 各一次）：NC 里调用链动辄七八层，一次全展开
// 既慢又没人看得完。想看更深就点那一行再发起一次。
import { useSyncExternalStore } from "react";
import { currentModel, cursorAt } from "./editorActions";
import { beginOperation } from "./operations";
import { context } from "./langProviders";
import { uriToPath } from "./langConvert";
import { langReady, langRequest, navigate } from "./lang";
import { setSession } from "./workspaceSession";
import { toast } from "../components/ui/toast";

export interface CallItem {
  name: string;
  detail: string;
  /** 真实文件路径；jar 内的类为 null（走 jdt:// 打开）。 */
  path: string | null;
  uri: string;
  line: number;
  column: number;
}

export interface CallState {
  /** 正在查看的符号；null = 还没发起过。 */
  root: CallItem | null;
  incoming: CallItem[];
  outgoing: CallItem[];
  loading: boolean;
  error: string | null;
}

const EMPTY: CallState = { root: null, incoming: [], outgoing: [], loading: false, error: null };
let state: CallState = EMPTY;
let seq = 0;
const listeners = new Set<() => void>();

function set(next: Partial<CallState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function getCallState(): CallState {
  return state;
}

export function useCallState(): CallState {
  return useSyncExternalStore(subscribe, getCallState, getCallState);
}

export function clearCallHierarchy(): void {
  seq += 1;
  state = EMPTY;
  listeners.forEach((l) => l());
}

interface LspCallItem {
  name?: string;
  detail?: string;
  uri?: string;
  range?: { start?: { line: number; character: number } };
  selectionRange?: { start?: { line: number; character: number } };
}

function toItem(raw: LspCallItem): CallItem | null {
  if (!raw?.name || !raw.uri) return null;
  const pos = raw.selectionRange?.start ?? raw.range?.start;
  if (!pos) return null;
  return {
    name: raw.name,
    detail: raw.detail ?? "",
    path: uriToPath(raw.uri),
    uri: raw.uri,
    line: pos.line + 1,
    column: pos.character + 1,
  };
}

/**
 * 打开光标处的调用层级。
 *
 * 三步请求：`prepare` 拿符号本身，再分别要 incoming / outgoing。
 * 任何一步没有结果都不是错误（可能光标在字段上、或方法没有调用者）。
 */
export async function openCallHierarchy(): Promise<void> {
  const model = currentModel();
  const pos = cursorAt();
  if (!model || !pos) {
    toast("先把光标放到方法名上再查调用层级", "info");
    return;
  }
  if (!langReady()) {
    toast("代码智能未就绪，调用层级需要它（设置 → 开发环境里启动）", "warning");
    return;
  }
  const operation = beginOperation({ key: "language.calls", label: "查询调用层级", page: "files", phase: "准备方法与调用关系" });
  if (!operation) return;
  const my = ++seq;
  try {
    const ctx = await context(model, { lineNumber: pos.line, column: pos.column });
    if (!ctx) {
      toast("当前文件不在可分析的模块里", "warning");
      return;
    }
    set({ loading: true, error: null, incoming: [], outgoing: [] });
    const prepared = await langRequest<LspCallItem[] | LspCallItem | null>("textDocument/prepareCallHierarchy", ctx.path, { position: ctx.position });
    if (my !== seq) return;
    const list = Array.isArray(prepared) ? prepared : prepared ? [prepared] : [];
    const root = list.length ? toItem(list[0]) : null;
    if (!root) {
      set({ loading: false, error: "光标所在位置不是一个可分析的方法 / 构造器" });
      return;
    }
    // incoming / outgoing 的 item 必须是服务端给的原对象（带 data 字段），
    // 用我们自己转出来的结构发回去会被拒——所以保留原始对象
    const rawItem = Array.isArray(prepared) ? prepared[0] : prepared;
    const [incoming, outgoing] = await Promise.all([
      langRequest<{ from?: LspCallItem }[] | null>("callHierarchy/incomingCalls", ctx.path, { item: rawItem }, 20_000),
      langRequest<{ to?: LspCallItem }[] | null>("callHierarchy/outgoingCalls", ctx.path, { item: rawItem }, 20_000),
    ]);
    if (my !== seq) return;
    if (model.isDisposed()) { set({ loading: false, error: "文件已关闭或工程已切换，请重新查询" }); return; }
    operation.finish("success", `调用者 ${incoming?.length ?? 0} 个、调用目标 ${outgoing?.length ?? 0} 个`);
    set({
      root,
      incoming: (incoming ?? []).map((c) => toItem(c.from ?? {})).filter((x): x is CallItem => !!x),
      outgoing: (outgoing ?? []).map((c) => toItem(c.to ?? {})).filter((x): x is CallItem => !!x),
      loading: false,
      error: null,
    });
  } catch (e) {
    operation.finish("failed", String(e));
    if (my !== seq) return;
    set({ loading: false, error: String(e) });
  } finally { operation.finish("cancelled", "此位置没有可分析的方法，请根据提示重新执行"); }
}

/** 点一行跳到那个调用点（jar 内的类走只读标签）。 */
export function openCallItem(it: CallItem): void {
  if (it.path) navigate({ kind: "file", path: it.path, line: it.line, column: it.column });
  else navigate({ kind: "jdt", uri: it.uri, line: it.line, column: it.column });
}

/**
 * 命令 / 快捷键入口：先把底部面板切到「调用层级」再查。
 *
 * 顺序不能反——查询要 1~2 秒，先切面板用户能立刻看到「正在查询…」，
 * 否则按了键像没反应。
 */
export async function runCallHierarchy(): Promise<void> {
  setSession({ panelOpen: true, panelTab: "calls" });
  await openCallHierarchy();
}
