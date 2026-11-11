// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MetaToolbar } from "./MetaToolbar";
import { newMetaEditorState } from "../../lib/metaEditor";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("常用任务直达，脏草稿与编辑锁都阻止生成和导入", async () => {
  const host = document.createElement("div"), root = createRoot(host), onState = vi.fn(); document.body.append(host);
  const render = (dirty: boolean, locked: boolean) => act(async () => root.render(<MetaToolbar state={newMetaEditorState()} mode="linked" dirty={dirty} locked={locked} resourceDrawer={false} inspectorDrawer={false} resourceOpen={false} inspectorOpen={false} focused={false} onFocus={vi.fn()} onState={onState} onResources={vi.fn()} onInspector={vi.fn()} />));
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="元数据任务"] button')].find(b => b.textContent === label)!;
  try {
    await render(false, false); await act(async () => button("生成中心").click());
    expect(onState).toHaveBeenCalledWith({ view: "generate" });
    await render(true, false);
    expect(button("生成中心").disabled).toBe(true); expect(button("导入导出").disabled).toBe(true); expect(button("编辑").disabled).toBe(false);
    await act(async () => button("导入导出").click()); expect(onState).toHaveBeenCalledTimes(1);
    await render(false, true); expect(button("编辑").disabled).toBe(true); expect(button("生成中心").disabled).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
