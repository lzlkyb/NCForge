// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * L22 回归：「本需求全部标为已审」的 toast 计数必须等于**真的标了几个**。
 *
 * `markReqAll` 先把整组文件的块标已审，再按三个条件筛出要写文件级标记的 `todo`
 * （可标记 / 还没审 / 全部块都审完）。拿 `reqItems.length` 报数会虚高：
 * 说「已标记 5 个」实际只标了 2 个，用户以为剩下的也审完了。
 */
const h = vi.hoisted(() => ({
  mark: vi.fn(async () => {}),
  toast: vi.fn(),
  items: [] as { path: string; rel: string; module: string; letter: string; status: string; revision: number; isDir: boolean; ignored: boolean }[],
  reviewed: new Set<string>(),
  blocks: new Map<string, { blocks: unknown[]; infos: unknown[]; done: number }>(),
}));

vi.mock("../ui/toast", () => ({ toast: h.toast }));
vi.mock("../../hooks/useSvnStatus", () => ({
  useSvnStatus: () => ({
    info: { data: undefined }, status: { data: { changes: { groups: [{ module: "m", items: h.items }], shown: h.items.length, total: h.items.length, ignored: 0 }, generatedAtMs: 0 }, error: null, isFetching: false },
    reviewed: h.reviewed, mark: h.mark, refresh: vi.fn(async () => undefined), scanProgress: null, streamed: null,
  }),
}));
vi.mock("../../hooks/useSvnChanges", () => ({ useSvnChanges: () => ({ doUpdate: vi.fn(), doCommit: vi.fn(), doRevert: vi.fn(), doResolve: vi.fn(), writeBusy: null }) }));
vi.mock("../../hooks/useReqBlocks", () => ({ useReqBlocks: () => h.blocks, cachedBlocks: () => [] }));
vi.mock("../../lib/reviewSession", () => ({ isBlockReviewed: () => true, markBlocksReviewed: vi.fn() }));
vi.mock("../../lib/requirements", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/requirements")>();
  const view = { reqs: [{ id: "r1", name: "需求一", aliases: [], status: "open", createdMs: 1, packages: [], mergeHint: null }], current: null,
    files: ["A","B","C","D","E"].map(n => ({ path: "C:/w/" + n + ".java", reqs: ["r1"], claimed: true, touches: [] })),
    journal: { dir: null, found: false, lastAtMs: 0, more: false } };
  return { ...orig, useRequirements: () => ({ view, loaded: true, error: null }), getRequirements: () => ({ view, loaded: true, error: null }) };
});
vi.mock("./RightPane", () => ({ RightPane: () => null }));
vi.mock("./SvnToolbar", () => ({ SvnToolbar: () => null }));
vi.mock("./SvnTaskFeedback", () => ({ SvnTaskFeedback: () => null }));
vi.mock("./SvnScanNotice", () => ({ SvnScanNotice: () => null }));
vi.mock("./SvnCommitOutcome", () => ({ SvnCommitOutcome: () => null }));
vi.mock("./SvnCommitDrawer", () => ({ SvnCommitDrawer: () => null, SVN_COMMIT_DRAWER_MIN_WIDTH: 900 }));
vi.mock("./SvnReviewDialogs", () => ({ SvnReviewDialogs: () => null }));
vi.mock("./CommitPanel", () => ({ CommitPanel: () => null }));
vi.mock("./SvnReviewFiles", () => ({ SvnReviewFiles: () => null }));
vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(async () => []) }));

import { SvnReview } from "./SvnReview";
import { setSession } from "../../lib/workspaceSession";
import { setSvnListPrefs } from "../../lib/svnListPrefs";
import { keyOf } from "../../lib/svn";
import { syncSvnDraft } from "../../lib/svnDraft";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const root = "C:\\w";
const item = (name: string, letter = "M") => ({ path: `${root}\\${name}.java`, rel: `${name}.java`, module: "m", letter, status: "modified", revision: 7, isDir: false, ignored: false });
let tree: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  h.reviewed = new Set();
  h.blocks = new Map();
  // A 可标记且未审；B 已审；C 冲突（不可标记）；D 已删除（不可标记）；E 目录
  h.items = [item("A"), item("B"), item("C", "C"), item("D", "D"), { ...item("E"), isDir: true }];
  h.reviewed.add(keyOf(`${root}\\B.java`));
  setSession({ root, tabs: [], activePath: null });
  setSvnListPrefs(root, { groupBy: "req", groupChosen: true, filter: "all", search: "", closed: [] });
  syncSvnDraft(root, h.items as never);
  host = document.createElement("div"); document.body.append(host); tree = createRoot(host);
});
afterEach(() => { act(() => tree.unmount()); host.remove(); });

const paint = async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => tree.render(<QueryClientProvider client={qc}><SvnReview onOpenFile={vi.fn()} /></QueryClientProvider>));
};
/** 打开需求组菜单并点「本需求全部标为已审」。 */
const markAll = async () => {
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="需求操作 需求一"]')!;
  await act(async () => trigger.click());
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.includes("本需求全部标为已审"))!;
  await act(async () => entry.click());
};

it("toast 只数真的写了文件级标记的文件，不把已审/冲突/目录算进去", async () => {
  await paint();
  await markAll();
  expect(h.mark).toHaveBeenCalledTimes(1);
  expect(h.mark).toHaveBeenCalledWith(`${root}\\A.java`, 7, true);
  expect(h.toast).toHaveBeenCalledWith("已标记 1 个文件为已审", "success");
});

it("整组都已审完时不写标记，也不报一个虚高的数字", async () => {
  h.reviewed = new Set(h.items.map(it => keyOf(it.path)));
  await paint();
  await markAll();
  expect(h.mark).not.toHaveBeenCalled();
  expect(h.toast).toHaveBeenCalledWith("已标记 0 个文件为已审", "success");
});
