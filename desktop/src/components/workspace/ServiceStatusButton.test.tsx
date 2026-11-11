// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ServerStatus } from "../../lib/server";
const query = vi.hoisted(() => ({ data: { state: "running", port: 8080, portOwnedBySelf: true } as ServerStatus, isError: false }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => query }));
import { ServiceStatusButton } from "./ServiceStatusButton";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("顶栏状态采用后端证据，读取失败时不会把缓存的运行状态当作实时状态", async () => {
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(<ServiceStatusButton header />));
    expect(host.textContent).toContain("端口监听中");
    expect(host.querySelector("button")?.title).toContain("8080");
    query.isError = true;
    await act(async () => root.render(<ServiceStatusButton header />));
    expect(host.textContent).toContain("状态未知"); expect(host.textContent).not.toContain("端口监听中");
  } finally { await act(async () => root.unmount()); host.remove(); query.isError = false; }
});
