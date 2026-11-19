// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WorkbenchShell } from "./WorkbenchShell";

const renders = vi.hoisted(() => vi.fn());
vi.mock("../tabs/FilesTab", () => ({ FilesTab: () => { renders(); return <textarea defaultValue="draft" />; } }));
vi.mock("./WorkbenchFrame", () => ({ WorkbenchFrame: ({ tool }: { tool: ReactNode }) => <>{tool}</> }));
vi.mock("./WorkspaceSkeleton", () => ({ WorkspaceSkeleton: () => null }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("switching tools does not rebuild the retained file session", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); renders.mockClear();
  try {
    await act(async () => root.render(<WorkbenchShell activeTab="files" tool={null} />));
    const textarea = host.querySelector("textarea")!; textarea.value = "unsaved";
    expect(renders).toHaveBeenCalledOnce();
    for (const page of ["db", "svn", "meta", "settings", "files"]) {
      await act(async () => root.render(<WorkbenchShell activeTab={page} tool={null} />));
    }
    expect(renders).toHaveBeenCalledOnce();
    expect(host.querySelector("textarea")).toBe(textarea); expect(textarea.value).toBe("unsaved");
  } finally { act(() => root.unmount()); host.remove(); }
});
