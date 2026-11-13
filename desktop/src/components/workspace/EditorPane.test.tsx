// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, setEditorPrefs } from "../../lib/editorPrefs";
import { EditorPane } from "./EditorPane";

// jsdom 里跑不了真的 Monaco（它要 worker、要 canvas），这里只验「按文件切换编辑器配置」这条链路：
// 记录 updateOptions 收到了什么。
const mocks = vi.hoisted(() => ({
  createArgs: [] as Record<string, unknown>[],
  /** 拿到的模型生命周期回调：用来模拟「内容晚一步读到」。 */
  lifecycle: null as null | ((path: string) => void),
  /** 当前挂着的 model（`getModel` 读它，用例里可以中途换）。 */
  model: null as unknown,
  editor: {
    addCommand: vi.fn(),
    addAction: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDispose: vi.fn(),
    onKeyDown: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeCursorPosition: vi.fn(),
    // 自动保存（内容变化）与 Error Lens（装饰集合 + 切 model）也要有人应答，
    // 否则挂载即炸：这两个入口是随编辑器偏好一起加的
    onDidChangeModelContent: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeModel: vi.fn(() => ({ dispose: vi.fn() })),
    // 分屏后「当前编辑器」要跟着焦点走：挂载时会订阅焦点
    onDidFocusEditorText: vi.fn(() => ({ dispose: vi.fn() })),
    // 断点点位挂在行号槽上：挂载时会订阅点击（加/去断点）
    onMouseDown: vi.fn(() => ({ dispose: vi.fn() })),
    createDecorationsCollection: vi.fn(() => ({ clear: vi.fn() })),
    updateOptions: vi.fn(),
    setModel: vi.fn(),
    getModel: vi.fn(() => null),
    saveViewState: vi.fn(() => null),
    restoreViewState: vi.fn(),
    getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
    focus: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock("../../lib/monacoSetup", () => ({
  initMonaco: vi.fn(),
  monaco: {
    editor: {
      create: (_el: HTMLElement, options: Record<string, unknown>) => {
        mocks.createArgs.push(options);
        return mocks.editor;
      },
    },
    // 引用 / 格式化 / 快速修复 / 折叠 / 当前符号高亮 / 扩展选区 / 代码模板等 provider
    // 的注册点：`EditorPane` 挂载时会调，这里给出桩函数，
    // 缺一个就会在挂载时炸「cannot read properties of undefined」
    languages: {
      registerReferenceProvider: vi.fn(),
      registerDocumentFormattingEditProvider: vi.fn(),
      registerCodeActionProvider: vi.fn(),
      registerImplementationProvider: vi.fn(),
      registerTypeDefinitionProvider: vi.fn(),
      registerFoldingRangeProvider: vi.fn(),
      registerDocumentHighlightProvider: vi.fn(),
      registerSelectionRangeProvider: vi.fn(),
      registerCompletionItemProvider: vi.fn(),
      // 调试悬停：随编辑器创建时注册一次
      registerHoverProvider: vi.fn(),
    },
    Range: class {},
    KeyMod: { CtrlCmd: 2048, Alt: 512 },
    KeyCode: { KeyS: 49, Enter: 3 },
  },
}));

// 语言服务的 provider 注册与编辑器包装无关，且会拉进一整条依赖链
vi.mock("../../lib/langProviders", () => ({ registerLangProviders: vi.fn() }));
// Java 右键的 SQL 动作与它的对话框同理：拉进数据库页整条依赖链
vi.mock("../../lib/javaSqlActions", () => ({ registerJavaSqlActions: () => [] }));

vi.mock("../../lib/editorStore", () => ({
  onModelLifecycle: (created: (path: string) => void) => { mocks.lifecycle = created; return () => {}; },
  getModel: () => mocks.model,
  getViewState: () => null,
  saveViewState: vi.fn(),
  // 预览模型的保活入口（EditorPane 切 model 时调）；当前用例 getModel 恒为 undefined，
  // 这个分支不会真的走到，但 mock 必须给全，否则哪天渲染带上 activePath 就直接炸
  touchModel: vi.fn(),
  pathOfModel: () => undefined,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const renderPane = async (heavy: boolean) => {
  await act(async () =>
    root.render(
      <EditorPane
        activePath={null}
        readOnly={false}
        reveal={null}
        heavy={heavy}
        onCursor={() => {}}
        onSave={() => {}}
      />,
    ),
  );
};

/** 最后一次 updateOptions 里跟降级相关的字段。 */
const lastOptions = () => mocks.editor.updateOptions.mock.lastCall?.[0] as Record<string, unknown>;

beforeEach(() => {
  mocks.model = null;
  mocks.editor.getModel.mockReturnValue(null);
  setEditorPrefs({ ...DEFAULT_PREFS, minimap: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.editor.updateOptions.mockClear();
  mocks.createArgs.length = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers(); vi.restoreAllMocks();
});

it("共享模型的非焦点视图不重复自动保存；切模型后旧计时器不保存新文件", async () => {
  vi.useFakeTimers(); setEditorPrefs({ autoSave: true, autoSaveDelayMs: 500 });
  const save = vi.fn();
  await act(async () => root.render(<EditorPane activePath={null} focused={false} readOnly={false} heavy={false} onCursor={() => {}} onSave={save} />));
  mocks.editor.getModel.mockReturnValue({} as never);
  const changed = (mocks.editor.onDidChangeModelContent.mock.lastCall as unknown as [() => void])[0];
  const timer = vi.spyOn(window, "setTimeout"); timer.mockClear();
  act(() => changed()); expect(timer).not.toHaveBeenCalled();
  await act(async () => root.render(<EditorPane activePath={null} focused readOnly={false} heavy={false} onCursor={() => {}} onSave={save} />));
  act(() => changed()); expect(timer).toHaveBeenCalled();
  mocks.editor.getModel.mockReturnValue({} as never);
  await act(async () => vi.advanceTimersByTime(500)); expect(save).not.toHaveBeenCalled();
});

it("后台恢复的标签等到 model 到位后补算编辑器配置", async () => {
  await act(async () => root.render(
    <EditorPane activePath={"C:\\w\\A.java"} readOnly={false} reveal={null} heavy={false} onCursor={() => {}} onSave={() => {}} />,
  ));
  mocks.editor.updateOptions.mockClear();
  // 内容晚一步读到：model 这时才挂上，而 activePath 一直没变
  mocks.model = { getLanguageId: () => "plaintext" };
  await act(async () => mocks.lifecycle!("C:\\w\\A.java"));
  expect(mocks.editor.updateOptions).toHaveBeenCalled();
});

describe("行号槽", () => {
  // ESM 版 Monaco 把 glyphMargin 的默认值改成了 false（editor.api.js）。不显式打开，
  // 行号左边没有那条槽，书签小旗和断点类装饰都画不出来。
  it("建编辑器时显式打开 glyphMargin", async () => {
    await renderPane(false);
    expect(mocks.createArgs[0]?.glyphMargin).toBe(true);
  });
});

describe("超大文件的编辑器降级", () => {
  it("普通文件不降级", async () => {
    await renderPane(false);
    expect(lastOptions()).toMatchObject({
      bracketPairColorization: { enabled: true },
      folding: true,
      minimap: { enabled: true },
    });
  });

  it("大文件关掉括号对着色、代码折叠与小地图", async () => {
    await renderPane(true);
    expect(lastOptions()).toMatchObject({
      bracketPairColorization: { enabled: false },
      folding: false,
      minimap: { enabled: false },
    });
  });

  it("大文件降级与切换都尊重手动关闭的小地图", async () => {
    await renderPane(true);
    await act(async () => { setEditorPrefs({ minimap: false, fontSize: 14 }); });
    expect(lastOptions()).toMatchObject({ lineHeight: 23, minimap: { enabled: false }, folding: false });
    await renderPane(false);
    expect(lastOptions()).toMatchObject({ minimap: { enabled: false }, folding: true });
  });

  it("从一个文件切到另一个时，降级跟着当前文件走", async () => {
    await renderPane(true);
    mocks.editor.updateOptions.mockClear();
    await renderPane(false);
    expect(lastOptions()).toMatchObject({
      bracketPairColorization: { enabled: true },
      folding: true,
      minimap: { enabled: true },
    });
  });
});
