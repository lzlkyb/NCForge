// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getConfig, patchConfig, toast, buildCacheInfo, buildHistory } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  patchConfig: vi.fn(),
  toast: vi.fn(),
  buildCacheInfo: vi.fn(),
  buildHistory: vi.fn(),
}));

vi.mock("../../lib/appConfig", () => ({
  getConfig,
  patchConfig,
  rememberAutoIncremental: vi.fn(),
  rememberAutoExternal: vi.fn(),
}));
vi.mock("../../lib/compile", () => ({ buildCacheInfo, buildHistory }));
vi.mock("../../lib/buildMaintenance", () => ({ cleanTmpBuild: vi.fn(), reindexBuild: vi.fn() }));
vi.mock("../ui/toast", () => ({ toast }));

import { BuildSettings } from "./BuildSettings";

const cfg = {
  auto_compile_incremental: true,
  auto_compile_external: true,
  prewarm_index: true,
  persistent_worker: true,
  build_parallel: 2,
};

const baseCache = {
  indexBytes: 0, indexFiles: 0, manifestBytes: 0, manifestModules: 0, tmpBytes: 0,
  trackedClasses: 0, untrackedClasses: [], lastSuccessMs: null, lastBuild: null, history: [], parallel: 2,
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const row = () => container.querySelector<HTMLElement>("#build-persistent-worker")!;
const statsRow = () => container.querySelector<HTMLElement>("#build-worker-stats")!;
const switchOf = () => row().querySelector<HTMLButtonElement>('[role="switch"]')!;
const render = () => act(async () => root.render(<BuildSettings />));

beforeEach(() => {
  getConfig.mockResolvedValue({ ...cfg });
  patchConfig.mockImplementation(async patch => ({ ...cfg, ...patch }));
  buildCacheInfo.mockResolvedValue({ ...baseCache });
  buildHistory.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("常驻 ecj 编译进程开关", () => {
  it("默认开：界面显示已开启", async () => {
    await render();
    expect(row().textContent).toContain("保留后台编译进程");
    expect(row().textContent).toContain("已开启");
    expect(switchOf().getAttribute("aria-checked")).toBe("true");
  });

  it("关掉时只提交 persistent_worker，界面随之切到已关闭", async () => {
    await render();
    await act(async () => { switchOf().click(); });
    expect(patchConfig).toHaveBeenCalledWith({ persistent_worker: false });
    expect(row().textContent).toContain("已关闭");
  });

  it("保存失败回滚为已开启并提示", async () => {
    await render();
    patchConfig.mockRejectedValueOnce(new Error("磁盘只读"));
    await act(async () => { switchOf().click(); });
    expect(row().textContent).toContain("已开启");
    expect(row().querySelector('[role="alert"]')?.textContent).toContain("磁盘只读");
    expect(row().textContent).toContain("重试保存");
  });

  it("统计行显示回退、冷启动与耗时分布", async () => {
    buildCacheInfo.mockResolvedValue({
      ...baseCache,
      worker: {
        coldStarts: 1, warmHits: 4, fallbackMissing: 0, fallbackSpawn: 2,
        fallbackProtocol: 0, fallbackOom: 1, timeouts: 1, cancels: 0, trimmed: 0,
        workerCompiles: 4, workerMsTotal: 800, oneshotCompiles: 3, oneshotMsTotal: 3000,
        latency: [2, 3, 1, 1, 0],
      },
    });
    await render();
    const text = statsRow().textContent ?? "";
    expect(text).toContain("复用 4");
    expect(text).toContain("冷启动 1");
    expect(text).toContain("一次一进程 3");
    expect(text).toContain("回退 3");
    expect(text).toContain("超时 1");
    expect(text).toContain("<300ms 3");
    expect(text).not.toContain("≥3s");
    // 右侧均值只看当前生效路径（常驻开 → worker 800ms / 4 次）
    expect(text).toContain("均 200 ms");
  });
});
