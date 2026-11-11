// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildCacheInfo } from "../../lib/compile";

const mocks = vi.hoisted(() => ({ info: vi.fn(), history: vi.fn(), askTmp: vi.fn(), cleanTmp: vi.fn(), reindex: vi.fn() }));
vi.mock("../../lib/compile", () => ({ buildCacheInfo: mocks.info, buildHistory: mocks.history }));
vi.mock("../../lib/buildMaintenance", () => ({ askCleanTmp: mocks.askTmp, cleanTmpBuild: mocks.cleanTmp, reindexBuild: mocks.reindex }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));

import { BuildCacheSettings } from "./BuildCacheSettings";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const info = {
  indexBytes: 10, indexFiles: 1, manifestBytes: 2, manifestModules: 1, tmpBytes: 512,
  trackedClasses: 3, untrackedClasses: [], lastSuccessMs: null, lastBuild: null, history: [], parallel: 1,
  worker: { coldStarts: 0, warmHits: 1, fallbackMissing: 0, fallbackSpawn: 0, fallbackProtocol: 0, fallbackOom: 0, timeouts: 0, cancels: 0, trimmed: 0, workerCompiles: 1, workerMsTotal: 12, oneshotCompiles: 0, oneshotMsTotal: 0, latency: [1, 0, 0, 0, 0] },
} as BuildCacheInfo;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.info.mockResolvedValue(info);
  mocks.history.mockResolvedValue([]);
  mocks.askTmp.mockResolvedValue(undefined);
  mocks.reindex.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<BuildCacheSettings persistent />));
  await flush();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("构建缓存维护", () => {
  it("清理临时文件走统一确认入口，不直接删除", async () => {
    await act(async () => button("清理临时文件").click());
    expect(mocks.askTmp).toHaveBeenCalledTimes(1);
    expect(mocks.cleanTmp).not.toHaveBeenCalled();
  });
  it("维护失败后重试重放最近一次动作", async () => {
    await act(async () => button("重建类索引").click());
    mocks.info.mockRejectedValueOnce(new Error("统计读取失败"));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "重建索引")!.click());
    expect(mocks.reindex).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => button("重试").click());
    expect(mocks.reindex).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});