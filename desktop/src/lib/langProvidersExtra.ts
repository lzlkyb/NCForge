// jdt.ls 的「后半截」能力：找引用、格式化、快速修复、跳实现、跳父类。
//
// 为什么不写进 langProviders.ts：那边已经在管补全 / 悬停 / 签名 / 跳定义四件事，
// 再塞五个 provider 就谁都不敢改了。这里只做「LSP 返回 → Monaco 类型」的翻译，
// 上下文与请求复用 `langProviders` 导出的 `context` / `ask`（`flushDoc` 的先后顺序在那里）。
//
// 注册完这些 provider，Monaco 的内置右键菜单与命令面板会自动多出
// 「Go to References」「Format Document」「Quick Fix」「Go to Implementation」等项——
// 不用再自己 addAction 造一遍，否则右键里会出现中英两条同义项。
import { monaco } from "./monacoSetup";
import { ask, context } from "./langProviders";
import { toLspPosition, toMonacoRange, toTargets, type LspRange } from "./langConvert";
import { toast } from "../components/ui/toast";

/**
 * 引用结果的条数上限。
 *
 * NC 里一个 `getBillType()` 全工作区能有上千处引用，全塞给 Monaco 的 peek 会白卡好几秒，
 * 而且人根本看不完。超了就截断并在标题里说清楚，让人自己缩小范围（比如先找类再找方法）。
 */
const MAX_REFERENCES = 400;

let registered = false;

/** 截断提示的节流：同一次排查会反复点「找引用」，不该每次都弹。 */
let lastTruncateNote = 0;

function notifyTruncated(total: number): void {
  const now = Date.now();
  if (now - lastTruncateNote < 60_000) return;
  lastTruncateNote = now;
  toast(`引用太多（${total} 处），只显示前 ${MAX_REFERENCES} 处。先定位到具体的类或方法再找，范围会小很多`, "info");
}

interface LspTextEdit {
  range: LspRange;
  newText: string;
}

interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: { textDocument: { uri: string }; edits: LspTextEdit[] }[];
}

interface LspCodeAction {
  title?: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: LspWorkspaceEdit;
  command?: { title?: string; command?: string; arguments?: unknown[] };
}

/**
 * LSP 的 WorkspaceEdit → Monaco 的 WorkspaceEdit。
 *
 * 两种形态都要认：`changes`（按 uri 分组）与 `documentChanges`（带版本号的有序编辑）。
 * jdt.ls 的的 quick fix 一般给 `changes`，但 `documentChanges` 在不支持版本号的客户端上也会出现。
 */
function toMonacoEdit(edit: LspWorkspaceEdit | undefined): monaco.languages.WorkspaceEdit | undefined {
  if (!edit) return undefined;
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  const push = (uri: string, list: LspTextEdit[]) => {
    for (const e of list) {
      edits.push({
        resource: monaco.Uri.parse(uri),
        textEdit: { range: toMonacoRange(e.range), text: e.newText },
        versionId: undefined,
      });
    }
  };
  for (const [uri, list] of Object.entries(edit.changes ?? {})) push(uri, list);
  for (const d of edit.documentChanges ?? []) push(d.textDocument.uri, d.edits);
  return edits.length ? { edits } : undefined;
}

/** 位置列表（definition / implementation / typeDefinition / references 同形）→ Monaco Location。 */
function toLocations(result: unknown): monaco.languages.Location[] {
  return toTargets(result)
    .slice(0, MAX_REFERENCES)
    .map((t) => ({ uri: monaco.Uri.parse(t.uri), range: toMonacoRange(t.range) }));
}

/** 注册一次，重复调用直接返回。`EditorPane` 卸载重建时不能重复注册（会叠出多份 provider）。 */
export function registerExtraLangProviders(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerReferenceProvider("java", {
    provideReferences: async (model, position) => {
      const ctx = await context(model, position);
      if (!ctx) return null;
      const res = await ask<unknown>("textDocument/references", ctx, {
        context: { includeDeclaration: true },
      });
      if (!res) return null;
      const all = Array.isArray(res) ? res.length : 0;
      const out = toLocations(res);
      // 截断必须说出来：静默少给几条，用户会以为某个调用点「没有被算进来」，比慢更糟
      if (all > MAX_REFERENCES) notifyTruncated(all);
      return out;
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider("java", {
    provideDocumentFormattingEdits: async (model, options) => {
      const ctx = await context(model, { lineNumber: 1, column: 1 });
      if (!ctx) return null;
      const res = await ask<LspTextEdit[]>("textDocument/formatting", ctx, {
        options: {
          tabSize: options.tabSize,
          insertSpaces: options.insertSpaces,
        },
      });
      if (!res) return null;
      return res.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
    },
  });

  monaco.languages.registerCodeActionProvider("java", {
    provideCodeActions: async (model, range) => {
      const pos = { lineNumber: range.startLineNumber, column: range.startColumn };
      const ctx = await context(model, pos);
      if (!ctx) return null;
      const res = await ask<LspCodeAction[]>("textDocument/codeAction", ctx, {
        range: {
          start: toLspPosition(range.startLineNumber, range.startColumn),
          end: toLspPosition(range.endLineNumber, range.endColumn),
        },
        // 不传诊断：jdt.ls 的 quick fix 主要按 range 反查它自己那份诊断，
        // 传一份可能过期的诊断列表反而会把修复过滤掉。
        context: { diagnostics: [] },
      });
      if (!res?.length) return null;
      const out: monaco.languages.CodeAction[] = [];
      for (const a of res) {
        if (!a.title) continue;
        out.push({
          title: a.title,
          kind: a.kind,
          isPreferred: a.isPreferred,
          edit: toMonacoEdit(a.edit),
          // 带 command 的动作（如 organize imports）jdt.ls 会在 command.command 里给命令名，
          // Monaco 只负责发回给语言服务，这里原样包一层。
          command: a.command
            ? { id: a.command.command ?? "", title: a.command.title ?? a.title, arguments: a.command.arguments }
            : undefined,
        });
      }
      // 新版 Monaco 要求返回 CodeActionList（带 dispose），直接返回数组会报类型错
      return out.length ? { actions: out, dispose: () => {} } : null;
    },
  });

  monaco.languages.registerImplementationProvider("java", {
    provideImplementation: async (model, position) => {
      const ctx = await context(model, position);
      if (!ctx) return null;
      const res = await ask<unknown>("textDocument/implementation", ctx);
      return res ? toLocations(res) : null;
    },
  });

  monaco.languages.registerTypeDefinitionProvider("java", {
    provideTypeDefinition: async (model, position) => {
      const ctx = await context(model, position);
      if (!ctx) return null;
      const res = await ask<unknown>("textDocument/typeDefinition", ctx);
      return res ? toLocations(res) : null;
    },
  });
}
