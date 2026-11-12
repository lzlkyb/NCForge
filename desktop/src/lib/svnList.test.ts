import { describe, expect, it } from "vitest";
import { mergeStreamedItems, nextSvnUnreviewed, svnFilterCounts, svnVisibleGroups, viewCounts } from "./svnList";
import { keyOf, type ChangeItem, type ChangesView } from "./svn";
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
describe("流式上屏的条目合并", () => {
  const of = (module: string, name: string, ignored = false): ChangeItem =>
    ({ ...item(name, 1), path: `C:/work/${module}/${name}.java`, rel: `${module}/${name}.java`, module, ignored });
  const view = (groups: ChangesView["groups"]): ChangesView => ({ groups, ...viewCounts(groups) });
  it("同模块追加、新模块建组，计数立刻跟上", () => {
    const first = view([{ module: "pu", items: [of("pu", "A")] }]);
    const merged = mergeStreamedItems(first, [of("pu", "B")]);
    expect(merged.groups.map(g => g.module)).toEqual(["pu"]);
    expect(merged.groups[0].items.map(it => it.rel)).toEqual(["pu/A.java", "pu/B.java"]);
    expect(merged).toMatchObject({ total: 2, shown: 2, ignored: 0 });
    const more = mergeStreamedItems(merged, [of("ic", "C"), of("pu", "D")]);
    expect(more.groups.map(g => g.module)).toEqual(["pu", "ic"]);
    expect(more.groups[0].items).toHaveLength(3);
    expect(more).toMatchObject({ total: 4, shown: 4 });
  });
  it("计数口径与后端一致：构建产物计入 total 不计入 shown", () => {
    const merged = mergeStreamedItems(view([]), [of("out", "A.class", true), of("pu", "B")]);
    expect(merged).toMatchObject({ total: 2, shown: 1, ignored: 1 });
  });
  it("同路径后者替换前者：根层与模块层重复报的目录只留一行", () => {
    const dir = of("pu", "pu", false);
    const seeded = mergeStreamedItems(view([]), [of("pu", "A"), dir]);
    const again = mergeStreamedItems(seeded, [{ ...dir, revision: 99 }]);
    expect(again.groups[0].items).toHaveLength(2);
    expect(again.groups[0].items.find(it => it.path === dir.path)?.revision).toBe(99);
    // 增量刷新：先种缓存清单，脏模块的新条目盖掉同一路径的旧条目
    const stale = of("pu", "A");
    const fresh = { ...stale, revision: 42 };
    const after = mergeStreamedItems(view([{ module: "pu", items: [stale] }]), [fresh]);
    expect(after.groups[0].items).toHaveLength(1);
    expect(after.groups[0].items[0].revision).toBe(42);
  });
  it("不改动传入的 view（React 状态下每次合并都必须是新对象）", () => {
    const base = view([{ module: "pu", items: [of("pu", "A")] }]);
    const snapshot = JSON.stringify(base);
    mergeStreamedItems(base, [of("pu", "B")]);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
