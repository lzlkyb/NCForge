// 类型层级：光标所在类型的父类型 / 子类型。
//
// jdt.ls 0.57 没有 LSP 的 TypeHierarchy，走的是我们自己的扩展 bundle
// （`src-tauri/jdtls-ext`）注册的 `ncforge.typeHierarchy` 命令，通道是
// `workspace/executeCommand`。参数里 uri 留空：后端 `prepare` 会按真实路径算出
// 影子工程的 URI，结果再经 `from_server` 换回真实路径——前端永远不碰 URI 映射。
import { useSyncExternalStore } from "react";
import { currentModel, cursorAt } from "./editorActions";
import { context } from "./langProviders";
import { uriToPath } from "./langConvert";
import { langReady, langRequest, navigate } from "./lang";
import { getKeymap, prettyChord } from "./keymap";
import { getBindingOverride } from "./keybindings";
import { setSession } from "./workspaceSession";
import { toast } from "../components/ui/toast";

export const TYPE_HIERARCHY_COMMAND = "ncforge.typeHierarchy";

export type TypeKind = "class" | "interface" | "enum" | "annotation";

export interface TypeEntry {
  name: string;
  qualifiedName: string;
  kind: TypeKind;
  abstract: boolean;
  /** 距离根类型几层（0 = 根）。父/子列表按它缩进。 */
  depth: number;
  /** 是否直接继承 / 实现根类型。 */
  direct: boolean;
  /** jar 内类型可能没有源码位置，此时为 null。 */
  uri: string | null;
  path: string | null;
  line: number;
  column: number;
}

export interface TypeState {
  root: TypeEntry | null;
  supertypes: TypeEntry[];
  subtypes: TypeEntry[];
  loading: boolean;
  error: string | null;
}

const EMPTY: TypeState = { root: null, supertypes: [], subtypes: [], loading: false, error: null };
let state: TypeState = EMPTY;
const listeners = new Set<() => void>();
/** 查询代际：连按两次时只让最后一次的结果落地。 */
let seq = 0;

function set(next: Partial<TypeState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function getTypeState(): TypeState {
  return state;
}

export function useTypeState(): TypeState {
  return useSyncExternalStore(subscribe, getTypeState, getTypeState);
}

/** 扩展 bundle 返回的条目（字段都可能缺省：二进制类型没有 location）。 */
export interface LspTypeEntry {
  name?: string;
  qualifiedName?: string;
  kind?: string;
  abstract?: boolean;
  depth?: number;
  direct?: boolean;
  location?: { uri?: string; range?: { start?: { line: number; character: number } } } | null;
}

export interface LspTypeHierarchy {
  type?: LspTypeEntry | null;
  supertypes?: LspTypeEntry[] | null;
  subtypes?: LspTypeEntry[] | null;
}

function kindOf(raw: string | undefined): TypeKind {
  return raw === "interface" || raw === "enum" || raw === "annotation" ? raw : "class";
}

export function toTypeEntry(raw: LspTypeEntry | null | undefined): TypeEntry | null {
  if (!raw?.name) return null;
  const uri = raw.location?.uri ?? null;
  const pos = raw.location?.range?.start;
  return {
    name: raw.name,
    qualifiedName: raw.qualifiedName ?? raw.name,
    kind: kindOf(raw.kind),
    abstract: raw.abstract === true,
    depth: typeof raw.depth === "number" && raw.depth >= 0 ? raw.depth : 0,
    direct: raw.direct === true,
    uri,
    path: uri ? uriToPath(uri) : null,
    line: (pos?.line ?? 0) + 1,
    column: (pos?.character ?? 0) + 1,
  };
}

function entries(list: LspTypeEntry[] | null | undefined): TypeEntry[] {
  return (list ?? []).map(toTypeEntry).filter((x): x is TypeEntry => !!x);
}

/** 面板与命令标题里的入口键：IDEA 用 Ctrl+H，Eclipse 用 Ctrl+T（Ctrl+H 在那里是搜索）。 */
export function typeHierarchyKey(keymap = getKeymap()): string {
  const custom = getBindingOverride("hierarchy.type");
  if (custom) return prettyChord(custom);
  return keymap === "idea" ? "Ctrl+H" : "Ctrl+T";
}

export function kindLabel(kind: TypeKind): string {
  return kind === "interface" ? "接口" : kind === "enum" ? "枚举" : kind === "annotation" ? "注解" : "类";
}

/**
 * 服务端没装上扩展 bundle 时的报错对用户没有意义（英文 + 内部命令名），换成人话。
 */
export function explainTypeHierarchyError(raw: string): string {
  if (/No delegateCommandHandler/i.test(raw)) {
    return "当前语言服务没有装上类型层级组件（jdtls-ext）。重启代码智能试试；仍不行说明安装包缺 resources/jdtls-ext。";
  }
  if (/代码智能未运行|not running/i.test(raw)) return "代码智能没有运行（设置 → 开发环境里启动，或打开一个 Java 文件）";
  return raw;
}

/** 光标处查类型层级。不是类型 / 服务没就绪时只提示，不改动已有结果。 */
export async function openTypeHierarchy(): Promise<void> {
  const model = currentModel();
  const pos = cursorAt();
  if (!model || !pos) {
    toast("先把光标放到类名上再查类型层级", "info");
    return;
  }
  if (!langReady()) {
    toast("代码智能未就绪，类型层级需要它（设置 → 开发环境里启动）", "warning");
    return;
  }
  const ctx = await context(model, { lineNumber: pos.line, column: pos.column });
  if (!ctx) {
    toast("当前文件不在可分析的模块里", "warning");
    return;
  }
  const my = ++seq;
  set({ loading: true, error: null });
  try {
    const res = await langRequest<LspTypeHierarchy | null>(
      "workspace/executeCommand",
      ctx.path,
      {
        command: TYPE_HIERARCHY_COMMAND,
        arguments: [
          { uri: "", line: ctx.position.line, character: ctx.position.character }
        ],
      },
      60_000,
    );
    if (my !== seq) return;
    const root = toTypeEntry(res?.type);
    if (!root) {
      set({ root: null, supertypes: [], subtypes: [], loading: false, error: "光标所在位置不是一个类型（类 / 接口 / 枚举）" });
      return;
    }
    set({
      root,
      supertypes: entries(res?.supertypes),
      subtypes: entries(res?.subtypes),
      loading: false,
      error: null,
    });
  } catch (e) {
    if (my !== seq) return;
    const msg = explainTypeHierarchyError(String(e));
    set({ loading: false, error: msg });
    toast(msg, "warning");
  }
}

/** 点一行：有源码就跳过去；jar 内类型走只读标签；没位置的（如 java.lang.Object）不动。 */
export function openTypeEntry(it: TypeEntry): void {
  if (it.path) navigate({ kind: "file", path: it.path, line: it.line, column: it.column });
  else if (it.uri) navigate({ kind: "jdt", uri: it.uri, line: it.line, column: it.column });
}

/**
 * 命令 / 快捷键入口：先切到「类型层级」页签再查。
 *
 * 顺序不能反——查询要一两秒，先切面板用户能立刻看到「正在查询…」，
 * 否则按了键像没反应（与调用层级同一处理）。
 */
export async function runTypeHierarchy(): Promise<void> {
  setSession({ panelOpen: true, panelTab: "types" });
  await openTypeHierarchy();
}
