// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSaveShortcut } from "./useSaveShortcut";

it("多份结果都有待写回改动时，只保存焦点所属的一份", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const first = vi.fn(), second = vi.fn();
  function View({ owner, save }: { owner: string; save: () => void }) {
    useSaveShortcut(save, true, owner);
    return <div className="dbx-result-table" data-result-edit-owner={owner}><button>{owner}</button></div>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    act(() => root.render(<><View owner="first" save={first} /><View owner="second" save={second} /></>));
    act(() => host.querySelector('[data-result-edit-owner="second"] button')!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
