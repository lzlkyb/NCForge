import { describe, expect, it } from "vitest";
import { changedSincePackage, fileSource, groupByRequirement, journalHint } from "./reqGroups";
import type { ChangeItem } from "./svn";
import type { ReqView, Requirement, Touch } from "./requirements";

const item = (path: string): ChangeItem => ({
  path, rel: path.replace("C:/w/", ""), module: "pu", letter: "M", status: "modified",
  revision: 1, isDir: false, ignored: false,
});
const req = (id: string, extra: Partial<Requirement> = {}): Requirement => ({
  id, name: `需求${id}`, aliases: [], status: "open", createdMs: 1, packages: [], mergeHint: null, ...extra,
});
const touch = (req: string | null, atMs: number, source: Touch["source"] = "ai"): Touch => ({ req, atMs, source, op: "edit", seq: atMs });

const view: ReqView = {
  reqs: [req("a"), req("b"), req("c", { status: "closed" }), req("d")],
  current: null,
  files: [
    { path: "C:/w/A.java", reqs: ["a"], claimed: false, touches: [touch("a", 10)] },
    { path: "C:/w/Mix.java", reqs: ["a", "b"], claimed: false, touches: [touch("a", 11), touch("b", 50)] },
    { path: "C:/w/Closed.java", reqs: ["c"], claimed: false, touches: [touch("c", 12)] },
    { path: "C:/w/Ai.java", reqs: [], claimed: false, touches: [touch(null, 13)] },
    { path: "C:/w/Gone.java", reqs: ["d"], claimed: false, touches: [touch("d", 14)] },
  ],
  journal: { dir: "x", found: true, lastAtMs: 50, more: false },
};

describe("按需求分组", () => {
  it("混改在两个需求下各出现一次_关闭的需求与不在 SVN 里的文件不显示_按最近改动排序", () => {
    const items = ["C:/w/A.java", "c:/W/mix.java", "C:/w/Closed.java", "C:/w/Ai.java", "C:/w/Hand.java"].map(item);
    const { groups, unclaimed } = groupByRequirement(items, view);
    expect(groups.map((g) => g.req.id)).toEqual(["b", "a"]);
    expect(groups[1].items.map((i) => i.path)).toEqual(["C:/w/A.java", "c:/W/mix.java"]);
    expect(groups[1].mixed.get("c:/w/mix.java")).toEqual(["b"]);
    expect(unclaimed.map((i) => i.path)).toEqual(["C:/w/Closed.java", "C:/w/Ai.java", "C:/w/Hand.java"]);
  });

  it("未认领来源与出包后又改", () => {
    expect(fileSource(view, "C:/w/Ai.java")).toBe("ai");
    expect(fileSource(view, "C:/w/None.java")).toBe("unknown");
    const packed: ReqView = { ...view, reqs: view.reqs.map((r) => (r.id === "a" ? { ...r, packages: [{ zip: "x.zip", atMs: 10 }] } : r)) };
    const g = groupByRequirement([item("C:/w/A.java"), item("C:/w/Mix.java")], packed).groups.find((x) => x.req.id === "a")!;
    expect(changedSincePackage(g, packed)).toBe(1);
    expect(changedSincePackage(groupByRequirement([item("C:/w/Mix.java")], view).groups[0], view)).toBeNull();
  });

  it("变更日志提示", () => {
    expect(journalHint(view, false)).toBeNull();
    expect(journalHint({ ...view, journal: { ...view.journal, found: false } }, true)).toBe("off");
    expect(journalHint({ ...view, journal: { ...view.journal, lastAtMs: 0 } }, true)).toBe("empty");
    expect(journalHint(view, true)).toBeNull();
  });
});
