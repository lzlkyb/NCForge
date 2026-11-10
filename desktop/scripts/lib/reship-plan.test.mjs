/**
 * reship-plan 的单测：重发逻辑最容易错在「判据」上，判据错了就是再发一次坏版本。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  decideMode,
  failedRunsForTag,
  fileNameOf,
  pendingRunsForTag,
  releaseReadiness,
} from "./reship-plan.mjs";

const T0 = Date.parse("2026-11-10T06:00:00Z");
const iso = (min) => new Date(T0 + min * 60_000).toISOString();

test("fileNameOf 能穿过 query 与 gh-proxy 套娃前缀", () => {
  assert.equal(fileNameOf("https://gitee.com/lzul/NCForge/releases/download/v0.4.0/a.zip"), "a.zip");
  assert.equal(fileNameOf("https://gh-proxy.com/https://github.com/o/r/releases/download/v1/x.exe?x=1"), "x.exe");
  assert.equal(fileNameOf("https://example.com/%E4%B8%AD.zip"), "中.zip");
  assert.equal(fileNameOf(""), "");
});

test("pendingRunsForTag 只留本 tag 且未结束的 run", () => {
  const runs = [
    { id: 1, head_branch: "v0.4.0", status: "in_progress" },
    { id: 2, head_branch: "v0.4.0", status: "completed" },
    { id: 3, head_branch: "v0.3.0", status: "queued" },
    { id: 4, head_branch: "v0.4.0", status: "queued" },
  ];
  assert.deepEqual(
    pendingRunsForTag(runs, "v0.4.0").map((r) => r.id),
    [1, 4],
  );
});

test("failedRunsForTag 抓失败/取消，不把 success 与 skipped 算失败", () => {
  const runs = [
    { id: 1, head_branch: "v0.4.0", status: "completed", conclusion: "failure" },
    { id: 2, head_branch: "v0.4.0", status: "completed", conclusion: "success" },
    { id: 3, head_branch: "v0.4.0", status: "completed", conclusion: "cancelled" },
    { id: 4, head_branch: "v0.4.0", status: "completed", conclusion: "skipped" },
    { id: 5, head_branch: "v0.4.0", status: "in_progress", conclusion: null },
  ];
  assert.deepEqual(
    failedRunsForTag(runs, "v0.4.0").map((r) => r.id),
    [1, 3],
  );
});

const MANIFEST = {
  version: "0.4.0",
  platforms: {
    "windows-x86_64": { url: "https://x/NCForge_0.4.0_x64-setup.exe", signature: "sig-win" },
    "darwin-aarch64": { url: "https://x/NCForge.app.tar.gz", signature: "sig-mac" },
  },
};

const fresh = (names) => names.map((name) => ({ name, createdAt: iso(5) }));

test("releaseReadiness：产物齐全即就绪", () => {
  const r = releaseReadiness(MANIFEST, fresh(["updater.json", "NCForge_0.4.0_x64-setup.exe", "NCForge.app.tar.gz"]), {
    wantMac: true,
    notBefore: T0,
  });
  assert.equal(r.ready, true);
  assert.deepEqual(r.staleFiles, []);
});

test("releaseReadiness：资产是上一轮构建的（createdAt 早于本轮）不算就绪", () => {
  const assets = [
    { name: "updater.json", createdAt: iso(-240) },
    { name: "NCForge_0.4.0_x64-setup.exe", createdAt: iso(-240) },
    { name: "NCForge.app.tar.gz", createdAt: iso(5) },
  ];
  const r = releaseReadiness(MANIFEST, assets, { wantMac: true, notBefore: T0 });
  assert.equal(r.ready, false);
  // 只报过期的那两个，别把新的也一起冤枉
  assert.deepEqual(r.staleFiles.sort(), ["NCForge_0.4.0_x64-setup.exe", "updater.json"]);
});

test("releaseReadiness：缺平台 / 空签名 / 缺文件分别报出来", () => {
  const noMac = { version: "0.4.0", platforms: { "windows-x86_64": MANIFEST.platforms["windows-x86_64"] } };
  assert.deepEqual(releaseReadiness(noMac, fresh(["updater.json", "NCForge_0.4.0_x64-setup.exe"]), { wantMac: true }).missingPlatforms, [
    "darwin-aarch64",
  ]);

  const emptySig = { platforms: { "windows-x86_64": { url: "https://x/a.exe", signature: "  " } } };
  assert.deepEqual(releaseReadiness(emptySig, fresh(["updater.json", "a.exe"])).missingSig, ["windows-x86_64"]);

  const r = releaseReadiness(MANIFEST, fresh(["updater.json"]), { wantMac: true });
  assert.deepEqual(r.missingFiles.sort(), ["NCForge.app.tar.gz", "NCForge_0.4.0_x64-setup.exe"]);
  assert.equal(r.ready, false);
});

test("releaseReadiness：不带 notBefore 时不判新旧（镜像补做场景）", () => {
  const r = releaseReadiness(MANIFEST, [{ name: "updater.json", createdAt: iso(-9999) }]);
  assert.deepEqual(r.staleFiles, []);
  assert.equal(r.ready, false); // 仍因缺安装包不就绪
});

test("decideMode：GitHub 侧不自洽必须重新构建；只有 Gitee 落后就只做镜像", () => {
  assert.equal(decideMode({ githubOk: false, giteeOk: false }).mode, "full");
  assert.equal(decideMode({ githubOk: true, giteeOk: false }).mode, "mirror");
  assert.equal(decideMode({ githubOk: true, giteeOk: true }).mode, "none");
});

test("decideMode：显式开关压过自动判断", () => {
  assert.equal(decideMode({ githubOk: true, giteeOk: false, full: true }).mode, "full");
  assert.equal(decideMode({ githubOk: false, giteeOk: false, mirrorOnly: true }).mode, "mirror");
});
