import { describe, expect, it } from "vitest";
import { seekPage, type PageAnchor } from "./tablePaging";
const previous: PageAnchor = {key:"q",page:3,columns:[{name:"ID",type:"NUMBER",precision:28,scale:0},{name:"CODE",type:"VARCHAR2",precision:40,scale:0}],rows:[["9007199254740993","A"],["9007199254740994","B"]]};
describe("primary key seek pagination", () => {
  it("binds composite key lexicographic boundary without rounding numeric strings", () => {
    const result = seekPage("bd_x","dr = ?",["id","code"],"q",4,previous)!;
    expect(result.sql).toContain("(dr = ?) and ((id > ?) or (id = ? and code > ?))");
    expect(result.params).toEqual([{number:"9007199254740994"},{number:"9007199254740994"},"B"]);
    expect(result.sql).toContain("order by id asc, code asc");
  });
  it("previous page seeks before first row and requests reversed delivery", () => {
    const result = seekPage("bd_x","",["id"],"q",2,previous)!;
    expect(result.params).toEqual([{number:"9007199254740993"}]);
    expect(result.reverse).toBe(true); expect(result.sql).toContain("order by id desc");
  });
  it("falls back for random jumps, changed filters, missing and null keys or unsafe identifiers", () => {
    expect(seekPage("bd_x","",["id"],"q",8,previous)).toBeNull();
    expect(seekPage("bd_x","",["id"],"changed",4,previous)).toBeNull();
    expect(seekPage("bd_x","",["other"],"q",4,previous)).toBeNull();
    expect(seekPage("bd_x","",["id desc"],"q",4,previous)).toBeNull();
    expect(seekPage("bd_x","",["id"],"q",4,{...previous,rows:[[null,"A"]]})).toBeNull();
  });
});
