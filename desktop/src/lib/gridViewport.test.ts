import { describe, it, expect } from "vitest";
import { columnViewport, selectionBounds } from "./gridViewport";
describe("wide result viewport", () => {
  it("renders only intersecting columns and retains frozen columns with stable logical indices", () => {
    const visible=Array.from({length:200},(_,i)=>i), widths=visible.map(()=>100);
    const result=columnViewport(visible,widths,new Set([0,1]),5000,600,40);
    expect(result.length).toBeLessThan(15);
    expect(result.slice(0,2).map(c=>c.column)).toEqual([0,1]);
    expect(result[1].sticky).toBe(140);
    expect(result.some(c=>c.column===50 && c.index===50 && c.left===5040)).toBe(true);
    expect(result.some(c=>c.column===190)).toBe(false);
  });
  it("computes reversed selection bounds in displayed order without allocating selected rows", () => {
    expect(selectionBounds([4,2,7],[3,1,9],{anchor:{r:7,c:9},end:{r:4,c:1}})).toEqual({rowStart:0,rowEnd:2,colStart:1,colEnd:2});
    expect(selectionBounds([4],[3],{anchor:{r:0,c:3},end:{r:4,c:3}})).toBeNull();
  });
});
