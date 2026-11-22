// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { setSession } from "../lib/workspaceSession";
import type { StatusResult } from "../lib/svn";
import { useSvnStatus } from "./useSvnStatus";

const mocks = vi.hoisted(() => ({ status:vi.fn() }));
vi.mock("../lib/svn",async original => ({
  ...await original<typeof import("../lib/svn")>(),
  svnInfo:async () => ({revision:4}),
  svnStatus:mocks.status,
  onSvnScanProgress:async () => () => {},
  onSvnScanUnit:async () => () => {},
}));

(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const result = (epoch: number) => ({
  epoch, changes:{groups:[],shown:0,total:0,ignored:0}, reviewed:[],
  hasConflict:false, generatedAtMs:epoch, scanned:0, incremental:false, modulesScanned:0,
});

it("post-write verification ignores an unfinished scan started before the write", async () => {
  const work = "D:/svn-status-verification";
  setSession({root:work});
  let finishOld!: (value: StatusResult) => void;
  mocks.status.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  mocks.status.mockResolvedValueOnce(result(2));
  const qc = new QueryClient(), host = document.createElement("div"), tree = createRoot(host);
  let current!: ReturnType<typeof useSvnStatus>;
  function Status() { current = useSvnStatus(); return null; }
  try {
    await act(async () => tree.render(<QueryClientProvider client={qc}><Status/></QueryClientProvider>));
    expect(mocks.status).toHaveBeenCalledWith(false);
    await act(async () => { expect((await current.refresh(true))?.epoch).toBe(2); });
    expect(mocks.status).toHaveBeenLastCalledWith(true);
    await act(async () => { finishOld(result(1)); });
    expect(qc.getQueryData<StatusResult>(["svn-status",work])?.epoch).toBe(2);
  } finally {
    act(() => tree.unmount());
    setSession({root:null});
    qc.clear();
  }
});
