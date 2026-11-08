import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ models: [] as Array<[string, any]>, provider: null as null | (() => any[]) }));
vi.mock("./editorStore", () => ({ forEachDirtyModel: (visit: any) => state.models.forEach(([path, model]) => visit(path, model)) }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: "C:/work" }) }));
vi.mock("./search", () => ({ setOverlayProvider: (provider: any) => { state.provider = provider; } }));
import { installSearchOverlay } from "./searchOverlay";

beforeEach(() => { state.models = []; installSearchOverlay(); });
function model(text: string) {
  return { getValueLength: vi.fn(() => text.length), getVersionId: vi.fn(() => 1), getValue: vi.fn(() => text) };
}
it("reuses text for the same version and refreshes after an edit", () => {
  const m = model("old"); state.models = [["C:/work/a.java", m]];
  expect(state.provider!()).toEqual([expect.objectContaining({ path: "a.java", text: "old" })]);
  state.provider!(); expect(m.getValue).toHaveBeenCalledTimes(1);
  m.getVersionId.mockReturnValue(2); m.getValue.mockReturnValue("new");
  expect(state.provider!()[0].text).toBe("new");
  expect(m.getValue).toHaveBeenCalledTimes(2);
});
it("does not reuse text across replacement models with the same version", () => {
  state.models = [["C:/work/a.java", model("old")]]; state.provider!();
  state.models = [["C:/work/a.java", model("new")]];
  expect(state.provider!()[0].text).toBe("new");
});
it("skips oversized and out-of-workspace models before reading text", () => {
  const large = model("x"); large.getValueLength.mockReturnValue(200001);
  const outside = model("outside");
  state.models = [["C:/work/a.java", large], ["C:/other/a.java", outside]];
  expect(state.provider!()).toEqual([]);
  expect(large.getValue).not.toHaveBeenCalled(); expect(outside.getValue).not.toHaveBeenCalled();
});
