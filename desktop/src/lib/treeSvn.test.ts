import { describe, expect, it } from "vitest";
import { treeSvnIndex } from "./treeSvn";
import type { ChangeItem } from "./svn";

const item = (path: string, patch: Partial<ChangeItem> = {}): ChangeItem => ({ path, letter: "M", isDir: false, ignored: false, rel: path, module: "ic", revision: 1, status: "modified", ...patch });
describe("file-tree SVN status", () => {
  it("normalizes paths, aggregates directories and excludes adjacent workspaces", () => {
    const result = treeSvnIndex("C:\\Work\\NC", [item("c:/work/nc/ic/A.java"), item("C:/WORK/NC/ic/A.java"), item("C:/work/nc-other/B.java"), item("C:/work/nc/ic/out/A.class", { ignored: true })]);
    expect(result.files.size).toBe(1);
    expect(result.files.get("c:/work/nc/ic/a.java")).toBe("M");
    expect(result.directories.get("c:/work/nc/ic")).toBe(1);
    expect(result.directories.get("c:/work/nc")).toBe(1);
  });
  it("clears badges after a successful scan with no remaining changes", () => {
    expect(treeSvnIndex("C:/nc", []).files.size).toBe(0);
  });
});
