#!/usr/bin/env node
/**
 * verify-update-chain.mjs —— 发版后的端到端校验：**清单 ↔ 产物 ↔ 签名**。
 *
 * 为什么需要：2026-11-10 v0.4.0 事故。Gitee 的 updater-gitee.json 是用上一轮构建的
 * updater.json 生成的（签名属于旧包），而附件已换成新包，两者验签必然失败。客户端
 * 于是「下载 8.4MB → 验签失败 → 重试 2 次 → 换源再下 8.4MB」，用户看到反复下载。
 * 当时唯一的人工验收只比了 `version`（两次都是 0.4.0），全程绿灯。
 *
 * 这个脚本按客户端视角做四件事，任一不过就非零退出：
 *   1. 各更新源清单的 version / 每平台 signature / 文件名必须与构建产物完全一致
 *   2. 每个 platform 的 url 必须真能下载，且字节数与 GitHub 附件相等（拦 404 / 半截文件）
 *   3. 用 tauri.conf.json 里的内置公钥对安装包做真实 minisign 验签（Ed25519 + Blake2b-512）
 *   4. 报告各源的 pub_date，便于判断清单是不是同一轮构建产出
 *
 * 用法：
 *   node scripts/verify-update-chain.mjs v0.4.0
 *   node scripts/verify-update-chain.mjs v0.4.0 --skip-gitee   # Gitee 还没镜像时
 *
 * 退出码：
 *   0 全部通过
 *   1 有内容性 FAIL（清单签名/版本/字节数与产物不符）——真问题，要修
 *   2 只有网络性 FAIL（本机到更新源连不上）——**无法判定**，不是发版问题
 * 这个区分很重要：reship.mjs 靠退出码决定「重新构建」还是「先修网络」，
 * 把网络抖动当成内容不符会白重建 50 分钟。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const TAG = argv.find((a) => /^v\d/.test(a));
const SKIP_GITEE = argv.includes("--skip-gitee");
const GH_REPO = (process.env.VERIFY_GH_REPO || "lzlkyb/NCForge").trim();
const GITEE_REPO = (process.env.VERIFY_GITEE_REPO || "lzul/NCForge").trim();

if (!TAG) {
  console.error("用法: node scripts/verify-update-chain.mjs v0.4.0 [--skip-gitee]");
  process.exit(1);
}

const C = { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m", off: "\x1b[0m" };
const failures = [];
const warn = (m) => console.log(`${C.yellow}[WARN]${C.off} ${m}`);
const info = (m) => console.log(`${C.cyan}[INFO]${C.off} ${m}`);
const ok = (m) => console.log(`${C.green}[OK]${C.off} ${m}`);
/** kind="network" 表示「连不上，无法判定」，与「内容不符」严格分开（见文件头退出码）。 */
function fail(m, kind = "content") {
  failures.push({ m, kind });
  console.log(`${C.red}[FAIL]${C.off} ${m}`);
}
function step(m) {
  console.log(`\n${C.cyan}▸ ${m}${C.off}`);
}

/** 网络层失败的特征（DNS / TCP / TLS / 超时），HTTP 4xx 不在此列——那是真不存在。 */
const NET_ERR = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|certificate|TLS|network|socket disconnected/i;
const kindOf = (msg) => (NET_ERR.test(String(msg)) ? "network" : "content");

/** 从 tauri.conf.json 读内置公钥（客户端验签用的就是它，必须同一把）。 */
function builtinPubkey() {
  const confPath = path.join(import.meta.dirname, "..", "src-tauri", "tauri.conf.json");
  const conf = JSON.parse(fs.readFileSync(confPath, "utf-8"));
  const b64 = conf?.plugins?.updater?.pubkey;
  if (!b64) throw new Error("tauri.conf.json 里没有 plugins.updater.pubkey");
  // base64 解出来是 minisign 公钥文件的两行文本
  const lines = Buffer.from(b64, "base64").toString("utf-8").split("\n");
  const blob = Buffer.from(lines[1], "base64");
  return {
    algo: blob.subarray(0, 2).toString("latin1"),
    keyId: blob.subarray(2, 10).toString("hex"),
    key: blob.subarray(10, 42),
    comment: lines[0],
  };
}

/** minisign "ED"（prehashed）验签：签名是对 Blake2b-512(文件内容) 的 Ed25519 签名。 */
function verifyMinisign(pkgBuf, sigB64, pub) {
  const sigText = Buffer.from(String(sigB64).trim(), "base64").toString("utf-8");
  const lines = sigText.split("\n");
  const sigBlob = Buffer.from(lines[1] || "", "base64");
  if (sigBlob.length < 74) throw new Error("签名块长度不足");
  const algo = sigBlob.subarray(0, 2).toString("latin1");
  const keyId = sigBlob.subarray(2, 10).toString("hex");
  if (keyId !== pub.keyId) {
    throw new Error(`keyid 不匹配（签名 ${keyId} / 公钥 ${pub.keyId}）——私钥换过，老客户端会永远验签失败`);
  }
  const prehash = crypto.createHash("blake2b512").update(pkgBuf).digest();
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.key]);
  return {
    ok: crypto.verify(null, prehash, crypto.createPublicKey({ key: spki, format: "der", type: "spki" }), sigBlob.subarray(10, 74)),
    algo,
  };
}

function ghAssets() {
  const r = spawnSync("gh", ["release", "view", TAG, "-R", GH_REPO, "--json", "assets"], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`读取 GitHub 附件失败：${(r.stderr || "").slice(0, 200)}`);
  return new Map((JSON.parse(r.stdout || "{}").assets || []).map((a) => [a.name, a.size]));
}

function fileNameOf(url) {
  const clean = String(url).split(/[?#]/)[0];
  return decodeURIComponent(clean.slice(clean.lastIndexOf("/") + 1));
}

async function getJson(url) {
  // github.com / release-assets 这条链在国内是间歇性可达的：实测同一条命令一分钟前成功、
  // 一分钟后 `fetch failed`。所以网络类失败必须重试几次，否则一次抖动就被判成「清单不对」。
  let lastErr;
  for (let i = 0; i < 3; i += 1) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (!NET_ERR.test(String(e.message))) throw e; // 4xx 是确定性的，重试只浪费时间
      if (i < 2) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 只取 1KB，确认 url 真的能下（Gitee 的 raw 对 >50MB 会 403，附件不会）。 */
async function probe(url, expectSize) {
  let res;
  try {
    res = await fetch(url, { redirect: "follow", headers: { Range: "bytes=0-1023" } });
  } catch (e) {
    return { err: String(e.message || e), kind: "network" };
  }
  if (res.status >= 500) return { err: `HTTP ${res.status}`, kind: "network" };
  if (res.status !== 200 && res.status !== 206) return { err: `HTTP ${res.status}`, kind: "content" };
  const total = Number(res.headers.get("content-length") || 0);
  // 206 时 content-length 是分片长度，真实大小在 content-range
  const range = res.headers.get("content-range") || "";
  const real = range.includes("/") ? Number(range.split("/")[1]) : total;
  if (expectSize && real && real !== expectSize) return { err: `字节数 ${real} ≠ GitHub ${expectSize}`, kind: "content" };
  return null;
}

/**
 * 用 gh 把 Release 上的某个文件下到本地（返回路径，失败返回 null）。
 *
 * 为什么不用 fetch：本机到 github.com 的 https 会间歇性 `fetch failed`（实测 2026-11-10
 * 一次 dry-run 就中招），而 gh 带重试与认证，稳得多，拿到的内容与 URL 上完全一致。
 */
function ghDownloadPattern(name, dir) {
  const r = spawnSync("gh", ["release", "download", TAG, "-R", GH_REPO, "--dir", dir, "--clobber", "--pattern", name], {
    encoding: "utf-8",
  });
  return r.status === 0 ? path.join(dir, name) : null;
}

/** 通过 gh 读 GitHub 源清单；拿不到返回 null（由调用方决定回落 fetch 还是记 FAIL）。 */
function readGithubManifest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncforge-verify-manifest-"));
  try {
    const local = ghDownloadPattern("updater.json", dir);
    return local ? JSON.parse(fs.readFileSync(local, "utf-8")) : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const pub = builtinPubkey();
  console.log(`${C.dim}公钥 ${pub.comment.trim()}${C.off}`);

  step("1/4 读取 GitHub 附件清单（作为基准字节数）");
  const sizes = ghAssets();
  info(`附件 ${sizes.size} 个`);

  step("2/4 拉取各更新源的清单并与构建产物比对");
  const sources = [
    { name: "github-release", url: `https://github.com/${GH_REPO}/releases/download/${TAG}/updater.json`, base: true },
    { name: "gh-pages", url: `https://${GH_REPO.split("/")[0]}.github.io/${GH_REPO.split("/")[1]}/updater.json` },
    ...(SKIP_GITEE
      ? []
      : [{ name: "gitee-raw", url: `https://gitee.com/${GITEE_REPO}/raw/releases/latest/updater-gitee.json`, gitee: true }]),
  ];

  const manifests = {};
  for (const s of sources) {
    if (s.base) {
      const local = readGithubManifest();
      if (local) {
        manifests[s.name] = local;
        ok(`${s.name} 可读（经 gh 下载，避开 https 抖动）`);
        continue;
      }
    }
    try {
      manifests[s.name] = await getJson(s.url);
      ok(`${s.name} 可读`);
    } catch (e) {
      // gh-pages 是可选源（客户端 404 会立刻换源，不重试）；其余源不可读即 FAIL
      if (s.base || s.gitee) fail(`${s.name} 清单不可读：${e.message}`, kindOf(e.message));
      else warn(`${s.name} 清单不可读（${e.message}）——该源会在客户端被跳过`);
    }
  }

  const base = manifests["github-release"];
  if (!base) {
    // 基准缺了往往是网络问题（上面那条 FAIL 已经记了 network），别让它变成「内容不符」。
    fail("拿不到基准清单，后续校验跳过", failures.some((f) => f.kind === "network") ? "network" : "content");
  } else {
    if (String(base.version) !== TAG.replace(/^v/, "")) {
      fail(`基准清单 version=${base.version}，与 tag ${TAG} 不一致`);
    } else {
      ok(`基准清单 version=${base.version} pub_date=${base.pub_date}`);
    }

    for (const [name, m] of Object.entries(manifests)) {
      if (name === "github-release") continue;
      for (const [platform, b] of Object.entries(base.platforms || {})) {
        const other = m.platforms?.[platform];
        if (!other) {
          // gitee 少一个平台 = 那个平台的国内用户走不通，但能回落，记 WARN
          warn(`${name} 缺 ${platform} 条目（该平台用户会回落到 GitHub/ghproxy）`);
          continue;
        }
        if (other.signature !== b.signature) {
          // 本次事故的正中靶心：version 一样、签名不同 → 客户端必验签失败
          fail(
            `${name} 的 ${platform} 签名与构建产物不一致` +
              `（pub_date ${m.pub_date} vs ${base.pub_date}）——客户端会「下完验签失败 → 换源重下」`,
          );
        } else {
          ok(`${name} 的 ${platform} 签名一致`);
        }
        if (fileNameOf(other.url) !== fileNameOf(b.url)) {
          fail(`${name} 的 ${platform} 指向 ${fileNameOf(other.url)}，构建产物是 ${fileNameOf(b.url)}`);
        }
        if (sources.find((s) => s.name === name)?.gitee && !other.url.includes("gitee.com")) {
          warn(`${name} 的 ${platform} 没走 Gitee 附件（${other.url}），国内用户仍会打到 GitHub`);
        }
      }
    }
  }

  step("3/4 各源 url 真实可下 + 字节数对得上");
  for (const [name, m] of Object.entries(manifests)) {
    for (const [platform, p] of Object.entries(m.platforms || {})) {
      const expect = sizes.get(fileNameOf(p.url));
      const bad = await probe(p.url, expect);
      if (bad) fail(`${name} 的 ${platform} 下不到：${bad.err}（${p.url}）`, bad.kind);
      else ok(`${name} 的 ${platform} 可下（${(expect / 1048576).toFixed(1)} MB）`);
    }
  }

  step("4/4 用内置公钥对安装包做真实验签");
  if (base) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ncforge-verify-"));
    for (const [platform, p] of Object.entries(base.platforms || {})) {
      const name = fileNameOf(p.url);
      // 优先验 Gitee 上那份（客户端首选源），没有就验 GitHub
      const giteeEntry = manifests["gitee-raw"]?.platforms?.[platform];
      const targetUrl = giteeEntry?.url || p.url;
      const dl = spawnSync("gh", ["release", "download", TAG, "-R", GH_REPO, "--dir", tmp, "--clobber", "--pattern", name], {
        encoding: "utf-8",
      });
      if (dl.status !== 0) {
        const msg = (dl.stderr || "").slice(0, 200);
        fail(`${platform} 下载失败：${msg}`, kindOf(msg));
        continue;
      }
      const buf = fs.readFileSync(path.join(tmp, name));
      try {
        // 用「客户端实际会拿到的那个清单」里的签名来验
        const r = verifyMinisign(buf, giteeEntry?.signature || p.signature, pub);
        if (r.ok) ok(`${platform} 验签通过（${name}，${r.algo === "ED" ? "prehashed" : "plain"}）`);
        else fail(`${platform} 验签失败：${name} 与清单签名不匹配`);
      } catch (e) {
        fail(`${platform} 验签异常：${e.message}`);
      }
      info(`  客户端首选地址：${targetUrl}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("");
  if (failures.length) {
    const netOnly = failures.every((f) => f.kind === "network");
    console.error(
      `${C.red}✗ ${failures.length} 项未通过${netOnly ? "（全是网络层失败，链路是否正常「无法判定」）" : ""}${C.off}`,
    );
    for (const f of failures) console.error(`  · ${f.m}`);
    if (netOnly) {
      console.error(
        `${C.yellow}这不是发版问题：本机到更新源不通。设 HTTPS_PROXY 后重跑，或加 --skip-gitee 只看 GitHub。${C.off}`,
      );
      process.exit(2);
    }
    process.exit(1);
  }
  console.log(`${C.green}✅ 更新链路校验通过：${TAG}${C.off}`);
}

main().catch((e) => {
  console.error(`${C.red}校验脚本异常：${e.stack || e}${C.off}`);
  process.exit(kindOf(e?.message) === "network" ? 2 : 1);
});
