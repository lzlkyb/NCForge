// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BlameView } from "./BlameView";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => dispose());
it("固定版本正文与对应行归属一起展示，点击版本进入真实提交", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const show = vi.fn();
  dispose = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => root.render(<BlameView title="A.java" snapshot={{ sourceRevision: 9, text: "repository line\nsecond", encoding: "UTF-8", lines: [{ revision: 7, author: "alice", date: 1 }, { revision: 9, author: "bob", date: 2 }] }} loading={false} retrying={false} error={null} onRetry={vi.fn()} onShowDiff={vi.fn()} onShowRevision={show} />));
  expect(host.textContent).toContain("正文与作者：r9");
  const rows = host.querySelectorAll(".vc-blame-row"); expect(rows[0].textContent).toContain("r7alice1repository line");
  await act(async () => rows[0].querySelector<HTMLButtonElement>("button")!.click()); expect(show).toHaveBeenCalledWith(7);
});
