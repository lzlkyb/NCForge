import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("./tauri", () => mocks);
import { runWorkspaceSearch } from "./searchRunner";
import { cancelWorkspaceSearch, getSearchForm, resetSearchForm, setSearchForm } from "./searchStore";
import { setOverlayProvider, type SearchOutcome } from "./search";

const hit = { path: "A.java", line: 4, text: "save", ranges: [{ start: 0, end: 4 }] };
const outcome = (over = {}): SearchOutcome => ({ hits: [hit], filesMatched: 1, filesScanned: 2,
  elapsedMs: 8, truncated: false, scopeDirs: [], missingDirs: [], scopeFallback: false, ...over });
type Pending = { args: { stream: string; source: string; options: unknown }; resolve: (value: unknown) => void };
let pending: Pending[], handlers: Map<string, (batch: unknown) => void>;
beforeEach(() => {
  vi.useFakeTimers(); resetSearchForm();
  setSearchForm({ query: "save", scope: "current", include: "", regex: false });
  pending = []; handlers = new Map(); mocks.invoke.mockReset(); mocks.listen.mockReset();
  mocks.listen.mockImplementation(async (event, handler) => { handlers.set(event, handler); return () => {}; });
  mocks.invoke.mockImplementation((command, args) => command === "search_cancel" ? Promise.resolve() :
    new Promise(resolve => pending.push({ args, resolve })));
});
afterEach(() => { resetSearchForm(); setOverlayProvider(null); vi.useRealTimers(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

it("publishes current batches, replaces previews with final results and ignores delayed batches", async () => {
  const run = runWorkspaceSearch("D:/primary"); await flush();
  const request = pending[0];
  handlers.get("search:batch")!({ stream: "obsolete", hits: [hit] });
  await vi.advanceTimersByTimeAsync(60); expect(getSearchForm().outcome).toBeNull();
  handlers.get("search:batch")!({ stream: request.args.stream, hits: [hit] });
  await vi.advanceTimersByTimeAsync(60);
  expect(getSearchForm()).toMatchObject({ running: true, outcome: { hits: [hit] }, outcomeOptions: null });
  request.resolve(outcome()); await run;
  handlers.get("search:batch")!({ stream: request.args.stream, hits: [hit] });
  await vi.advanceTimersByTimeAsync(60);
  expect(getSearchForm().outcome?.hits).toHaveLength(1);
  expect(getSearchForm().outcomeOptions?.text).toBe("save");
});

it("a successor cancels only its predecessor; old completion never overwrites the current query", async () => {
  const old = runWorkspaceSearch("D:/primary"); await flush();
  setSearchForm({ query: "new" }); const next = runWorkspaceSearch("D:/primary"); await flush();
  expect(mocks.invoke).toHaveBeenCalledWith("search_cancel", { source: pending[0].args.source });
  expect(pending[0].args.source).not.toBe(pending[1].args.source);
  pending[1].resolve(outcome({ hits: [{ ...hit, text: "new" }] })); await next;
  pending[0].resolve(outcome()); await old;
  expect(getSearchForm().outcome?.hits[0].text).toBe("new");
});

it("cancel and workspace reset reject old batches, final results and replacement eligibility", async () => {
  const run = runWorkspaceSearch("D:/primary"); await flush();
  handlers.get("search:batch")!({ stream: pending[0].args.stream, hits: [hit] });
  await vi.advanceTimersByTimeAsync(60); cancelWorkspaceSearch();
  expect(getSearchForm()).toMatchObject({ running: false, outcome: { cancelled: true }, outcomeOptions: null });
  resetSearchForm(); pending[0].resolve(outcome()); await run;
  expect(getSearchForm().outcome).toBeNull();
});

it("cancel during listener setup prevents a scanner from starting after the palette closes", async () => {
  let ready: (value: () => void) => void = () => {};
  mocks.listen.mockReturnValue(new Promise(resolve => { ready = resolve; }));
  const run = runWorkspaceSearch("D:/primary"); cancelWorkspaceSearch(); ready(() => {}); await run;
  expect(pending).toHaveLength(0); expect(getSearchForm().running).toBe(false);
});

it("groups identical relative paths by project and sends the primary overlay to all-project IPC", async () => {
  const doc = { path: "A.java", text: "unsaved", revision: "runner-all-v1" };
  setOverlayProvider(() => [doc]); setSearchForm({ scope: "all" });
  const run = runWorkspaceSearch("D:/primary"); await flush();
  expect(pending[0].args.options).toMatchObject({ overlay: [doc] });
  const batch = handlers.get("search:projects-batch")!;
  for (const root of ["D:/primary", "D:/associated"]) batch({ stream: pending[0].args.stream, root, project: root, hits: [hit] });
  await vi.advanceTimersByTimeAsync(60);
  expect(getSearchForm().projectOutcome?.projects.map(project => project.root)).toEqual(["D:/primary", "D:/associated"]);
  pending[0].resolve({ projects: [{ project: "primary", root: "D:/primary", outcome: outcome() }], errors: [], elapsedMs: 9, truncated: false });
  await run; expect(getSearchForm().projectOutcome?.projects).toHaveLength(1);
  expect(getSearchForm().outcomeOptions).toBeNull();
});

it("a truncated or cancelled final result can never be used for replacement", async () => {
  for (const over of [{ truncated: true }, { cancelled: true }]) {
    const run = runWorkspaceSearch("D:/primary"); await flush(); pending[pending.length - 1].resolve(outcome(over)); await run;
    expect(getSearchForm().outcomeOptions).toBeNull();
  }
});
