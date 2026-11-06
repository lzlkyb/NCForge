// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ path: "D:/p/A.java" }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ activePath: mock.path }) }));
import { claimDebugSourceNavigation, prepareDebugSourceNavigation } from "./debugSourceNavigation";
import { invalidateWorkspaceRequests } from "./workspaceEpoch";
beforeEach(() => { mock.path = "D:/p/A.java"; });
it("claims each fresh pause once and ignores an older target pause", () => {
  prepareDebugSourceNavigation("server", 1); prepareDebugSourceNavigation("server", 2);
  expect(claimDebugSourceNavigation("server", 1)).toBe(false);
  expect(claimDebugSourceNavigation("server", 2)).toBe(true);
  expect(claimDebugSourceNavigation("server", 2)).toBe(false);
});
it("does not claim late frames after an explicit file change or a workspace round trip", () => {
  prepareDebugSourceNavigation("client", 1); mock.path = "D:/p/B.java";
  expect(claimDebugSourceNavigation("client", 1)).toBe(false);
  mock.path = "D:/p/A.java"; prepareDebugSourceNavigation("client", 2); invalidateWorkspaceRequests();
  expect(claimDebugSourceNavigation("client", 2)).toBe(false);
});
