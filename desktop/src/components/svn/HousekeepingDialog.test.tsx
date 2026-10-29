// @vitest-environment jsdom
/**
 * 维护面板的接线（审查报告 P2-18 ⑧⑩）。
 *
 * 这里盯的是三件容易「看着能跑、其实没接上」的事：
 * ① 「全部删除」把**目录名**交给后端（传路径会让后端白名单校验形同虚设）；
 * ② 「清理失效标记」真的调了 `svn_review_prune`（这个命令此前前端零调用方）；
 * ③ 清完标记要通知上层重扫，否则审查进度还是按旧标记算的。
 *
 * 注意 `flush()`：react-query 的状态落地与弹窗的延迟挂载都在微任务之后，
 * 只 `act(async () => {})` 一次时按钮还是上一次渲染的 disabled 态，点它等于没点。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), pruned: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
// 关闭动画走 0ms 分支，测试里不必等 setTimeout(MOTION.exit)
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));

import { HousekeepingDialog } from "./HousekeepingDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO = {
  baseDir: "D:\\NC技术文档\\爱尔文档",
  backups: [
    {
      name: ".ncforge-revert-1761750000000",
      path: "D:\\NC技术文档\\爱尔文档\\.ncforge-revert-1761750000000",
      kind: "revert",
      files: 6,
      bytes: 2_200_000,
      atMs: 1_761_750_000_000,
    },
    {
      name: ".ncforge-resolve-1761749000000",
      path: "D:\\NC技术文档\\爱尔文档\\.ncforge-resolve-1761749000000",
      kind: "resolve",
      files: 3,
      bytes: 19_000,
      atMs: 1_761_749_000_000,
    },
  ],
  totalBytes: 2_219_000,
  reviewTotal: 42,
  reviewValid: 31,
  reviewStale: 11,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** 把微任务与 0ms 定时器都跑完，让 react-query / 延迟挂载的状态真正落到 DOM。 */
const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const buttonByText = (text: string) =>
  [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;

const render = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={qc}>
        <HousekeepingDialog open onClose={() => {}} onPruned={mocks.pruned} />
      </QueryClientProvider>,
    );
  });
  await flush();
};

const click = async (text: string) => {
  const btn = buttonByText(text);
  expect(btn, `找不到按钮「${text}」`).toBeTruthy();
  await act(async () => btn?.click());
  await flush();
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.toast.mockReset();
  mocks.pruned.mockReset();
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "svn_housekeeping") return Promise.resolve(INFO);
    if (cmd === "svn_backup_delete")
      return Promise.resolve({ deleted: 2, bytes: 2_219_000, failed: [] });
    if (cmd === "svn_review_prune") return Promise.resolve(31);
    return Promise.resolve(null);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("HousekeepingDialog", () => {
  it("列出备份目录与审查标记统计", async () => {
    await render();
    const text = document.body.textContent ?? "";
    expect(text).toContain(".ncforge-revert-1761750000000");
    expect(text).toContain(".ncforge-resolve-1761749000000");
    expect(text).toContain("2 个目录");
    expect(text).toContain("共 42 条");
    expect(buttonByText("全部删除")?.disabled).toBe(false);
  });

  it("全部删除把目录名交给后端，不传路径", async () => {
    await render();
    await click("全部删除");
    await click("删除");

    const call = mocks.invoke.mock.calls.find((c) => c[0] === "svn_backup_delete");
    expect(call).toBeTruthy();
    expect(call?.[1]).toEqual({
      names: [".ncforge-revert-1761750000000", ".ncforge-resolve-1761749000000"],
    });
    expect(mocks.toast).toHaveBeenCalled();
  });

  it("部分删除失败时仍报出已删数量与首个失败原因", async () => {
    // 后端改成逐个删、失败不中断：一个目录被占用不能把「已经删掉并释放了多少」
    // 瞒过去，否则用户看到「删除失败」会以为空间没回来。
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "svn_housekeeping") return Promise.resolve(INFO);
      if (cmd === "svn_backup_delete")
        return Promise.resolve({
          deleted: 1,
          bytes: 2_200_000,
          failed: [{ name: ".ncforge-resolve-1761749000000", message: "目录被占用" }],
        });
      return Promise.resolve(null);
    });
    await render();
    await click("全部删除");
    await click("删除");

    // target 是 ES2020，没有 Array.prototype.at
    const calls = mocks.toast.mock.calls;
    const call = calls[calls.length - 1] ?? [];
    expect(String(call[0])).toContain("已删除 1 个");
    expect(String(call[0])).toContain("目录被占用");
    expect(call[1]).toBe("error");
  });

  it("清理失效标记真的调了 svn_review_prune 并通知上层重扫", async () => {
    await render();
    await click("清理失效标记");

    expect(mocks.invoke.mock.calls.some((c) => c[0] === "svn_review_prune")).toBe(true);
    expect(mocks.pruned).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalled();
  });
});
