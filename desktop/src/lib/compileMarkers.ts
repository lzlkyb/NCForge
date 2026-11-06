// 把 ecj 编译问题写进 Monaco 标记（红色/黄色波浪线）。
//
// 为什么需要它：jdt.ls 的诊断只在服务启用且索引稳定后才出现；服务关掉时，
// 编辑器里就完全看不到编译错误——问题面板有、代码里却没有。这里用独立的
// owner `ecj` 直接写标记，与 `jdt.ls` 的标记互不覆盖。
//
// 两条硬规则：
// - 只写**没有未保存改动**的文件。用户改了没保存，旧编译结果的波浪线会一直
//   钉在已经修过的行上，看着像「修了也没用」；一编辑就清掉，等下一轮编译再画。
// - 与 jdt.ls 同路径、同行、同原文的条目不重复画。两个 owner 的标记会叠在
//   一起，同一句话出现两条波浪线纯属噪音。
import { monaco } from "./monacoSetup";
import { forEachModel, onModelLifecycle } from "./editorStore";
import { getSession, subscribe } from "./workspaceSession";
import { getCodeDiags, subscribeCodeDiags, type CodeDiag } from "./diagStore";
import type { Problem } from "./compile";

/** 与 `lang.ts` 的 `jdt.ls` 分开，清除时只清自己的。 */
export const ECJ_MARKER_OWNER = "ecj";

const EMPTY: readonly Problem[] = [];

const norm = (path: string) => path.replace(/\\/g, "/").toLowerCase();

/**
 * 某个文件要画的 ecj 条目：只保留该文件、且不与 jdt.ls 同位置同原文的。
 *
 * 纯函数，单测直接喂问题列表；`inspect` 是当前 jdt.ls 诊断快照。
 */
export function ecjProblemsFor(
  filePath: string,
  problems: readonly Problem[],
  inspect: readonly CodeDiag[],
): Problem[] {
  const file = norm(filePath);
  const inspectKeys = new Set(inspect.map((d) => `${norm(d.path)}|${d.line}|${d.message.trim()}`));
  return problems.filter(
    (p) => norm(p.file) === file && !inspectKeys.has(`${file}|${p.line}|${p.message.trim()}`),
  );
}

let started = false;
/** 上一次同步的输入；引号/字符串都没变就不碰所有 model。 */
let lastProblems: readonly Problem[] | undefined;
let lastInspect: readonly CodeDiag[] | undefined;
let lastDirty = "";

/** 有未保存改动的路径（含仅换行符改动）。 */
function dirtyKey(): string {
  const dirty = getSession()
    .tabs.filter((t) => t.dirty || t.eolChanged)
    .map((t) => norm(t.path));
  return dirty.sort().join("\n");
}

function sync(force = false): void {
  const problems = getSession().compileResult?.problems ?? EMPTY;
  const inspect = getCodeDiags();
  const dirty = dirtyKey();
  // 新打开的 model 不在上一次的快照里，输入没变也必须补画
  if (!force && problems === lastProblems && inspect === lastInspect && dirty === lastDirty) return;
  lastProblems = problems;
  lastInspect = inspect;
  lastDirty = dirty;
  const dirtySet = new Set(dirty ? dirty.split("\n") : []);

  forEachModel((path, model) => {
    const items = dirtySet.has(norm(path)) ? [] : ecjProblemsFor(path, problems, inspect);
    const maxLine = model.getLineCount();
    const markers = items.map((p) => {
      const line = Math.min(Math.max(1, p.line), maxLine);
      return {
        severity: monaco.MarkerSeverity[p.severity === "error" ? "Error" : "Warning"],
        message: p.message,
        source: ECJ_MARKER_OWNER,
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: model.getLineMaxColumn(line),
      };
    });
    monaco.editor.setModelMarkers(model, ECJ_MARKER_OWNER, markers);
  });
}

/**
 * 接线一次即可（幂等）：编译结果、jdt.ls 诊断、标签 dirty、model 开关都会触发重画。
 * 由文件页的代码智能初始化调用，不依赖 jdt.ls 是否启用。
 */
export function initCompileMarkers(): void {
  if (started) return;
  started = true;
  subscribe(() => sync());
  subscribeCodeDiags(() => sync());
  onModelLifecycle(
    () => sync(true),
    () => sync(true),
  );
  sync();
}
