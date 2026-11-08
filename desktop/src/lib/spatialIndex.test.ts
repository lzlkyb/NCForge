import { expect, it } from "vitest";
import { spatialIndex } from "./spatialIndex";
it("matches brute-force intersection for a thousand objects including crossing edges", () => {
  const entries = Array.from({ length: 1000 }, (_, id) => ({ id, left: id * 13 % 2000, top: id * 29 % 2000, right: id * 13 % 2000 + 244, bottom: id * 29 % 2000 + 150 }));
  const query = spatialIndex(entries);
  for (let i = 0; i < 20; i++) {
    const b = { left: i * 71, top: i * 37, right: i * 71 + 600, bottom: i * 37 + 320 };
    expect(query(b)).toEqual(new Set(entries.filter(e => e.left <= b.right && e.right >= b.left && e.top <= b.bottom && e.bottom >= b.top).map(e => e.id)));
  }
  expect(spatialIndex([])({ left: 0, top: 0, right: 10, bottom: 10 }).size).toBe(0);
});
