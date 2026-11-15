import { describe, expect, it } from "vitest";
import { retainViewport, visibleRange } from "./scrollViewport";

describe("buffered scroll viewport", () => {
  const initial = { top: 500, left: 300, height: 400, width: 800 };
  it("retains the mounted window for small movements in either direction and axis", () => {
    expect(retainViewport(initial, { ...initial, top: 599, left: 349 }, 200, 100)).toBe(initial);
    expect(retainViewport(initial, { ...initial, top: 401, left: 251 }, 200, 100)).toBe(initial);
  });
  it("publishes exact fractional offsets on boundary crossings, reversal and resize", () => {
    for (const patch of [{ top: 600.5 }, { top: 399.5 }, { left: 350.5 }, { left: 249.5 }, { width: 700 }, { height: 300 }]) {
      const next = { ...initial, ...patch };
      expect(retainViewport(initial, next, 200, 100)).toBe(next);
    }
  });
  it("finds wrapped rows at exact boundaries and keeps both ends bounded", () => {
    const rows = [{ top: 0, height: 20 }, { top: 20, height: 80 }, { top: 100, height: 30 }, { top: 130, height: 20 }];
    expect(visibleRange(rows, 20, 80, 0)).toEqual({ first: 1, last: 3 });
    expect(visibleRange(rows, 145, 300, 20)).toEqual({ first: 2, last: 4 });
    expect(visibleRange([], 0, 300, 20)).toEqual({ first: 0, last: 0 });
  });
});
