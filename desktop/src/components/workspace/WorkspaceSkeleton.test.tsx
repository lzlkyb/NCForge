// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkbenchFrame } from "./WorkbenchFrame";
import { WorkspaceSkeleton } from "./WorkspaceSkeleton";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();vi.stubGlobal("matchMedia",()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
it.each(["files","db","svn","meta","logs","settings"])("%s loading occupies its real dock without an extra runtime row", page=>{
  act(()=>root.render(<WorkbenchFrame activeTool={page} tree={null} tabs={null} editor={null} output={null} status={null} tool={<WorkspaceSkeleton page={page} />} />));
  const body=host.querySelector(page==="files"?".wb-code-body":".wb-doc-body")!;
  expect(body.querySelector(`[data-workspace-skeleton="${page}"]`)).not.toBeNull();
  expect(host.querySelectorAll('.wb-tool-runtime [data-workspace-skeleton]')).toHaveLength(0);
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(body.querySelector('.wb-loading-page')?.hasAttribute('data-visible')).toBe(false);
  act(()=>vi.advanceTimersByTime(180));
  expect(body.querySelector('.wb-loading-page')?.getAttribute('data-visible')).toBe("true");
  expect(body.querySelectorAll('button,input,textarea')).toHaveLength(0);
  if(page==="db")expect(host.querySelector('.wb-doc-tabs [data-workspace-skeleton]')).not.toBeNull();
  if(page==="files")expect(host.querySelector('.wb-code-context-host [data-workspace-skeleton]')).not.toBeNull();
});
