import { describe, expect, it } from "vitest";
import { gridSelectionCell, gridSelectionHeading } from "./gridSelection";
describe("logical grid selection perimeter", () => {
  const bounds={rowStart:10,rowEnd:1000,colStart:2,colEnd:80};
  it("marks only true logical edges, including reversed/cross-screen ranges",()=>{
    expect(gridSelectionCell(bounds,10,2,false)["data-range-edges"]).toBe("top left");
    expect(gridSelectionCell(bounds,1000,80,false)["data-range-edges"]).toBe("bottom right");
    // First rendered row/column can be deep inside the range; it is not a perimeter.
    expect(gridSelectionCell(bounds,500,40,false)["data-range-edges"]).toBeUndefined();
    expect(gridSelectionCell(bounds,500,40,false)["data-cell"]).toBe(true);
    expect(gridSelectionCell(bounds,500,1,false)["data-cell"]).toBeUndefined();
  });
  it("retains one active cell and independent row/column heading state",()=>{
    expect(gridSelectionCell(bounds,1000,80,true)["data-active-cell"]).toBe(true);
    expect(gridSelectionCell(bounds,999,80,false)["data-active-cell"]).toBeUndefined();
    expect(gridSelectionHeading(bounds,40,"column")).toBe(true);
    expect(gridSelectionHeading(bounds,9,"row")).toBeUndefined();
    expect(gridSelectionHeading(null,10,"row")).toBeUndefined();
  });
  it("a single cell receives all four edges without losing active semantics",()=>{
    expect(gridSelectionCell({rowStart:0,rowEnd:0,colStart:0,colEnd:0},0,0,true)).toEqual({"data-cell":true,"aria-selected":true,"data-range-edges":"top bottom left right","data-active-cell":true});
  });
});
