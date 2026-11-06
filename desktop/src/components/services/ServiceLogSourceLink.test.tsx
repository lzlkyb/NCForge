// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypeHit } from "../../lib/typeSearch";
import { invalidateWorkspaceRequests } from "../../lib/workspaceEpoch";

const mocks = vi.hoisted(() => ({ find: vi.fn(), open: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/serviceLogSource", () => ({
  stackLocation: () => ({ className: "nc.Start", file: "Start.java", line: 42 }),
  findStackSources: mocks.find,
  openStackSource: mocks.open,
}));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../ui/Modal", () => ({ Modal: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null }));

import { ServiceLogSourceLink } from "./ServiceLogSourceLink";

const hit = (module: string): TypeHit => ({ name: "nc.Start", simple: "Start", package: "nc", kind: 5, file: `D:/${module}/Start.java`, module, jar: "", line: 1, column: 1 });
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<ServiceLogSourceLink text="at nc.Start.main(Start.java:42)" />));
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });
const find = async () => { await act(async () => { document.querySelector<HTMLButtonElement>(".sc-log-source")!.click(); }); };
const choose = () => act(() => { document.querySelector<HTMLButtonElement>(".sc-log-source-choices button")!.click(); });

describe("堆栈源码选择的工程身份", () => {
  it("当前工程的多命中选择定位到正确行", async () => {
    mocks.find.mockResolvedValue([hit("module-a"), hit("module-b")]);
    await find(); choose();
    expect(mocks.open).toHaveBeenCalledWith(hit("module-a"), { className: "nc.Start", file: "Start.java", line: 42 });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("选择弹窗打开后切工程，拒绝旧源码并关闭弹窗", async () => {
    mocks.find.mockResolvedValue([hit("module-a"), hit("module-b")]);
    await find(); invalidateWorkspaceRequests(); choose();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("工程已切换，请重新定位源码", "info");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("定位请求在途时切工程，不显示旧命中选择", async () => {
    let resolve!: (hits: TypeHit[]) => void;
    mocks.find.mockImplementation(() => new Promise<TypeHit[]>(done => { resolve = done; }));
    await find(); invalidateWorkspaceRequests();
    await act(async () => { resolve([hit("module-a"), hit("module-b")]); });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
