/**
 * reship-plan.mjs —— reship.mjs 的纯判断逻辑（不碰网络 / git / fs，便于单测）。
 *
 * 重发（reship）要回答三个问题，全在这里：
 *   1. 该 tag 上还有没有在跑的 CI？删 tag 不会停旧 run，必须先取消，否则两次构建
 *      并发写同一个 Release，产物是两轮混合的（v0.4.0 实测踩过）。
 *   2. Release 产物是否「本轮」构建的？同名资产会被覆盖，但覆盖前它还是上一轮
 *      那份——只看「updater.json 存在」就动手镜像，镜像的是旧清单（v0.4.0 事故根因）。
 *   3. 到底该重新构建（full）还是只重新镜像（mirror）？判据是 GitHub 侧自洽与否。
 */

/** 文件名（与 mirror-gitee / verify-update-chain 同口径：容忍 query/hash 与套娃前缀）。 */
export function fileNameOf(url) {
  const clean = String(url).split(/[?#]/)[0];
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  return name ? decodeURIComponent(name) : "";
}

/** 该 tag 上尚未结束的 run（需要 force-cancel 的那些）。 */
export function pendingRunsForTag(runs, tag) {
  return (runs || []).filter((r) => r.head_branch === tag && r.status !== "completed");
}

/** 该 tag 上已结束但没成功的 run：等着看产物之前就能判「不用等了，去看日志」。 */
export function failedRunsForTag(runs, tag) {
  const bad = new Set(["failure", "cancelled", "timed_out", "startup_failure", "stale"]);
  return (runs || []).filter((r) => r.head_branch === tag && r.status === "completed" && bad.has(r.conclusion));
}

/**
 * Release 是否已经出全客户端真正需要的东西。
 *
 * assets: `gh release view --json assets` 的数组，需带 name 与 createdAt。
 * notBefore: 本轮重发开始的时间戳（ms）。早于它的资产属于上一轮构建，不能算数。
 *   toleranceMs 默认 10 分钟，容忍构建机与本地时钟偏差。
 */
export function releaseReadiness(manifest, assets, { wantMac = false, notBefore = 0, toleranceMs = 600_000 } = {}) {
  const need = wantMac ? ["windows-x86_64", "darwin-aarch64"] : ["windows-x86_64"];
  const all = assets || [];
  const freshNames = new Set(
    all.filter((a) => !notBefore || Date.parse(a.createdAt || 0) >= notBefore - toleranceMs).map((a) => a.name),
  );
  const platforms = Object.keys(manifest?.platforms || {});
  const missingPlatforms = need.filter((p) => !platforms.includes(p));
  const missingSig = need.filter((p) => String(manifest?.platforms?.[p]?.signature || "").trim() === "");

  const wanted = [];
  for (const p of need) {
    const url = manifest?.platforms?.[p]?.url;
    if (url) wanted.push(fileNameOf(url));
  }
  wanted.push("updater.json");
  const staleFiles = wanted.filter((n) => !freshNames.has(n) && all.some((a) => a.name === n));
  const missingFiles = wanted.filter((n) => !all.some((a) => a.name === n));

  return {
    ready: !missingPlatforms.length && !missingSig.length && !staleFiles.length && !missingFiles.length,
    missingPlatforms,
    missingSig,
    missingFiles,
    staleFiles,
    platforms,
  };
}

/**
 * 决定重发模式。
 *   githubOk: 只比对 GitHub 源（verify --skip-gitee）是否通过——它代表"产物与清单自洽"。
 *   giteeOk : 加入 Gitee 源后的全量比对是否通过。
 * 链路本来就一致时返回 none：别为了「重发」把好东西再拆一遍。
 */
export function decideMode({ githubOk, giteeOk, full = false, mirrorOnly = false }) {
  if (mirrorOnly) return { mode: "mirror", why: "显式 --mirror-only：只重做镜像" };
  if (full) return { mode: "full", why: "显式 --full：重新构建" };
  if (!githubOk) return { mode: "full", why: "GitHub 侧清单与产物不自洽（缺平台 / 签名不符 / 版本不对），必须重新构建" };
  if (!giteeOk) return { mode: "mirror", why: "GitHub 侧正常，只是 Gitee 清单或附件没跟上" };
  return { mode: "none", why: "更新链路本来就是一致的，不需要重发" };
}
