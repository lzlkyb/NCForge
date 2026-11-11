// 提取参数（受限版）：把方法体里的一个表达式变成新参数，当前文件里的调用点补上原表达式。
//
// jdt.ls 0.57 没有 extract parameter，这里用它已有的能力拼出来：
// 类型取自「提取变量」返回的编辑（只读类型，不应用），调用点来自 references，
// 重写检查来自 implementation 与父类检查。
//
// 安全模型（先判断、再动手）：任何一项检查不过或任何一个请求失败，都一个字符不改。
// 红线同其它重构：编辑只落到编辑器 model，保存仍由 Ctrl+S；跨文件不改。
//
// 范围：默认窄档（只放字面量与 static final 常量）；设置里可放宽到字段等引用。
import { beginOperation } from "./operations";
import { monaco } from "./monacoSetup";
import { bindEditorCommand } from "./editorCommandBinding";
import { context } from "./langProviders";
import { langRequest } from "./lang";
import { pathOfModel } from "./editorStore";
import { currentSelection, selectInEditor } from "./editorActions";
import { getEditorPrefs } from "./editorPrefs";
import { groupEdits } from "./renameEdits";
import { contentsToMarkdown, toLspPosition, toTargets, uriToPath } from "./langConvert";
import { fetchSymbols } from "./symbols";
import { refactorParams, type RefactorResponse } from "./refactorPlan";
import {
  classHeaderHasSupertype,
  hoverIsStaticFinal,
  isAssignmentTarget,
  isQualifiedName,
  leadingIdentifiers,
  literalType,
  parseExtractedDeclaration,
  planParameterEdits,
  syntaxProblem,
  trimRange,
  uniqueParamName,
} from "./refactorParamPlan";
import { toast } from "../components/ui/toast";

const LABEL = "提取参数";
/** 调用点上限：到这个数说明这个方法太过公共，靠这个受限版不合适。 */
const MAX_CALLS = 50;
const REQUEST_TIMEOUT = 15_000;

type Model = ReturnType<typeof monaco.editor.createModel>;
type Ctx = { path: string; position: ReturnType<typeof toLspPosition> };

/** 严格请求：失败直接抛出，不像 `ask` 那样吞掉错误——这里「查不到」和「查到没有」必须区分。 */
function strict<T>(method: string, ctx: Ctx, params: Record<string, unknown> = {}): Promise<T> {
  return langRequest<T>(method, ctx.path, { position: ctx.position, ...params }, REQUEST_TIMEOUT);
}

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

const targetPath = (uri: string): string => (uri.startsWith("file://") ? (uriToPath(uri) ?? uri) : uri);

class Refuse extends Error {}
const refuse = (reason: string): never => {
  throw new Refuse(reason);
};

function posOf(model: Model, offset: number): { line: number; column: number } {
  const p = model.getPositionAt(offset);
  return { line: p.lineNumber, column: p.column };
}

/** 命令面板 / 快捷键入口。 */
export async function runExtractParameter(): Promise<void> {
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

  let start = snap.start;
  let end = snap.end;
  if (snap.empty) {
    const word = model.getWordAtPosition({ lineNumber: start.line, column: start.column });
    if (!word) {
      toast(`先选中要提取成参数的表达式再执行`, "info");
      return;
    }
    start = { line: start.line, column: word.startColumn };
    end = { line: start.line, column: word.endColumn };
  }

  const operation = beginOperation({
    key: `refactor:${path.toLowerCase()}`,
    label: LABEL,
    scope: path,
    path,
    page: "files",
    phase: "检查表达式与调用点",
  });
  if (!operation) return;
  try {
    const done = await plan(model, path, start, end);
    operation.finish("success", "改动已应用到编辑器；尚未保存，Ctrl+S 落盘");
    toast(done, "success");
  } catch (e) {
    if (e instanceof Refuse) {
      operation.finish("cancelled", e.message);
      toast(`${LABEL}未执行：${e.message}`, "warning");
    } else {
      operation.finish("failed", String(e));
      toast(`${LABEL}失败：${e}`, "error");
    }
  } finally {
    operation.finish("cancelled", "未应用改动，请根据提示重新执行");
  }
}

async function plan(
  model: Model,
  path: string,
  start: { line: number; column: number },
  end: { line: number; column: number },
): Promise<string> {
  const prefs = getEditorPrefs();
  const wide = prefs.extractParamWide;
  const version = model.getVersionId();
  const text = model.getValue();
  const raw0 = model.getOffsetAt({ lineNumber: start.line, column: start.column });
  const raw1 = model.getOffsetAt({ lineNumber: end.line, column: end.column });
  const { start: exprStart, end: exprEnd } = trimRange(text, raw0, raw1);
  const expr = text.slice(exprStart, exprEnd);

  // ① 文本层面：副作用 / 赋值目标等明显不行的
  const bad = syntaxProblem(expr);
  if (bad) refuse(bad);
  if (isAssignmentTarget(text, exprStart, exprEnd)) refuse("它是赋值或自增的目标，换成参数后代码不成立");

  const startPos = posOf(model, exprStart);
  const ctx0 = await context(model, { lineNumber: startPos.line, column: startPos.column });
  if (!ctx0) {
    refuse("代码智能没就绪，或这个文件不在正在服务的模块里");
    return "";
  }

  // ② 找到包着选区的方法
  const symbols = await fetchSymbols(path);
  const span = (s: { startLine: number; endLine: number }) => s.endLine - s.startLine;
  const methods = symbols
    .filter((s) => (s.kind === 6 || s.kind === 9) && s.startLine <= startPos.line && startPos.line <= s.endLine)
    .sort((a, b) => span(a) - span(b));
  const method = methods[0];
  if (!method) return refuse("选区不在方法体里");
  if (method.kind === 9) return refuse("构造方法暂不支持");
  const endPos = posOf(model, exprEnd);
  if (endPos.line > method.endLine) return refuse("选区跨出了方法");
  const owners = symbols
    .filter((s) => [5, 10, 11].includes(s.kind) && s.startLine <= method.startLine && method.endLine <= s.endLine)
    .sort((a, b) => span(a) - span(b));
  const owner = owners[0];
  if (owner?.kind === 11) return refuse("接口里的方法没有方法体可改");

  const methodName = method.name.split("(")[0].trim();
  const nameOffset = model.getOffsetAt({ lineNumber: method.line, column: method.column });
  if (text.slice(nameOffset, nameOffset + methodName.length) !== methodName) {
    return refuse("定位不到方法名，已放弃");
  }
  let open = nameOffset + methodName.length;
  while (open < text.length && /\s/.test(text[open])) open++;
  if (text[open] !== "(") return refuse("定位不到方法的参数列表，已放弃");

  const lineStartOffset = model.getOffsetAt({ lineNumber: method.startLine, column: 1 });
  const head = text.slice(lineStartOffset, nameOffset);
  if (/@Override\b/.test(head)) return refuse("方法带 @Override：父类 / 接口里的签名不会跟着改");

  const nameCtx = await context(model, { lineNumber: method.line, column: method.column });
  if (!nameCtx) return refuse("代码智能没就绪");

  // ③ 重写检查：子类重写了它（implementation），或它重写了父类 / 实现了接口（旧代码常不写 @Override）
  const impls = toTargets(await strict<unknown>("textDocument/implementation", nameCtx)).filter(
    (t) => !(samePath(targetPath(t.uri), path) && t.range.start.line + 1 === method.line),
  );
  if (impls.length > 0) return refuse(`有 ${impls.length} 处子类重写了它，改签名会让它们不再是重写`);
  let superLinks: unknown[] | null = null;
  try {
    // findLinks 的 position 是完整的 TextDocumentPositionParams（后端会把里面的 uri 换成影子工程的）
    superLinks =
      (await strict<unknown[] | null>("java/findLinks", nameCtx, {
        type: "superImplementation",
        position: { textDocument: { uri: "" }, position: nameCtx.position },
      })) ?? [];
  } catch {
    superLinks = null;
  }
  if (superLinks === null) {
    // 代码智能不支持这个查询：退回保守规则——类有父类或接口就无法确认没有同名方法，不做
    if (owner && classHeaderHasSupertype(text, model.getOffsetAt({ lineNumber: owner.startLine, column: 1 }))) {
      return refuse("代码智能查不出父类 / 接口里有没有同名方法，这个类有 extends / implements，为安全起见不做");
    }
  } else if (superLinks.length > 0) {
    return refuse("它重写了父类方法或实现了接口方法，改签名会让它不再是重写");
  }

  // ④ 表达式能不能搬到调用点（语义层面）
  const lit = literalType(expr);
  const scopeHint = "要放宽到字段等引用，在 设置 → 编辑器 里开启「提取参数放宽到字段引用」";
  if (!wide && !lit) {
    if (!isQualifiedName(expr)) {
      return refuse(`窄档只允许字面量和 static final 常量。${scopeHint}`);
    }
    const lastOff = exprStart + expr.lastIndexOf(".") + 1;
    const p = posOf(model, lastOff);
    const c = await context(model, { lineNumber: p.line, column: p.column });
    if (!c) return refuse("代码智能没就绪");
    const hover = await strict<{ contents?: unknown } | null>("textDocument/hover", c);
    const md = hover?.contents ? contentsToMarkdown(hover.contents).join("\n") : "";
    if (!hoverIsStaticFinal(md)) {
      return refuse(`「${expr}」不是 static final 常量。${scopeHint}`);
    }
  }
  if (wide && !lit) {
    for (const id of leadingIdentifiers(expr).slice(0, 8)) {
      const p = posOf(model, exprStart + id.offset);
      const c = await context(model, { lineNumber: p.line, column: p.column });
      if (!c) return refuse("代码智能没就绪");
      const defs = toTargets(await strict<unknown>("textDocument/definition", c));
      if (defs.length === 0) return refuse(`查不出「${id.name}」指向什么，不能确认它搬到调用点还成立`);
      const local = defs.some(
        (d) => samePath(targetPath(d.uri), path) && d.range.start.line + 1 >= method.startLine && d.range.start.line + 1 <= method.endLine,
      );
      if (local) return refuse(`「${id.name}」是方法的参数或局部变量，调用点那里没有它`);
    }
  }

  // ⑤ 类型与名字
  let type = lit;
  let suggested = "param";
  if (!type) {
    const range = {
      start: toLspPosition(startPos.line, startPos.column),
      end: toLspPosition(endPos.line, endPos.column),
    };
    const res = await langRequest<RefactorResponse | null>(
      "java/getRefactorEdit",
      path,
      refactorParams("extractVariable", range, getEditorPrefs().tabSize, getEditorPrefs().insertSpaces),
      60_000,
    );
    if (!res || res.errorMessage) return refuse(`判断不出表达式的类型：${res?.errorMessage ?? "代码智能没有给出结果"}`);
    const texts = groupEdits(res.edit).groups.flatMap((g) => g.edits.map((e) => e.newText));
    const decl = parseExtractedDeclaration(texts);
    if (!decl) return refuse("读不出表达式的类型");
    type = decl.type;
    suggested = decl.name;
  }
  const name = uniqueParamName(suggested, text);

  // ⑥ 调用点：只允许都在当前文件
  const refs = toTargets(await strict<unknown>("textDocument/references", nameCtx, { context: { includeDeclaration: false } }));
  if (refs.length > MAX_CALLS) return refuse(`这个方法有 ${refs.length} 处调用，超过 ${MAX_CALLS} 处，受限版不处理`);
  const outside = refs.filter((r) => !samePath(targetPath(r.uri), path));
  if (outside.length > 0) {
    return refuse(`还有 ${outside.length} 处调用在别的文件里。提取参数只改当前文件，半改比不改更糟`);
  }
  const calls = refs.map((r) => model.getOffsetAt({ lineNumber: r.range.start.line + 1, column: r.range.start.character + 1 }));

  // ⑦ 改动清单（先在文本上预检，再落 model）
  const planned = planParameterEdits({ text, exprStart, exprEnd, name, type, methodName, openParen: open, calls });
  if (!planned.ok) return refuse(planned.reason);
  if (model.isDisposed() || model.getVersionId() !== version) {
    return refuse("文件在检查过程中被修改，已取消；请重新执行");
  }
  const ops = planned.edits.map((e) => {
    const a = model.getPositionAt(e.start);
    const b = model.getPositionAt(e.end);
    return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: e.text };
  });
  model.pushEditOperations([], ops, () => null);

  const np = posOf(model, planned.nameOffset);
  const named = selectInEditor(np, posOf(model, planned.nameOffset + name.length));
  const callNote = calls.length > 0 ? `，${calls.length} 处调用已补上参数` : "，当前文件里没有调用点";
  return `${LABEL}完成：${type} ${name}${callNote}${named ? "（已选中新参数名，按 F2 改名）" : ""}。只检查了当前文件，XML / 反射里的引用不会自动改；未保存，Ctrl+S 落盘`;
}

/** 编辑器快捷键（IDEA 同键 Ctrl+Alt+P）。 */
export function registerExtractParameterKey(ed: monaco.editor.IStandaloneCodeEditor): void {
  bindEditorCommand(ed, monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyP, () => void runExtractParameter(), LABEL);
}
