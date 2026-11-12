import { describe, expect, it } from "vitest";
import { nextSvnUnreviewed, svnFilterCounts, svnVisibleGroups } from "./svnList";
import { keyOf, type ChangeItem } from "./svn";
const item = (name: string, mtimeMs: number, letter: ChangeItem["letter"] = "M"): ChangeItem => ({ path: `C:/work/${name}.java`, rel: `${name}.java`, module: "module", mtimeMs, letter, revision: 1, status: "modified", isDir: false, ignored: false });
describe("SVN visible review queue", () => {
  it("uses filtered time order and never jumps into hidden files", () => {
    const [a,b,c] = [item("A",1),item("B",3),item("Other",2)];
    const groups = svnVisibleGroups({ groups: [{ module: "module", items: [a,b,c] }], total: 3, shown: 3, ignored: 0 }, "all", ".java", "mtime", false, new Set(), new Set());
    expect(groups[0].items.map(it => it.rel)).toEqual(["B.java","Other.java","A.java"]);
    const filtered = groups[0].items.filter(it => it.path !== c.path);
    expect(nextSvnUnreviewed(filtered,b.path,new Set(),b.path)?.path).toBe(a.path);
    expect(nextSvnUnreviewed(filtered,a.path,new Set([keyOf(b.path)]),a.path)).toBeNull();
  });
  it("separates outdated from never-reviewed files and follows the filtered queue", () => {
    const a = item("A",1), b = item("B",2), c = item("C",3);
    const items = [a,b,c], picked = new Set<string>(), reviewed = new Set<string>();
    const outdated = new Set([keyOf(a.path), keyOf(b.path)]);
    const view = { groups:[{ module:"module",items }], total:3, shown:3, ignored:0 };
    const visible = (filter: "outdated" | "unreviewed") =>
      svnVisibleGroups(view,filter,"","path",false,reviewed,picked,outdated).flatMap(group => group.items);
    expect(svnFilterCounts(items,reviewed,picked,outdated)).toMatchObject({outdated:2,unreviewed:1});
    expect(visible("unreviewed")).toEqual([c]);
    expect(nextSvnUnreviewed(visible("outdated"),a.path,reviewed,a.path)).toBe(b);
    reviewed.add(keyOf(a.path));
    expect(visible("outdated")).toEqual([b]);
  });
  it("skips deleted, conflict and already reviewed entries", () => {
    const a = item("A",1), d = item("D",2,"D"), c = item("C",3,"C"), b = item("B",4);
    expect(nextSvnUnreviewed([a,d,c,b],a.path,new Set([keyOf(a.path)]))?.path).toBe(b.path);
  });
});
