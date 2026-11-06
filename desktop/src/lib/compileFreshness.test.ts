import { describe, expect, it } from "vitest";
import { captureCompileSources, stampCompileResult } from "./compileFreshness";
import { mergeFileResult, mergeModuleResult } from "./autoCompile";
import type { CompileResult, ModuleBuildResult } from "./compile";
const result = (): CompileResult => ({ ok: true, problems: [], diagnostics: [], sourceCount: 1, errorCount: 0, warningCount: 0, durationMs: 1, jarCount: 0, rounds: 1, outDir: "classes" });
const module = (name: string, status: ModuleBuildResult["status"] = "ok"): ModuleBuildResult => ({ module: name, status, errorCount: 0, warningCount: 0, durationMs: 1, sourceCount: 1, outDir: "classes", cleaned: 0, reason: null });
describe("compile freshness", () => {
  it("captures disk versions before a save during the build", () => {
    const tabs = [{ path: "D:/p/gl/src/A.java", mtimeMs: 10 }];
    const captured = captureCompileSources(tabs); tabs[0].mtimeMs = 20;
    const stamped = stampCompileResult(result(), captured, "D:/p", undefined, 123);
    expect(stamped.completedAtMs).toBe(123);
    expect(stamped.sourceSnapshots?.["d:/p/gl/src/a.java"]).toEqual({ mtimeMs: 10, atMs: 123 });
  });
  it("file builds leave other files' older snapshot times intact", () => {
    const captured = { "d:/p/gl/src/a.java": 10, "d:/p/gl/src/b.java": 11 };
    const previous = stampCompileResult(result(), captured, "D:/p", undefined, 100);
    const next = stampCompileResult(result(), { ...captured, "d:/p/gl/src/a.java": 20 }, "D:/p", ["D:/p/gl/src/A.java"], 200);
    const merged = mergeFileResult(previous, next, ["D:/p/gl/src/A.java"]);
    expect(merged.sourceSnapshots).toEqual({ "d:/p/gl/src/a.java": { mtimeMs: 20, atMs: 200 }, "d:/p/gl/src/b.java": { mtimeMs: 11, atMs: 100 } });
  });
  it("module rebuilds stamp only rebuilt modules and preserve untouched versions", () => {
    const captured = { "d:/p/gl/src/a.java": 10, "d:/p/ar/src/b.java": 11, "d:/other/gl/src/a.java": 40 };
    const previous = stampCompileResult(result(), captured, "D:/p", undefined, 100);
    const next = stampCompileResult({ ...result(), modules: [module("gl"), module("ar", "skipped")] }, captured, "D:/p", undefined, 200);
    expect(Object.keys(next.sourceSnapshots ?? {})).toEqual(["d:/p/gl/src/a.java"]);
    const merged = mergeModuleResult(previous, next, "D:/p");
    expect(merged.sourceSnapshots?.["d:/p/ar/src/b.java"].atMs).toBe(100);
  });
});
