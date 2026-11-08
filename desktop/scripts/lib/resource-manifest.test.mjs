import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
test("resource manifests retain Windows and both Mac architecture variants", () => {
  const root = mkdtempSync(join(tmpdir(), "ncforge-manifest-"));
  try {
    for (const dir of ["scripts", "src-tauri", "dist/resource-packs"]) mkdirSync(join(root, dir), { recursive: true });
    copyFileSync(fileURLToPath(new URL("../generate-resources-json.mjs", import.meta.url)), join(root, "scripts/generate-resources-json.mjs"));
    writeFileSync(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "1.0.0" }));
    const pack = (platform, arch) => ({ id: "ncdb", platforms: [platform], architectures: [arch], version: "abc", sha256: "a".repeat(64), size: 100, url: `https://example.test/ncdb-${platform}-${arch}.zip`, file: `ncdb-${platform}-${arch}.zip` });
    writeFileSync(join(root, "base.json"), JSON.stringify({ packs: [pack("macos", "aarch64"), pack("macos", "x86_64")] }));
    writeFileSync(join(root, "dist/resource-packs/manifest.json"), JSON.stringify({ packs: [pack("windows", "x86_64")] }));
    const result = spawnSync(process.execPath, [join(root, "scripts/generate-resources-json.mjs")], { env: { ...process.env, RESOURCES_MERGE_INTO: join(root, "base.json"), RESOURCES_OUTPUT_FILENAME: "resources.json" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const output = JSON.parse(readFileSync(join(root, "dist/resources.json"), "utf8"));
    assert.equal(output.packs.length, 3);
    assert.equal(new Set(output.packs.map(p => p.url)).size, 3);
    assert.deepEqual(output.packs.filter(p => p.platforms.includes("macos")).map(p => p.architectures[0]).sort(), ["aarch64", "x86_64"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

