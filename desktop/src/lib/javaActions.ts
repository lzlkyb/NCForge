// jdt.ls 的「源代码动作」：组织导入、生成 override / implement。
//
// 与 quick fix 的区别：这些是**整文件**级的动作（range 覆盖全文），而且多数以
// `CodeAction` 或 `Command` 的形式返回。红线不变：jdt.ls 不写用户文件，
// 返回的 WorkspaceEdit 只落到编辑器 model，保存仍由用户按 Ctrl+S。
//
// 客户端没有声明 `workspace.applyEdit`（见 lsp.rs 的 build_initialize_params），
// 所以服务端不会自己动手——这正是我们要的。
import { beginOperation } from "./operations";
import { pathOfModel } from "./editorStore";
import { monaco } from "./monacoSetup";
import { ask, context } from "./langProviders";
import { toMonacoRange, normUri, type LspRange } from "./langConvert";
import { langReady, langRequest } from "./lang";
import { currentModel } from "./editorActions";
import { toast } from "../components/ui/toast";

interface LspEdit {
  range: LspRange;
  newText: string;
}

export interface WorkspaceEditLike {
  changes?: Record<string, LspEdit[]>;
  documentChanges?: { textDocument: { uri: string }; edits: LspEdit[] }[];
}

export interface JavaSourceAction {
  title: string;
  kind: string;
  edit?: WorkspaceEditLike;
  command?: { title?: string; command?: string; arguments?: unknown[] };
}

type Model = ReturnType<typeof monaco.editor.createModel>;

export const KINDS = {
  organizeImports: ["source.organizeImports"],
  override: ["source.overrideMethods"],
  implement: ["source.implementMethods"],
} as const;

/**
 * 请求一批源代码动作。
 *
 * `range` 必须覆盖整篇：jdt.ls 按 range 找「这一行能做什么」，给一个点只会返回
 * 光标处的 quick fix，source action 一条都不会出现。
 */
export async function sourceActions(
  model: Model,
  only: readonly string[],
  timeoutMs = 20_000,
): Promise<JavaSourceAction[]> {
  if (!langReady()) return [];
  const ctx = await context(model, { lineNumber: 1, column: 1 });
  if (!ctx) return [];
  const last = model.getLineCount();
  const res = await ask<JavaSourceAction[]>("textDocument/codeAction", ctx, {
    range: {
      start: { line: 0, character: 0 },
      end: { line: last - 1, character: model.getLineMaxColumn(last) - 1 },
    },
    context: { diagnostics: [], only: [...only] },
  }, timeoutMs);
  if (!Array.isArray(res)) return [];
  return res.filter((a) => !!a && (!!a.title || !!a.command));
}

/**
 * 把 WorkspaceEdit 落到编辑器 model 上（只动当前文件）。
 *
 * 其它文件的编辑一律丢弃并返回一个提示：本项目不替用户代写文件，
 * 跨文件改动宁可让用户自己去做，也不能悄悄落盘。
 */
function applyEdit(model: Model, edit: WorkspaceEditLike): { applied: number; skipped: number } {
  const uri = model.uri.toString();
  const edits: { range: LspRange; newText: string }[] = [];
  for (const [key, list] of Object.entries(edit.changes ?? {})) {
    if (normUri(key) !== normUri(uri)) continue;
    edits.push(...list);
  }
  for (const d of edit.documentChanges ?? []) {
    if (normUri(d.textDocument.uri) !== normUri(uri)) continue;
    edits.push(...d.edits);
  }
  const total = Object.values(edit.changes ?? {}).reduce((n, l) => n + l.length, 0)
    + (edit.documentChanges ?? []).reduce((n, d) => n + d.edits.length, 0);
  if (edits.length === 0) return { applied: 0, skipped: total };
  const ops = edits
    .map((e) => ({ range: toMonacoRange(e.range), text: e.newText }))
    .sort((a, b) => a.range.startLineNumber - b.range.startLineNumber || a.range.startColumn - b.range.startColumn);
  model.pushEditOperations([], ops, () => null);
  return { applied: edits.length, skipped: total - edits.length };
}

/**
 * 执行一个源代码动作。
 *
 * 两条路都要走：新版 jdt.ls 直接把 WorkspaceEdit 放在 `edit` 里；
 * 0.57 的某些动作是 `command`，真正结果在 `workspace/executeCommand` 的返回值里。
 */
export async function applySourceAction(
  model: Model,
  action: JavaSourceAction,
): Promise<{ applied: number; skipped: number } | null> {
  if (action.edit) return applyEdit(model, action.edit);
  const cmd = action.command?.command;
  if (!cmd) return null;
  const version = model.getVersionId();
  try {
    const res = await langRequest<WorkspaceEditLike | null>(
      "workspace/executeCommand",
      null,
      { command: cmd, arguments: action.command?.arguments ?? [] },
      30_000,
    );
    if (!res || typeof res !== "object" || model.isDisposed() || model.getVersionId() !== version) return null;
    return applyEdit(model, res);
  } catch {
    return null;
  }
}

/** 组织导入：不需要用户选择，返回改了几处。 */
export async function organizeImports(model: Model): Promise<number | null> {
  const version = model.getVersionId();
  const actions = await sourceActions(model, KINDS.organizeImports);
  // 整理过程中继续输入会使返回编辑的位置过期，禁止把旧坐标落入新文本。
  if (model.isDisposed() || model.getVersionId() !== version) throw new Error("整理导入期间文件已修改，请重新执行");
  // 排序动作在前（`isPreferred` 我们不解析，按标题兜底）：标题里通常带「组织导入」/「Organize Imports」
  const picked = actions[0];
  if (!picked) return null;
  const r = await applySourceAction(model, picked);
  return r ? r.applied : null;
}

/**
 * 命令 / 快捷键入口：自己取当前 model、自己给反馈。
 *
 * 放在 lib 而不是页面里，是因为命令面板、`Ctrl+Alt+O`、右键三条路都要用同一份，
 * 页面里各写一遍必然出现「一条报了成功、一条静默」。
 */
export async function organizeImportsCommand(): Promise<void> {
  const model = currentModel();
  if (!model) {
    toast("先把光标放到编辑器里再执行", "info");
    return;
  }
  const path = pathOfModel(model) ?? undefined;
  const operation = beginOperation({ key: `imports:${path ?? model.uri.toString()}`, label: "整理导入", scope: path, path, page: "files", phase: "分析导入并计算编辑" });
  if (!operation) return;
  try {
    const n = await organizeImports(model);
    if (n === null) {
      toast("代码智能没有返回「组织导入」动作（服务未就绪，或本文件不在模块里）", "warning");
      return;
    }
    operation.finish("success", n === 0 ? "导入已经是干净的" : `已整理 ${n} 处导入；尚未保存`);
    toast(n === 0 ? "导入已经是干净的" : `已整理 ${n} 处导入（未保存，Ctrl+S 落盘）`, "success");
  } catch (e) {
    operation.finish("failed", String(e));
    toast(`整理导入失败：${e}`, "error");
  } finally { operation.finish("cancelled", "代码智能未返回可应用的动作，请根据提示重新执行"); }
}
