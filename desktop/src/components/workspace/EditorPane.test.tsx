// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorPane } from "./EditorPane";

// jsdom 里跑不了真的 Monaco（它要 worker、要 canvas），这里只验「按文件切换编辑器配置」这条链路：
// 记录 updateOptions 收到了什么。
const mocks = vi.hoisted(() => ({
  editor: {
    addCommand: vi.fn(),
    onDidChangeCursorPosition: vi.fn(),
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
    editor: { create: () => mocks.editor },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
  },
}));

vi.mock("../../lib/editorStore", () => ({
  getModel: () => undefined,
  getViewState: () => null,
  saveViewState: vi.fn(),
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
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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
