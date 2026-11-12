// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitPanel } from "./CommitPanel";
import { getSvnDraft, syncSvnDraft, toggleSvnPicked } from "../../lib/svnDraft";
import { keyOf, type ChangeItem } from "../../lib/svn";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const file = (name: string): ChangeItem => ({path:`C:/svn-ui/${name}.java`,rel:`module/src/${name}.java`,module:"module",letter:"M",status:"modified",revision:2,isDir:false,ignored:false});
let dispose = () => {}, sequence = 0;
afterEach(() => dispose());
function render(files = [file("A"),file("B")], outdated = new Set<string>()) {
  const workspace = `C:/svn-ui-${++sequence}`, host = document.createElement("div"), root = createRoot(host), submit = vi.fn(), select = vi.fn();
  document.body.append(host); syncSvnDraft(workspace,files);
  const paint = () => act(() => root.render(<CommitPanel items={files} root={workspace} outdated={outdated} reviewed={new Set([keyOf(files[0].path)])} busy={false} onSubmit={submit} onCancel={vi.fn()} onSelect={select} />));
  paint(); dispose = () => { act(() => root.unmount()); host.remove(); };
  const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text)!;
  return {host,workspace,submit,select,files,paint,button};
}
describe("SVN commit UI", () => {
  it("partial selection has a native mixed state and clear really clears", () => {
    const t = render(); act(() => toggleSvnPicked(t.workspace,t.files[1].path));
    const all = t.host.querySelector<HTMLInputElement>('[aria-label="选择全部可提交文件"]')!;
    expect(all.indeterminate).toBe(true); expect(all.getAttribute("aria-checked")).toBe("mixed");
    act(() => t.button("清空").click()); expect(getSvnDraft(t.workspace).picked.size).toBe(0);
    act(() => t.button("全选").click()); expect(getSvnDraft(t.workspace).picked.size).toBe(2);
  });
  it("new scan files are not silently added to an established draft", () => {
    const t = render(); act(() => syncSvnDraft(t.workspace,[...t.files,file("New")]));
    expect([...getSvnDraft(t.workspace).picked]).toEqual(t.files.map(f => f.path));
  });
  it("clicking selected file opens its diff without changing selection", () => {
    const t = render(); act(() => t.host.querySelector<HTMLButtonElement>(".vc-commit-path")!.click());
    expect(t.select).toHaveBeenCalledWith(t.files[0]); expect(getSvnDraft(t.workspace).picked.size).toBe(2);
  });
  it("only-reviewed selection follows review identity", () => {
    const t = render(); act(() => t.button("只选已审").click()); expect([...getSvnDraft(t.workspace).picked]).toEqual([t.files[0].path]);
  });
  it("distinguishes reviewed, outdated and untracked files while excluding conflicts", () => {
    const stale = { ...file("B"), letter: "?" as const };
    const t = render([file("A"), stale, { ...file("C"), letter: "C" }], new Set([keyOf(stale.path)]));
    expect(t.host.querySelector(".vc-commit-summary")?.textContent).toContain("已审 1 · 需重审 1");
    expect(t.host.textContent).toContain("1 项冲突或受阻改动已排除");
    expect(t.host.textContent).toContain("1 个未跟踪文件将在提交时加入 SVN");
    expect(t.host.querySelectorAll(".vc-commit-file")).toHaveLength(2);
  });
  it("IME Ctrl+Enter does not submit a valid message", () => {
    const t = render(); const textarea = t.host.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;
    act(() => { setter.call(textarea,"修复保存流程"); textarea.dispatchEvent(new Event("input",{bubbles:true})); });
    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,isComposing:true,bubbles:true})));
    expect(t.submit).not.toHaveBeenCalled();
    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true})));
    expect(t.submit).toHaveBeenCalledTimes(1);
  });
});
