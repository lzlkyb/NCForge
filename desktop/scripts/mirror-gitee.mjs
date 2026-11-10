#!/usr/bin/env node
/**
 * mirror-gitee.mjs —— 把某个 GitHub Release 的产物镜像到 Gitee（一条命令）。
 *
 * 为什么不在 CI 里做（2026-11-05 实测结论）：
 *   GitHub Actions 的 runner 在境外，到 Gitee 的上传只有 ~50 KB/s，推 85MB 需要
 *   半小时以上，实测 13 分钟后被 Gitee 断连（`unexpected disconnect while reading
 *   sideband packet`）。本机直连则是 2.2 MB/s、52 秒推完。所以这件事只能本地做。
 *
 * 为什么大文件走「发行版附件」而不是 raw 分支：
 *   Gitee raw 对 >50MB 的文件返回 403 `large file require login for access`，
 *   匿名客户端读不到（jdtls.zip 56MB 正好踩线）。发行版附件匿名可下、2MB/s。
 *   清单本身只有几 KB，放 raw 固定地址（客户端配置的就是那个地址）。
 *
 * 用法：
 *   GITEE_TOKEN=xxx node scripts/mirror-gitee.mjs v0.1.2
 *   GITEE_TOKEN=xxx node scripts/mirror-gitee.mjs v0.1.2 --force   # 附件全部重传
 *
 * 🔴 --force 是给「重发」用的：正常幂等靠「同名同大小就跳过」，而重发时新构建完全
 *   可能产出同字节数的包（内容不同），跳过就会把上一轮那份留在 Gitee 上，客户端拿
 *   新清单验旧包 → 验签失败 → 反复下载。字节数相等不能证明是同一份文件。
 *
 * 环境变量：
 *   GITEE_TOKEN       可选。Gitee 私人令牌（需 projects 写权限）；不给就从
 *                     仓库根或 desktop/.gitee-token（gitignore，首行）读。
 *   GITEE_REPOSITORY  默认 lzul/NCForge
 *   GH_BIN            gh 可执行文件路径（默认走 PATH，Windows 上会回退到安装目录）
 *   HTTPS_PROXY       gh 下载 GitHub 资产时用它（能快 100 倍，强烈建议设）
 *
 * 幂等：同名同大小的附件会跳过；清单始终覆盖。重复跑只补缺的部分。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API = "https://gitee.com/api/v5";
const REPO = (process.env.GITEE_REPOSITORY || "lzul/NCForge").trim();
const ARGS = process.argv.slice(2);
// 按形状找 tag，不按位置：`--force` 放前面也不会把 tag 解析成 "--force"。
const TAG = (ARGS.find((a) => /^v\d/.test(a)) || "").trim();
const FORCE = ARGS.includes("--force");

// 仓库根：脚本在 desktop/scripts/ 下，往上两级。
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

// token 解析：环境变量优先，其次仓库根/desktop 下 gitignore 的 .gitee-token（首行）。
// 落文件是为了 release.mjs 自动镜像也能拿到——发版脚本不该在命令行里明文传 token。
function resolveToken() {
  const env = (process.env.GITEE_TOKEN || "").trim();
  if (env) return env;
  for (const p of [path.join(REPO_ROOT, ".gitee-token"), path.join(REPO_ROOT, "desktop", ".gitee-token")]) {
    try {
      const t = fs.readFileSync(p, "utf-8").split(/\r?\n/)[0].trim();
      if (t) return t;
    } catch {
      /* 文件不存在，继续找下一个 */
    }
  }
  return "";
}
const TOKEN = resolveToken();

function fail(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
const info = (m) => console.log(`\x1b[36m[INFO]\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m[OK]\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m[WARN]\x1b[0m ${m}`);
const step = (m) => console.log(`\n\x1b[1m▸ ${m}\x1b[0m`);

if (!TAG) fail("用法: GITEE_TOKEN=xxx node scripts/mirror-gitee.mjs v1.2.3 [--force]");
if (!/^v\d/.test(TAG)) fail(`tag 必须以 v 开头（${TAG}）`);
if (!TOKEN) {
  fail(
    "缺 GITEE_TOKEN：设环境变量，或把私人令牌写进 .gitee-token（仓库根，首行，已 gitignore）。\n" +
      "  令牌需 projects 写权限：https://gitee.com/profile/personal_access_tokens",
  );
}

// ── gh 可执行文件 ─────────────────────────────────────────────────────────────
function findGh() {
  if (process.env.GH_BIN) return process.env.GH_BIN;
  const probe = spawnSync("gh", ["--version"], { encoding: "utf-8" });
  if (probe.status === 0) return "gh";
  if (process.platform === "win32") {
    const fallback = "C:\\Program Files\\GitHub CLI\\gh.exe";
    if (fs.existsSync(fallback)) return fallback;
  }
  return null;
}
const GH = findGh();
if (!GH) fail("找不到 gh（GitHub CLI）。装一个，或设 GH_BIN 指向它。");

// ── GitHub 仓库：从 git remote 推断 ───────────────────────────────────────────
function resolveGithubRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT, encoding: "utf-8" });
  const url = (r.stdout || "").trim();
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) fail(`无法从 git remote 推断 GitHub 仓库（${url || "空"}），可设 GITHUB_REPOSITORY=owner/repo`);
  return `${m[1]}/${m[2]}`;
}
const GH_REPO = resolveGithubRepo();

// ── Gitee API ─────────────────────────────────────────────────────────────────
async function gitee(method, apiPath, { body, form } = {}) {
  const url = new URL(API + apiPath);
  url.searchParams.set("access_token", TOKEN);
  const init = { method };
  if (form) {
    init.body = form;
  } else if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify({ ...body, access_token: TOKEN });
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

// ── 工作目录 ──────────────────────────────────────────────────────────────────
const WORK = path.join(os.tmpdir(), `ncforge-gitee-mirror-${TAG}`);
const ASSETS = path.join(WORK, "assets");
const MANIFESTS = path.join(WORK, "manifests");
fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(MANIFESTS, { recursive: true });
info(`工作目录 ${WORK}${FORCE ? "（--force：附件全部重传）" : ""}`);

// ── 1. 只下清单，先算出到底需要哪些文件 ───────────────────────────────────────
step("1/6 下载清单（updater.json / resources.json）");

function ghDownload(names) {
  // 新版 gh 的 `release download` 只接受一个位置参数（tag），文件名必须走
  // `--pattern`（可重复）；把文件名当第二个位置参数会报
  // "accepts at most 1 arg(s), received 2"。
  const args = ["release", "download", TAG, "-R", GH_REPO, "--dir", ASSETS, "--clobber"];
  for (const n of names) args.push("--pattern", n);
  const r = spawnSync(GH, args, { encoding: "utf-8", stdio: "inherit" });
  if (r.status !== 0) fail(`gh release download 失败（tag ${TAG} @ ${GH_REPO}）`);
}

// 🔴 清单必须**每次重下**，不能「存在就跳过」：两份清单只占十几 KB，而它们决定
// 镜像的签名与版本指向。v0.4.0 实测踩过——tag 重发后重跑镜像，本地还躺着上一次
// 构建的 updater.json（签名属于旧包），生成的 updater-gitee.json 与重新上传的
// 安装包**验签必然不匹配**，客户端每次都要「下载到 100% → 验签失败 → 换源重下」。
// 更隐蔽的是验收只比 `version`（两次都是 0.4.0），全程绿灯。
ghDownload(["updater.json", "resources.json"]);

/**
 * GitHub Release 上每个附件的真实字节数。
 *
 * 只判「本地文件存在」是不够的：`gh release download` 被 Ctrl-C / Stop-Process
 * 打断会留下半截文件，下一次运行就会把它当完整产物直接传给 Gitee。
 * v0.4.0 实测踩过——jdtls.zip 只传了 5.6MB（真实 58.8MB），且因为
 * `existing.get(name) === size` 拿坏文件的长度去比，Gitee 侧看起来还「一致」。
 */
function remoteSizes() {
  const r = spawnSync(GH, ["release", "view", TAG, "-R", GH_REPO, "--json", "assets"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    fail(`读取 GitHub 附件清单失败：${(r.stderr || r.stdout || "").slice(0, 300)}`);
  }
  const assets = JSON.parse(r.stdout || "{}").assets || [];
  return new Map(assets.map((a) => [a.name, a.size]));
}

const updater = JSON.parse(fs.readFileSync(path.join(ASSETS, "updater.json"), "utf-8"));
const resources = JSON.parse(fs.readFileSync(path.join(ASSETS, "resources.json"), "utf-8"));

if (String(updater.version) !== TAG.replace(/^v/, "")) {
  warn(`清单里的 version 是 ${updater.version}，与 tag ${TAG} 不一致——继续，但请确认不是拿错了 tag`);
}

/** 从清单里的 url 取文件名（镜像要按同名上传）。 */
const fileNameOf = (url) => {
  const clean = String(url).split(/[?#]/)[0];
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  if (!name) fail(`无法从 url 取文件名：${url}`);
  return decodeURIComponent(name);
};

const needed = new Set();
for (const p of Object.values(updater.platforms || {})) {
  if (!p?.url) fail("updater.json 里有 platform 缺 url");
  needed.add(fileNameOf(p.url));
}
for (const p of resources.packs || []) {
  if (!p?.url) fail(`resources.json 的包 ${p?.id || "?"} 缺 url`);
  needed.add(fileNameOf(p.url));
}
ok(`需要 ${needed.size} 个文件：${[...needed].join(", ")}`);

// ── 2. 下载这些文件 ───────────────────────────────────────────────────────────
step("2/6 下载产物");
const sizes = remoteSizes();
// 大小对不上的本地文件一律删掉重下：上一次运行被打断留下的半截文件如果被当成
// 完整产物，Gitee 上就会出现「能下、装不上」的坏附件，且下次重跑还会跳过它。
const missing = [...needed].filter((n) => {
  const p = path.join(ASSETS, n);
  if (!fs.existsSync(p)) return true;
  const want = sizes.get(n);
  if (want === undefined) return false; // 不是 Release 附件（理论上不会），不拦
  const got = fs.statSync(p).size;
  if (got === want) return false;
  warn(`${n} 本地 ${got} 字节 ≠ 远端 ${want} 字节，删掉重下`);
  fs.rmSync(p, { force: true });
  return true;
});
if (missing.length) {
  info(`下载 ${missing.length} 个：${missing.join(", ")}`);
  ghDownload(missing);
} else {
  ok("全部已存在且大小一致，跳过下载");
}
for (const n of needed) {
  const p = path.join(ASSETS, n);
  if (!fs.existsSync(p)) fail(`下载后仍缺 ${n}`);
  const want = sizes.get(n);
  const got = fs.statSync(p).size;
  if (want !== undefined && got !== want) {
    fail(`${n} 大小不符：本地 ${got} / 远端 ${want}（下载被截断，删掉该文件后重跑）`);
  }
}
const totalMb = [...needed].reduce((s, n) => s + fs.statSync(path.join(ASSETS, n)).size, 0) / 1048576;
ok(`共 ${totalMb.toFixed(1)} MB`);

// ── 3. 生成 Gitee 变体清单 ────────────────────────────────────────────────────
step("3/6 生成 Gitee 变体清单（URL → 发行版附件）");
const mg = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, "gitee-manifest.mjs"), ASSETS, MANIFESTS, "--repo", REPO, "--tag", TAG],
  { encoding: "utf-8", stdio: "inherit" },
);
if (mg.status !== 0) fail("生成清单失败");
const UPDATER_JSON = path.join(MANIFESTS, "updater-gitee.json");
const RES_JSON = path.join(MANIFESTS, "resources-gitee.json");
if (!fs.existsSync(UPDATER_JSON) || !fs.existsSync(RES_JSON)) fail("清单产物缺失");

// ── 4. 建（或复用）Gitee 发行版 ───────────────────────────────────────────────
step("4/6 准备 Gitee 发行版");
let releaseId = null;
{
  const got = await gitee("GET", `/repos/${REPO}/releases/tags/${TAG}`);
  if (got.status === 200 && got.data?.id) {
    releaseId = got.data.id;
    ok(`已存在发行版 ${TAG}（id ${releaseId}）`);
  } else {
    const created = await gitee("POST", `/repos/${REPO}/releases`, {
      body: {
        tag_name: TAG,
        name: `NCForge ${TAG}`,
        body: `桌面 IDE 发布产物镜像。清单见 https://gitee.com/${REPO}/raw/releases/latest/`,
        target_commitish: "master",
      },
    });
    if (created.status >= 300 || !created.data?.id) {
      fail(`创建发行版失败（${created.status}）：${JSON.stringify(created.data).slice(0, 300)}`);
    }
    releaseId = created.data.id;
    ok(`已创建发行版 ${TAG}（id ${releaseId}）`);
  }
}

// ── 5. 上传附件（同名同大小跳过）────────────────────────────────────────────
step("5/6 上传附件");
const existing = new Map();
for (let page = 1; ; page += 1) {
  const r = await gitee("GET", `/repos/${REPO}/releases/${releaseId}/attach_files?per_page=100&page=${page}`);
  const list = Array.isArray(r.data) ? r.data : [];
  for (const a of list) existing.set(a.name, { size: a.size, id: a.id });
  if (list.length < 100) break;
}
if (existing.size) info(`已有 ${existing.size} 个附件`);

for (const name of needed) {
  const local = path.join(ASSETS, name);
  const size = fs.statSync(local).size;
  const prev = existing.get(name);
  // 正常幂等：同名同大小跳过。--force（重发）时一律重传——大小相等不代表内容相同。
  if (!FORCE && prev?.size === size) {
    ok(`${name} 已在上方（${(size / 1048576).toFixed(1)} MB），跳过`);
    continue;
  }
  if (prev) {
    // 同名附件不会被覆盖，直接重传会并排出现两条（一条坏一条好），客户端按名字
    // 取第一个就可能又拿到坏的。先删掉旧的再传。
    const why = prev.size === size ? "大小相同但内容可能不同" : `远端 ${prev.size} / 本地 ${size}`;
    warn(`${name} ${why}（${FORCE ? "--force" : ""}），先删旧附件`);
    const del = await gitee("DELETE", `/repos/${REPO}/releases/${releaseId}/attach_files/${prev.id}`);
    if (del.status >= 300) {
      warn(`删除旧附件失败（${del.status}）——Gitee 上可能留下重复附件，请手动清理`);
    }
  }

  info(`上传 ${name}（${(size / 1048576).toFixed(1)} MB）…`);
  const t0 = Date.now();
  const fd = new FormData();
  fd.append("access_token", TOKEN);
  // Blob 比 Buffer 少一次拷贝；Node 18+ 的 fetch 会流式发出去。
  fd.append("file", new Blob([fs.readFileSync(local)]), name);
  const res = await fetch(`${API}/repos/${REPO}/releases/${releaseId}/attach_files`, {
    method: "POST",
    body: fd,
  });
  const text = await res.text();
  if (res.status >= 300) fail(`上传 ${name} 失败（${res.status}）：${text.slice(0, 300)}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  ok(`${name} 上传完成（${secs}s，约 ${(size / 1048576 / Math.max(1, secs)).toFixed(2)} MB/s）`);
}

// ── 6. 把两份清单推到 releases 分支（只放清单，几 KB）────────────────────────
step("6/6 推送清单到 raw 分支");
const MIRROR = path.join(WORK, "repo");
const authed = `https://oauth2:${TOKEN}@gitee.com/${REPO}.git`;

function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: opts.cwd, encoding: "utf-8" });
  if (r.status !== 0 && !opts.allowFail) {
    fail(`git ${args.join(" ")} 失败：${(r.stderr || r.stdout || "").slice(0, 400).replace(TOKEN, "***")}`);
  }
  return r;
}

if (fs.existsSync(MIRROR)) {
  // 只在临时目录里操作，直接重建最省事（也避免上次残留的分支状态）。
  fs.rmSync(MIRROR, { recursive: true, force: true });
}
git(["clone", "--depth", "1", authed, MIRROR]);
git(["config", "core.autocrlf", "false"], { cwd: MIRROR }); // 别把 json 换成 CRLF 再提交
git(["config", "user.email", "mirror@ncforge.local"], { cwd: MIRROR });
git(["config", "user.name", "ncforge-mirror"], { cwd: MIRROR });

git(["checkout", "--orphan", "releases"], { cwd: MIRROR });
git(["reset", "--hard"], { cwd: MIRROR });

fs.mkdirSync(path.join(MIRROR, "latest"), { recursive: true });
for (const [src, dst] of [
  [UPDATER_JSON, "updater-gitee.json"],
  [RES_JSON, "resources-gitee.json"],
]) {
  fs.copyFileSync(src, path.join(MIRROR, "latest", dst));
}
git(["add", "latest"], { cwd: MIRROR });
git(["commit", "-m", `manifest: ${TAG}`, "--", "latest"], { cwd: MIRROR });
// force：分支语义是"当前最新镜像"，不需要历史；每版都留一个 commit 会让仓库无限膨胀。
git(["push", "-f", "--progress", "origin", "releases"], { cwd: MIRROR });

// ── 验收：客户端真读的地址能不能拿到正确版本 ─────────────────────────────────
step("验收：匿名读 raw 清单");
const rawUrl = `https://gitee.com/${REPO}/raw/releases/latest/updater-gitee.json`;
let verified = false;
// 只比 version 是不够的：同一个 tag 重发后 version 不变、签名却变了（新构建 = 新字节），
// 而签名不匹配的清单会让客户端每次都「下完 → 验签失败 → 换源重下」。这里连签名一起比。
const expectSig = Object.fromEntries(
  Object.entries(updater.platforms || {}).map(([k, v]) => [k, v.signature]),
);
const sigMismatch = (data) =>
  Object.keys(expectSig).filter((k) => expectSig[k] !== data.platforms?.[k]?.signature);
for (let i = 1; i <= 6; i += 1) {
  const res = await fetch(rawUrl, { redirect: "follow" });
  if (res.ok) {
    const data = await res.json();
    const bad = sigMismatch(data);
    if (String(data.version) === TAG.replace(/^v/, "") && bad.length === 0) {
      ok(`raw 读到 version ${data.version}（${res.status}），签名与本次 GitHub 清单一致`);
      for (const [k, v] of Object.entries(data.platforms || {})) info(`  ${k} → ${v.url}`);
      verified = true;
      break;
    }
    if (bad.length) {
      warn(`raw 上 ${bad.join("/")} 的签名与本次清单不一致（第 ${i} 次），等 5s 重试`);
    } else {
      warn(`raw 上的 version 是 ${data.version}，还没变成 ${TAG}（第 ${i} 次），等 5s 重试`);
    }
  } else {
    warn(`raw 请求 ${res.status}（第 ${i} 次），等 5s 重试`);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
if (!verified) {
  fail(
    `清单没验证通过。手工确认：${rawUrl}\n` +
      `    附件地址示例：https://gitee.com/${REPO}/releases/download/${TAG}/${[...needed][0]}`,
  );
}

// 附件的匿名可达性：抽一个最大的文件测一次（raw 分支会 403 的正是这种大文件）。
const biggest = [...needed]
  .map((n) => ({ n, s: fs.statSync(path.join(ASSETS, n)).size }))
  .sort((a, b) => b.s - a.s)[0];
if (biggest) {
  const u = `https://gitee.com/${REPO}/releases/download/${TAG}/${biggest.n}`;
  const head = await fetch(u, { method: "GET", headers: { Range: "bytes=0-1023" }, redirect: "follow" });
  if (head.status === 200 || head.status === 206) {
    ok(`附件匿名可读：${biggest.n}（${(biggest.s / 1048576).toFixed(1)} MB，${head.status}）`);
  } else {
    warn(`附件 ${biggest.n} 匿名请求返回 ${head.status}——客户端可能下不到，请用浏览器复核`);
  }
}

// ── 复核：端到端验一遍「清单 ↔ 产物 ↔ 签名」────────────────────────────────
// 上面两步各自只保证「自己那一段」：清单比过签名、附件比过字节数。但客户端是把
// **某个源的清单**配**某个源的包**一起用的，只有端到端跑一次才算数（v0.4.0 事故里
// 清单签名属于上一轮构建、附件是新包，两段各自都「通过」，客户端却必然验签失败）。
step("复核：端到端校验更新链路");
const verify = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, "verify-update-chain.mjs"), TAG],
  { encoding: "utf-8", stdio: "inherit" },
);
if (verify.status !== 0) {
  fail(
    verify.status === 2
      ? "端到端校验时网络不通，无法确认链路（附件已上传，但结论未知）。设 HTTPS_PROXY 后重跑本脚本复核。"
      : "更新链路校验未通过——现在宣布发版完成，用户就会「下载完又重下」。修好清单或附件后重跑本脚本。",
  );
}

console.log(`\n\x1b[32m✅ ${TAG} 已镜像到 Gitee：https://gitee.com/${REPO}/releases/tag/${TAG}\x1b[0m`);
console.log(`   重新跑同一条命令是安全的（已上传的附件会跳过）。`);
