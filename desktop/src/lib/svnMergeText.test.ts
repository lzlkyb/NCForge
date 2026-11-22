import { describe, expect, it } from "vitest";
import { acceptSvnConflictBlock, remainingSvnConflictMarkers } from "./svnMergeText";

describe("SVN conflict block merging", () => {
  const block = "<<<<<<< .mine\nlocal\n||||||| .r1\nbase\n=======\nremote\n>>>>>>> .r2\n";
  it("preserves common text and the next conflict when applying either side", () => {
    const text = "common\n" + block + "between\n" + block + "end";
    const merged = acceptSvnConflictBlock(text,"theirs")!;
    expect(merged).toBe("common\nremote\nbetween\n" + block + "end");
    expect(remainingSvnConflictMarkers(merged)).toBe(1);
    expect(acceptSvnConflictBlock(merged,"both")).toBe("common\nremote\nbetween\nlocal\nremote\nend");
  });
  it("refuses damaged markers and keeps a marker-only result blocked", () => {
    expect(acceptSvnConflictBlock("<<<<<<< .mine\nmine\n=======\ntheirs\n","mine")).toBeNull();
    expect(remainingSvnConflictMarkers("a\n>>>>>>> .r8\n")).toBe(1);
    expect(remainingSvnConflictMarkers("a\n=======literal\n")).toBe(0);
  });
});
