// 提取类重构：方法 / 局部变量 / 字段 / 常量。
//
// 通道不是 `workspace/executeCommand`，而是 jdt.ls 的自定义 LSP 请求
// `java/getRefactorEdit`（插件包里 `@JsonSegment("java")` + `@JsonRequest("getRefactorEdit")`）。
// 发错通道的报错是「No delegateCommandHandler for java/getRefactorEdit」，
// 很容易被当成「这个版本不支持重构」。
//
// 红线同代码动作：返回的 WorkspaceEdit 只落到编辑器 model，绝不替用户写文件，
// 保存仍由 Ctrl+S。跨文件的编辑一律不应用——提取只改当前编译单元，出现别的文件
// 说明清单和我们对不上，半改比不改更糟。
import { beginOperation } from "./operations";
import { monaco } from "./monacoSetup";
import { bindEditorCommand } from "./editorCommandBinding";
import { context } from "./langProviders";
import { langRequest } from "./lang";
import { pathOfModel } from "./editorStore";
import { currentSelection, selectInEditor } from "./editorActions";
import { getEditorPrefs } from "./editorPrefs";
import { applyLspEdits, groupEdits, type LspTextEdit } from "./renameEdits";
import { toLspPosition, toMonacoRange } from "./langConvert";
import { REFACTOR_KINDS, newNameSpan, refactorParams, type RefactorKind, type RefactorResponse } from "./refactorPlan";
import { toast } from "../components/ui/toast";

type Model = ReturnType<typeof monaco.editor.createModel>;

/** 把校验过的编辑落到 model 上（进撤销栈；只有当前文件）。 */
function applyEdits(model: Model, edits: LspTextEdit[]): void {
  const ops = edits
    .map((e) => ({ range: toMonacoRange(e.range), text: e.newText }))
    .sort(
      (a, b) =>
        a.range.startLineNumber - b.range.startLineNumber || a.range.startColumn - b.range.startColumn,
    );
  model.pushEditOperations([], ops, () => null);
}

/** 命令面板 / 快捷键入口：取当前选区、问服务端、预检、落 model、选中新名字。 */
export async function runRefactor(kind: RefactorKind): Promise<void> {  const spec = REFACTOR_KINDS[kind];
  const snap = currentSelection();
  if (!snap) {
    toast("先把光标放到编辑器里再执行", "info");
    return;
  }
  if (snap.readOnly) {
    toast("当前标签是只读的（jar 内文件或换行/编码不统一），不能重构", "info");
    return;
  }
  const { model } = snap;
  const path = pathOfModel(model);
  if (!path) {
    toast("这个文件不在工作副本里，不能重构", "info");
    return;
  }

  // 空选区用光标处的单词兜底：提取常量 / 字段经常就是点在一个标识符上。
  // 连单词都没有就说清楚要选什么，别让服务端返回一句更空泛的「没有可提取的内容」。
  let start = snap.start;
  let end = snap.end;
  if (snap.empty) {
    const word = model.getWordAtPosition({ lineNumber: start.line, column: start.column });
    if (!word) {
      toast(`先选中${spec.need}再执行`, "info");
      return;
    }
    start = { line: start.line, column: word.startColumn };
    end = { line: start.line, column: word.endColumn };
  }

  const operation = beginOperation({ key: `refactor:${path.toLowerCase()}`, label: spec.label, scope: path, path, page: "files", phase: "准备文档并计算编辑" });
  if (!operation) return;
  try {
    const ctx = await context(model, { lineNumber: start.line, column: start.column });
    if (!ctx) {
      toast("代码智能没就绪，或这个文件不在正在服务的模块里", "warning");
      return;
    }

    const prefs = getEditorPrefs();
    const version = model.getVersionId();
    const res = await langRequest<RefactorResponse | null>(
      "java/getRefactorEdit",
      path,
      refactorParams(
        kind,
        { start: toLspPosition(start.line, start.column), end: toLspPosition(end.line, end.column) },
        prefs.tabSize,
        prefs.insertSpaces,
      ),
      60_000,
    );

    // 请求在途时用户可能继续打字：这时清单的行列是旧文本的，落下去会改错位置
    if (model.isDisposed() || model.getVersionId() !== version) {
      toast(`文件在${spec.label}过程中被修改，已取消；请重新执行`, "warning");
      return;
    }
    if (!res) {
      toast(`这里没有可提取的内容：请先选中${spec.need}`, "warning");
      return;
    }
    if (res.errorMessage) {
      operation.finish("failed", res.errorMessage);
      toast(`${spec.label}失败：${res.errorMessage}`, "error");
      return;
    }

    const { groups } = groupEdits(res.edit);
    const mine = groups.find((g) => g.path.toLowerCase() === path.toLowerCase());
    if (!mine) {
      toast("代码智能没有给出改动（选中的内容可能不能被提取）", "warning");
      return;
    }
    if (groups.length > 1) {
      toast(`这次${spec.label}还涉及 ${groups.length - 1} 个其它文件，未应用；请改用快速修复逐处处理`, "warning");
      return;
    }

    // 预检：越界 / 重叠直接抛错，此时一个字符都还没改
    try {
      applyLspEdits(model.getValue(), mine.edits);
    } catch (e) {
      operation.finish("failed", String(e));
      toast(`${spec.label}中止：${e}`, "error");
      return;
    }
    applyEdits(model, mine.edits);

    operation.finish("success", "改动已应用到编辑器；尚未保存，Ctrl+S 落盘");
    // 新名字选中，紧接着 F2 就能改名（提取方法的默认名 `extracted` 尤其需要）
    const span = newNameSpan(res);
    const named =
      span !== null && span.offset + span.length <= model.getValueLength()
        ? selectInEditor(
            toPosition(model, span.offset),
            toPosition(model, span.offset + span.length),
          )
        : false;
    toast(
      named
        ? `${spec.label}完成，已选中新名字（按 F2 改名；未保存，Ctrl+S 落盘）`
        : `${spec.label}完成（未保存，Ctrl+S 落盘）`,
      "success",
    );
  } catch (e) {
    operation.finish("failed", String(e));
    toast(`${spec.label}失败：${e}`, "error");
  } finally {
    operation.finish("cancelled", "未应用改动，请根据提示重新执行");
  }
}

function toPosition(model: Model, offset: number): { line: number; column: number } {
  const p = model.getPositionAt(offset);
  return { line: p.lineNumber, column: p.column };
}

/**
 * 给编辑器挂提取快捷键（IDEA 同键：Ctrl+Alt+M/V/F/C）。
 *
 * 放在这里而不是页面里：键和动作必须是同一份清单，命令面板（`useFilesTabCommands`）
 * 用的也是 `REFACTOR_KINDS`，两边各自写一遍键位迟早会对不上。
 */
export function registerRefactorKeys(ed: monaco.editor.IStandaloneCodeEditor): void {
  const keys = [
    [monaco.KeyCode.KeyM, "extractMethod"],
    [monaco.KeyCode.KeyV, "extractVariable"],
    [monaco.KeyCode.KeyF, "extractField"],
    [monaco.KeyCode.KeyC, "extractConstant"],
  ] as const;
  for (const [key, kind] of keys) {
    bindEditorCommand(ed, monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | key, () => void runRefactor(kind), REFACTOR_KINDS[kind].label);
  }
}
