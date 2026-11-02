// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatBeforeSave, type SaveEditor } from "./formatOnSave";
import { DEFAULT_PREFS, setEditorPrefs } from "./editorPrefs";

const fake = (language: string) => {
  const run = vi.fn(async () => {});
  const editor = {
    getModel: () => ({ getLanguageId: () => language }),
    getAction: (id: string) => (id === "editor.action.formatDocument" ? { run } : null),
  } as unknown as SaveEditor;
  return { editor, run };
};

beforeEach(() => {
  localStorage.clear();
  setEditorPrefs({ ...DEFAULT_PREFS });
});

describe("保存前格式化", () => {
  it("开关打开时先格式化再保存（顺序不能反）", async () => {
    setEditorPrefs({ formatOnSave: true });
    const { editor, run } = fake("java");
    const save = vi.fn();
    await formatBeforeSave(editor).then(save);
    expect(run).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("默认关：保存前不碰文件内容", async () => {
    const { editor, run } = fake("java");
    const save = vi.fn();
    await formatBeforeSave(editor).then(save);
    expect(run).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("非 Java 文件不格式化（XML / SQL 没有格式服务）", async () => {
    setEditorPrefs({ formatOnSave: true });
    const { editor, run } = fake("xml");
    await formatBeforeSave(editor);
    expect(run).not.toHaveBeenCalled();
  });

  it("格式化抛错不阻断保存：用户按了 Ctrl+S 就该落盘", async () => {
    setEditorPrefs({ formatOnSave: true });
    const run = vi.fn(async () => {
      throw new Error("语言服务未就绪");
    });
    const editor = {
      getModel: () => ({ getLanguageId: () => "java" }),
      getAction: () => ({ run }),
    } as unknown as SaveEditor;
    const save = vi.fn();
    await formatBeforeSave(editor).then(save);
    expect(run).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("没有 model（编辑器刚卸载）也不抛错", async () => {
    setEditorPrefs({ formatOnSave: true });
    const editor = { getModel: () => null, getAction: () => null } as unknown as SaveEditor;
    await expect(formatBeforeSave(editor)).resolves.toBeUndefined();
  });
});
