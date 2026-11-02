// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchEditPanel } from "./SearchEditPanel";
import type { SearchHit } from "../../lib/search";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  save: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/workspace")>();
  return { ...actual, readFile: mocks.readFile };
});
vi.mock("../../lib/searchEdit", () => ({ saveLineEdits: mocks.save }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  path: "p/A.java",
  line: 2,
  text: "b",
  ranges: [{ start: 0, end: 1 }],
  ...over,
});

const content = (text: string) => ({
  text,
  encoding: "UTF-8",
  hasBom: false,
  eol: "CRLF",
  lossless: true,
  size: text.length,
  mtimeMs: 100,
});

const render = async (hits: SearchHit[]) => {
  const onClose = vi.fn();
  await act(async () =>
    root.render(<SearchEditPanel hits={hits} root={"C:\\w"} onClose={onClose} />),
  );
  return { onClose };
};

const input = () => container.querySelector<HTMLInputElement>("input")!;

const type = async (value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFile.mockResolvedValue(content("a\nb\nc"));
  mocks.save.mockResolvedValue({
    filesChanged: 1,
    linesChanged: 1,
    saved: [{ path: "p/A.java", line: 2, value: "B" }],
    skipped: [],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("SearchEditPanel", () => {
  it("读磁盘整行（不是结果里的截断文本），改完按行写回", async () => {
    const { onClose } = await render([hit()]);

    expect(input().value).toBe("b");
    await type("B");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").startsWith("保存"),
    )!;
    expect(save.textContent).toContain("1 行");
    await act(async () => save.click());

    expect(mocks.readFile).toHaveBeenCalledWith("C:\\w\\p\\A.java");
    expect(mocks.save).toHaveBeenCalledWith("C:\\w", [
      { path: "p/A.java", line: 2, original: "b", value: "B" },
    ]);
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("部分写回时停在预览里逐条列出跳过原因，关闭后再刷新结果", async () => {
    mocks.save.mockResolvedValue({
      filesChanged: 1,
      linesChanged: 1,
      saved: [{ path: "p/A.java", line: 2, value: "B" }],
      skipped: ["p/B.java：编码或换行无法无损写回，已跳过"],
    });
    const { onClose } = await render([hit()]);

    await type("B");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").startsWith("保存"),
    )!;
    await act(async () => save.click());

    expect(container.textContent).toContain("编码或换行无法无损写回");
    expect(onClose).not.toHaveBeenCalled();
    // 已写回的行换成新的原文，不会被当成「需要再保存一次」
    expect(input().value).toBe("B");
    expect(save.disabled).toBe(true);

    const close = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "") === "关闭",
    )!;
    await act(async () => close.click());
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("读取失败的文件列在顶部，不显示可编辑行", async () => {
    mocks.readFile.mockRejectedValue(new Error("拒绝访问"));
    await render([hit()]);

    expect(container.textContent).toContain("p/A.java");
    expect(container.textContent).toContain("拒绝访问");
    expect(container.querySelector("input")).toBeNull();
  });

  it("Esc 关闭预览", async () => {
    const { onClose } = await render([hit()]);
    await act(async () => {
      container.firstElementChild!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalled();
  });
});
