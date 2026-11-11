// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { setUpdateDownloadPreference, useUpdateDownloadPreference } from "./updateDownloadPreference";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("写入失败后界面使用本次选择，重试成功后持久化", async () => {
  localStorage.setItem("shell_update_auto_download", "true");
  const container = document.createElement("div");
  const root = createRoot(container);
  function Preview() { return <span>{String(useUpdateDownloadPreference())}</span>; }
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  try {
    await act(async () => root.render(<Preview />));
    await act(async () => { expect(setUpdateDownloadPreference(false)).toBe(false); });
    expect(container.textContent).toBe("false");
    expect(localStorage.getItem("shell_update_auto_download")).toBe("true");
    write.mockRestore();
    await act(async () => { expect(setUpdateDownloadPreference(false)).toBe(true); });
    expect(container.textContent).toBe("false");
    expect(localStorage.getItem("shell_update_auto_download")).toBe("false");
  } finally {
    write.mockRestore();
    await act(async () => root.unmount());
    localStorage.clear();
  }
});
