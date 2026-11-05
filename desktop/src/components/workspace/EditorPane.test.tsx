// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorPane } from "./EditorPane";

// jsdom 里跑不了真的 Monaco（它要 worker、要 canvas），这里只验「按文件切换编辑器配置」这条链路：
// 记录 updateOptions 收到了什么。
const mocks = vi.hoisted(() => ({
  createArgs: [] as Record<string, unknown>[],
  editor: {
    addCommand: vi.fn(),
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
  getModel: () => undefined,
  getViewState: () => null,
  saveViewState: vi.fn(),
  // 预览模型的保活入口（EditorPane 切 model 时调）；当前用例 getModel 恒为 undefined，
  // 这个分支不会真的走到，但 mock 必须给全，否则哪天渲染带上 activePath 就直接炸
  touchModel: vi.fn(),
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.editor.updateOptions.mockClear();
  mocks.createArgs.length = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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
