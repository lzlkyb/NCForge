import { afterEach, expect, it, vi } from "vitest";
import { cachedChanged, computeModelChanged } from "./changedLinesCompute";
import { computeChanged } from "./changedLines";

const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { workers.push(this); }
}
const makeModel = () => ({ getVersionId: vi.fn(() => 1), getValue: vi.fn(() => "new"), isDisposed: vi.fn(() => false) });
afterEach(() => { workers.length = 0; vi.unstubAllGlobals(); vi.useRealTimers(); });

it("runs diff in a worker, reuses matching model versions, and invalidates on content or baseline changes", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const model = makeModel(), signal = new AbortController().signal;
  const pending = computeModelChanged(model, "old", signal);
  expect(workers).toHaveLength(1);
  expect(workers[0].postMessage).toHaveBeenCalledWith({ base: "old", text: "new" });
  const snapshot = computeChanged("old", "new");
  workers[0].onmessage!({ data: snapshot });
  expect(await pending).toBe(snapshot);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(await computeModelChanged(model, "old", signal)).toBe(snapshot);
  expect(workers).toHaveLength(1);
  expect(model.getValue).toHaveBeenCalledOnce();
  expect(cachedChanged(model, "different BASE")).toBeUndefined();
  model.getVersionId.mockReturnValue(2);
  expect(cachedChanged(model, "old")).toBeUndefined();
});

it("terminates stale work and never caches a result after switching away", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const model = makeModel(), controller = new AbortController();
  const pending = computeModelChanged(model, "old", controller.signal);
  controller.abort();
  expect(await pending).toBeNull();
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  workers[0].onmessage!({ data: computeChanged("old", "new") });
  expect(cachedChanged(model, "old")).toBeUndefined();
});

it.each(["edited", "disposed"])("discards a finished worker result when the model is %s", async reason => {
  vi.stubGlobal("Worker", FakeWorker);
  const model = makeModel();
  const pending = computeModelChanged(model, "old", new AbortController().signal);
  if (reason === "edited") model.getVersionId.mockReturnValue(2);
  else model.isDisposed.mockReturnValue(true);
  workers[0].onmessage!({ data: computeChanged("old", "new") });
  expect(await pending).toBeNull();
});

it("yields before fallback and cancels it on abort", async () => {
  vi.useFakeTimers(); vi.stubGlobal("Worker", undefined);
  const model = makeModel(), controller = new AbortController();
  const pending = computeModelChanged(model, "old", controller.signal);
  expect(model.getValue).not.toHaveBeenCalled();
  controller.abort(); await vi.runAllTimersAsync();
  expect(await pending).toBeNull(); expect(model.getValue).not.toHaveBeenCalled();
  const fallback = computeModelChanged(model, "old", new AbortController().signal);
  await vi.runAllTimersAsync(); expect(await fallback).toEqual(computeChanged("old", "new"));
});
