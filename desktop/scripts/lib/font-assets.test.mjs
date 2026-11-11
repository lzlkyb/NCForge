import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../../", import.meta.url);
test("离线字体文件完整，CSS 引用、清单哈希与许可证一致", () => {
  const manifest = JSON.parse(readFileSync(new URL("public/licenses/fonts/manifest.json", root), "utf8"));
  const css = readFileSync(new URL("src/fonts.css", root), "utf8");
  assert.equal(manifest.license, "SIL Open Font License 1.1");
  assert.equal(manifest.assets.length, 103);
  assert.equal(readdirSync(new URL("src/assets/fonts/", root)).length, manifest.assets.length);
  assert.equal(/url\(["']?https?:/.test(css), false);
  let total = 0;
  for (const asset of manifest.assets) {
    const bytes = readFileSync(new URL(`src/assets/fonts/${asset.file}`, root));
    assert.equal(bytes.subarray(0, 4).toString(), "wOF2");
    assert.equal(bytes.length, asset.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
    assert.ok(css.includes(`./assets/fonts/${asset.file}`));
    total += bytes.length;
  }
  assert.equal(total, manifest.totalBytes);
  for (const name of ["JetBrainsMono-OFL.txt", "NotoSansSC-OFL.txt"]) {
    assert.match(readFileSync(new URL(`public/licenses/fonts/${name}`, root), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/i);
  }
});
