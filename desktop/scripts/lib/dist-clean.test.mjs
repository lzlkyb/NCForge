import { test } from "node:test";
import assert from "node:assert/strict";

import { distCleanArgv, DIST_DIR } from "./dist-clean.mjs";

test("POSIX 用 sh -c rm -rf dist", () => {
  const { argv } = distCleanArgv("linux");
  assert.equal(argv[0], "sh");
  assert.equal(argv[1], "-c");
  assert.equal(argv[2], "rm -rf dist");
});

test("Windows 用 cmd /c if exist 保护，dist 不存在也不报错", () => {
  const { argv } = distCleanArgv("win32");
  assert.equal(argv[0], "cmd.exe");
  assert.equal(argv[1], "/c");
  assert.match(argv[2], /^if exist dist rmdir \/s \/q dist$/);
});

test("outDir 可覆盖，且不会出现 .. 或盘符——守删除边界", () => {
  for (const platform of ["linux", "win32"]) {
    const { argv } = distCleanArgv(platform, "dist-custom");
    assert.ok(argv.join(" ").includes("dist-custom"));
    // 只校验 outDir 这个 token 本身；命令里的 /s /q /c 是参数开关，不是路径
    const cmd = argv[argv.length - 1];
    assert.ok(!/\.\.|:\\[^ ]|^\//.test(cmd), `不拼 .. / 盘符 / 根路径：${cmd}`);
  }
  assert.equal(DIST_DIR, "dist");
});
