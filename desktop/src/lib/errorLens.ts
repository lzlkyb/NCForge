// Error Lens：把诊断直接写到行尾（IDEA 的「行内错误提示」/ VS Code 的 Error Lens 插件）。
//
// 数据源就是 `diagStore` 里那份（与「问题」面板、波浪线同一个快照），所以三处永远一致。
// 这里只做「快照 → Monaco 装饰」，不发起任何请求。
//
// 与波浪线的关系：两者都留着，但提供开关。波浪线看位置、行尾看内容，各有用处；
// 觉得吵的人可以关掉行尾（设置 → 编辑器 → 行尾诊断）。
import { monaco } from "./monacoSetup";
import { pathOfModel } from "./editorStore";
import { getCodeDiags, subscribeCodeDiags } from "./diagStore";
import { getEditorPrefs, PREFS_EVENT } from "./editorPrefs";
import { diagnosticSummaries } from "./diagnosticSummary";

/** 一次最多画多少条：超长文件被全量报错时，几千个装饰会把渲染拖住（面板仍有完整清单）。 */
const MAX_DECORATIONS = 300;

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

type Editor = ReturnType<typeof monaco.editor.create>;

/**
 * 给一个编辑器挂上行尾诊断，返回清理函数。
 *
 * 监听三件事：诊断变化、切 model（换文件）、偏好变化（开关）。
 * 切 model 必须重算——装饰是挂在具体 model 上的，换文件后旧装饰不会跟着走。
 */
export function attachErrorLens(editor: Editor): () => void {
  // Monaco 的装饰集合只有 clear / set（没有 dispose）：清空即释放
  let current: { clear(): void } | null = null;

  const clear = () => {
    current?.clear();
    current = null;
  };

  const apply = () => {
    clear();
    const model = editor.getModel();
    if (!model || !getEditorPrefs().errorLens) return;
    const path = pathOfModel(model);
    if (!path) return;
    const list = diagnosticSummaries(getCodeDiags().filter((d) => samePath(d.path, path)), MAX_DECORATIONS);
    if (list.length === 0) return;
    const decorations = list.map((d) => ({
      range: new monaco.Range(d.line, 1, d.line, 1),
      options: {
        // 不整行高亮：NC 代码里注释和语句挤在一行的情况很常见，整行染红反而看不清哪句错
        isWholeLine: false,
        after: {
          content: `  ${d.summary}`,
          inlineClassName: `ncforge-lens ncforge-lens-${d.severity}`,
        },
        hoverMessage: { value: d.detail },
        overviewRuler: undefined,
        zIndex: 1,
      },
    }));
    const collection = editor.createDecorationsCollection();
    collection.set(decorations);
    current = collection;
  };

  apply();
  const offDiag = subscribeCodeDiags(apply);
  const offModel = editor.onDidChangeModel(apply);
  const offPrefs = () => apply();
  window.addEventListener(PREFS_EVENT, offPrefs);
  return () => {
    offDiag();
    offModel.dispose();
    window.removeEventListener(PREFS_EVENT, offPrefs);
    clear();
  };
}
