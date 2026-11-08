// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: api.invoke }));
import { __resetDbForTest, columnsOf, forgetColumns } from "./dbStore";
beforeEach(() => { __resetDbForTest(); api.invoke.mockReset(); api.invoke.mockResolvedValue({ columns: [] }); });
it("evicts least recently used tables and clears connection entries", async () => {
  for (let i = 0; i < 256; i++) await columnsOf("a", `t${i}`);
  await columnsOf("a", "t0"); await columnsOf("a", "extra");
  const calls = api.invoke.mock.calls.length;
  await columnsOf("a", "t0"); expect(api.invoke).toHaveBeenCalledTimes(calls);
  await columnsOf("a", "t1"); expect(api.invoke).toHaveBeenCalledTimes(calls + 1);
  forgetColumns("a"); await columnsOf("a", "t0"); expect(api.invoke).toHaveBeenCalledTimes(calls + 2);
});
it("does not retain a single oversized table", async () => {
  api.invoke.mockResolvedValue({ columns: [{ name: "x".repeat(5 * 1024 * 1024) }] });
  await columnsOf("a", "large"); await columnsOf("a", "large"); expect(api.invoke).toHaveBeenCalledTimes(2);
});
it("an old rejected request cannot delete its replacement", async () => {
  let reject!: (reason: Error) => void;
  api.invoke.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const old = columnsOf("a", "t"); forgetColumns("a");
  const replacement = columnsOf("a", "t"); await replacement;
  reject(new Error("old")); await expect(old).rejects.toThrow("old");
  expect(columnsOf("a", "t")).toBe(replacement);
});
