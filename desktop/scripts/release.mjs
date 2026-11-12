#!/usr/bin/env node
/**
 * release.mjs — 一键发版脚本
 *
 * 用法：
 *   npm run release -- --patch            # 2.3.12 → 2.3.13
 *   npm run release -- --minor            # 2.3.12 → 2.4.0
 *   npm run release -- --major            # 2.3.12 → 3.0.0
 *   npm run release -- --version 2.3.99   # 显式指定
 *   npm run release -- --patch --dry-run  # 只打印将要做什么，不改任何文件
 *   npm run release -- --patch --yes      # 非交互：用默认摘要，自动确认 push/tag
 *   npm run release -- --patch --yes --summary "一句话更新摘要"
 *                                         # 非交互但自己写摘要（更新弹窗顶部那句）
 *   npm run release -- --patch --skip-tests  # 跳 cargo test（前端门禁仍跑，不推荐）
 *
 * 流程（自动）：
 *   1. 计算新版本号 → 只改 Cargo.toml（唯一真源）
 *   2. 调 sync-version：同步 tauri.conf.json + package.json（Cargo.lock 由 cargo 更新）
 *   3. 在 CHANGELOG.md 顶部插新版本段（更新摘要交互填写；变更列表由 git log 自动分类生成草稿）
 *   4. 在 README 版本历史表插行
 *   5. 重新生成 changelog.generated.ts
 *   6. gate.mjs 门禁（不过不提交）。全量 15 项；--skip-tests 时只跑前端 scope + cargo check
 *   7. git add 相关文件 → commit → push origin main → tag vX.Y.Z → push tag
 *   8. 打印两条后续命令（都不在 CI 里做）：要 mac 包怎么触发
 *   9. Gitee 镜像自动做：轮询等 GitHub CI 出完 Release（最长 45 分钟），先把
 *      「门禁绿/红」与「产物齐/缺」分开报（第 9 步的核对），再自动跑
 *      mirror-gitee.mjs（token 从环境变量或 .gitee-token 读）。--no-mirror 跳过。
 *      产物没出全会中止镜像；门禁红不挡（tag 构建本来就不让门禁阻断出包）。
 *
 * Gitee 镜像也是本地做的：CI 的境外 runner 到 Gitee 只有 ~50KB/s（推 13 分钟被断连），
 * 本地直连 2.2MB/s。以前靠人肉记得跑（发版脚本只打印提醒），v0.2.0 就忘了，导致
 * 老版本用户走 Gitee 兜底源收不到更新——所以现在第 9 步默认自动跑，别再 --no-mirror。
 *
 * 另有兜底：.github/workflows/gitee-mirror-check.yml 每小时对账 GitHub latest 与
 * Gitee raw 的版本号，落后就开 issue 报警（镜像补齐后自动关闭）。
 *
 * 发版口径（2026-11-05 起）：推 tag 的 CI **只构建 Windows**（约 28 分钟）。
 * mac 默认不发——它的作业 26 分钟且与 Windows 串行，v0.1.1 为此跑了 53 分钟。
 * 需要 mac 包时不要再推一次 tag，在本脚本跑完后手动触发（脚本会把这行打出来）：
 *   gh workflow run build.yml --ref vX.Y.Z -f with_macos=true
 *
 * 设计要点：
 *   - 版本号只动 Cargo.toml 一处，其余全自动同步（治愈"漏改版本号"）。
 *   - 非 TTY 环境（无 --yes）只准备到 commit，不 push/tag，避免误发。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { releaseReadiness } from "./lib/reship-plan.mjs";
import { describeVerdict, formatJobLine, summarizeRunJobs } from "./lib/releaseGateReport.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, "..");
const ROOT = path.resolve(DESKTOP, "..");

const CARGO_PATH = path.join(DESKTOP, "src-tauri", "Cargo.toml");
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");
const README_PATH = path.join(ROOT, "README.md");

// ── 参数解析 ──
const argv = process.argv.slice(2);
const getOpt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (name) => argv.includes(name);

const DRY_RUN = hasFlag("--dry-run");
const YES = hasFlag("--yes");
// 非交互场景（CI / 自动化）没法回答摘要提问，`ask` 会直接取默认值。
// 想让更新弹窗顶部那句是人话而不是 `vX.Y.Z 版本更新`，走这个参数。
const SUMMARY = getOpt("--summary");
const SKIP_TESTS = hasFlag("--skip-tests");
const NO_MIRROR = hasFlag("--no-mirror");
let bumpType = null;
let explicitVersion = getOpt("--version");
if (hasFlag("--patch")) bumpType = "patch";
else if (hasFlag("--minor")) bumpType = "minor";
else if (hasFlag("--major")) bumpType = "major";
if (!bumpType && !explicitVersion) bumpType = "patch"; // 默认 patch

// ── 工具函数 ──
function run(cmd, cwd = ROOT, inherit = true, env) {
  console.log(`\x1b[35m$ ${cmd}\x1b[0m  (cwd: ${path.relative(ROOT, cwd) || "."})`);
  return execSync(cmd, {
    cwd,
    stdio: inherit ? "inherit" : "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
}
function readCargoVersion() {
  const txt = fs.readFileSync(CARGO_PATH, "utf-8");
  const m = txt.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("Cargo.toml 未找到 version 字段");
  return m[1];
}
/**
 * 读文本并统一成 LF。
 *
 * 🔴 必须做这一步：CHANGELOG.md 在工作区是 CRLF（core.autocrlf），而下面解析
 * `[Unreleased]` 用的 `/^\s*[-*]\s+(.*)$/` 里，JS 的 `.` **不匹配 `\r`**、`$` 又只认
 * 字符串真正的结尾 —— 于是 "‑ 某条改动\r" 这种行一条都匹配不上，`items` 恒为空。
 * 后果不是报错而是**静默丢数据**：整段 [Unreleased] 被删掉、条目一条没并进新版本段
 * （2026-10-22 v3.0.0 发版实测，43 条手写条目全丢，靠 git 历史才捞回来）。
 */
function readTextNormalized(p) {
  return fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
}
function bumpSemver(cur, type, next) {
  if (next) return next;
  const [a, b, c] = cur.split(".").map(Number);
  if (type === "major") return `${a + 1}.0.0`;
  if (type === "minor") return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`; // patch
}
/** semver 核心三元组（剥掉预发布/构建后缀）；非法返回 null。 */
function semverTuple(v) {
  const core = String(v)
    .replace(/^v/, "")
    .replace(/[-+].*$/, "")
    .split(".")
    .map(Number);
  return core.length === 3 && core.every((n) => Number.isInteger(n) && n >= 0) ? core : null;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
async function ask(question, defaultValue) {
  if (YES) return defaultValue ?? "";
  // 非 TTY（如 CI / 自动化环境）不交互，直接返回默认，避免 readline 在空 stdin 上抛错导致整段 CHANGELOG 没写
  if (!process.stdin.isTTY) return defaultValue ?? "";
  const rl = readline.createInterface({ input, output });
  try {
    const ans = (await rl.question(`\x1b[36m${question}\x1b[0m `)).trim();
    return ans || defaultValue || "";
  } finally {
    rl.close();
  }
}

// ── 主流程 ──
async function main() {
  const current = readCargoVersion();
  const next = bumpSemver(current, bumpType, explicitVersion);

  // semver 校验 + 版本倒退检查（Y9）：--version 传错格式会污染 Cargo.toml/tauri.conf/
  // package.json 三处与 tag 名；next <= current 则是把已发过的版本再发一遍。
  // 两个检查都放在任何写操作之前——半截状态比直接失败难收拾得多。
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(next)) {
    console.error(
      `\x1b[31m[RELEASE ERROR]\x1b[0m 版本号 "${next}" 不是合法 semver（x.y.z[-prerelease][+build]）`,
    );
    process.exit(1);
  }
  const curT = semverTuple(current);
  const nextT = semverTuple(next);
  if (!curT || !nextT) {
    console.error(
      `\x1b[31m[RELEASE ERROR]\x1b[0m 无法解析版本号：current=${current} next=${next}`,
    );
    process.exit(1);
  }
  const cmp = nextT[0] - curT[0] || nextT[1] - curT[1] || nextT[2] - curT[2];
  // 预发布版本（如 1.0.0 → 1.0.0-beta.1）core 三元组相等，放行；相同 core 且无
  // 预发布后缀 = 原地重发，拒绝。
  if (cmp < 0 || (cmp === 0 && !next.includes("-"))) {
    console.error(
      `\x1b[31m[RELEASE ERROR]\x1b[0m 新版本 ${next} 必须大于当前版本 ${current}`,
    );
    process.exit(1);
  }

  console.log(`\x1b[32m发版计划：\x1b[0m ${current} → ${next}`);
  const tagName = `v${next}`; // dry-run 输出与第 8 步 tag 预检共用

  if (DRY_RUN) {
    console.log("[dry-run] 以下为将执行步骤，不改动任何文件：");
    if (!SKIP_TESTS)
      console.log("  1. gate.mjs 门禁全量 15 项（前端 + fmt/machete/clippy/rust-test，约 12 分钟）");
    else console.log("  1. [--skip-tests] 门禁只跑前端 scope + cargo check 保底");
    console.log(`  2. Cargo.toml version: ${current} → ${next}`);
    console.log("  3. node scripts/sync-version.mjs（同步 tauri.conf.json + package.json）");
    console.log(`  4. CHANGELOG.md 顶部插入 ## [${next}] - ${todayISO()} 段`);
    console.log("  5. README.md 版本历史表插入行");
    console.log("  6. node scripts/gen-changelog.mjs（重新生成 changelog.generated.ts）");
    console.log(`  7. semver/tag 预检 → git add 版本文件+CHANGELOG+README+generated.ts → commit → push → tag ${tagName} → push tag`);
    console.log(
      NO_MIRROR
        ? `  9. [--no-mirror] 跳过 Gitee 镜像（记得手动跑：npm run mirror:gitee -- ${tagName}）`
        : "  9. 等 GitHub CI 出完 Release（最长 45 分钟）→ 自动跑 Gitee 镜像",
    );
    return;
  }

  // 1. 门禁：一律走 gate.mjs 这一条入口，而且放在**任何写操作之前**。
  //
  // 为什么提前：以前它是第 7 步，前面已经改过 Cargo.toml / tauri.conf.json /
  // package.json / CHANGELOG / README / changelog.generated.ts。门禁一红，工作树
  // 就留下半截"版本号都改了但没提交"的改动，得人工 git checkout 收拾。现在红了
  // 直接退出，什么都没动——失败零副作用。
  //
  // 🔴 这里曾经裸写 `cargo clippy --no-default-features`，而 CI 跑的是
  //    `clippy --all-targets -- -D warnings`。同一个检查两个真源，v0.5.0 就是
  //    这样「本地全绿、tag 构建红在 clippy 上」，一个包都没出。发版路径能自己
  //    拼命令，就等于存在一条比 CI 宽松的路——现在改成调清单，参数不可能再漂，
  //    并且 `gate.mjs --verify-ci` 会断言这里不再出现裸门禁命令。
  //
  // 为什么连前端一起跑：tag push 时 CI 的 frontend / test / check-macos 三个 job
  // 都被 `if:` 跳过（发版只构建不验货），发版脚本这一次是前端门禁唯一的机会。
  // 为什么 --skip-tests 仍跑前端：要跳的从来只是 cargo test 那几分钟，前端扫描
  // 项都是秒级到十几秒，没有跳的理由。
  const gateCli = `node "${path.join(__dirname, "gate.mjs")}"`;
  if (!SKIP_TESTS) {
    console.log("\x1b[32m[1/8]\x1b[0m 门禁全量 15 项（前端 + fmt/machete/clippy/rust-test，约 12 分钟）");
    run(gateCli, DESKTOP);
  } else {
    // cargo check 不是清单里的门禁项，是「至少能编译」的保底，所以留在这里。
    console.log("\x1b[32m[1/8]\x1b[0m 门禁 --skip-tests：前端全跑，cargo 侧只做 cargo check");
    run(`${gateCli} --scope frontend`, DESKTOP);
    run("cargo check --no-default-features", path.join(DESKTOP, "src-tauri"));
  }

  // 2. bump Cargo.toml（唯一真源）
  let cargoTxt = fs.readFileSync(CARGO_PATH, "utf-8");
  cargoTxt = cargoTxt.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`);
  fs.writeFileSync(CARGO_PATH, cargoTxt, "utf-8");
  console.log(`\x1b[32m[2/8]\x1b[0m Cargo.toml → ${next}`);

  // 3. 同步其余文件
  run(`node ${path.join(__dirname, "sync-version.mjs")}`, DESKTOP);
  console.log(`\x1b[32m[3/8]\x1b[0m 已同步 tauri.conf.json + package.json`);

  // 4. 收集 git log 生成变更草稿
  let logEntries = [];
  try {
    const lastTag = execSync("git describe --tags --abbrev=0", { cwd: ROOT, stdio: "pipe" })
      .toString()
      .trim();
    const log = execSync(`git log --oneline ${lastTag}..HEAD`, { cwd: ROOT, stdio: "pipe" })
      .toString()
      .trim();
    logEntries = log ? log.split("\n").map((l) => l.replace(/^[0-9a-f]+\s+/, "")) : [];
    console.log(`\x1b[32m[4/8]\x1b[0m 自 ${lastTag} 起 ${logEntries.length} 条 commit 纳入草稿`);
  } catch {
    console.log("\x1b[33m[4/8]\x1b[0m 未找到上一 tag，跳过 git log 草稿");
  }

  // 交互：更新摘要（用户向，显示在更新弹框）
  // `--summary` 优先：给了就不问，也不落回默认占位文案。
  const summary =
    (SUMMARY ?? "").trim() ||
    (await ask(`填写「更新摘要」（用户向，回车用默认）:`, `v${next} 版本更新`)) ||
    `v${next} 版本更新`;

  // 把 git log 按前缀分类成 CHANGELOG 小节草稿。
  // 🔴 它只是**草稿/兜底**：`[Unreleased]` 里有人写过的条目才是权威。两者的区别在
  // 「谁看得见」——git log 标题是开发者向的（`feat(db): …` 原样进更新弹窗），而
  // `[Unreleased]` 是写给用户的。所以下面只有在 Unreleased 一条都没收集到时才回退用它。
  const draft = { 新增: [], 变更: [], 修复: [], 优化: [], 安全: [] };
  const mapPrefix = (line) => {
    if (/^feat/i.test(line)) return "新增";
    if (/^fix/i.test(line)) return "修复";
    if (/^(chg|change|refactor)/i.test(line)) return "变更";
    if (/^perf/i.test(line)) return "优化";
    if (/^sec/i.test(line)) return "安全";
    return "变更";
  };
  for (const line of logEntries) {
    const sec = mapPrefix(line);
    const msg = line.replace(/^(feat|fix|chg|change|refactor|perf|sec)(\(.*?\))?:\s*/i, "");
    draft[sec].push(`- ${msg}`);
  }
  const fallbackSections = `### 变更\n- 见 git 提交历史`;
  /** 最终进版本段的内容：Unreleased 手写条目（或回退用的 git log 草稿）。 */
  const sections = {};

  // 5. 插入 CHANGELOG.md
  let changelog = readTextNormalized(CHANGELOG_PATH);

  // 消费 ## [Unreleased]：把其用户向小节并入本次发布，并从 CHANGELOG 删除该段，
  // 避免「Unreleased 永远留着 / 下次又踩」以及本次发布漏写已积累条目。
  // ⚠ 结尾那个 `$` 必须写成 `$(?![\s\S])`（真正的整串结尾）。
  // 带 `m` 标记时 `$` 匹配的是**行尾**，惰性量词 `[\s\S]*?` 会在
  // `## [Unreleased]` 这一行的行尾就停住——结果只删掉标题行、一条 `###` 项目也没收集到，
  // 整段 Unreleased 内容被孤零零留在文件抬头（不属于任何版本段），
  // 而新版本段只包含 git log 自动分类出的那几条。v2.5.0 发版时就踩上了。
  const unrelMatch = changelog.match(/^##\s+\[Unreleased\][\s\S]*?(?=\n##\s+\[|$(?![\s\S]))/m);
  /** Unreleased 里手写条目总数：>0 说明本次有权威内容，git log 草稿不参与。 */
  let unrelCollected = 0;
  if (unrelMatch) {
    const body = unrelMatch[0];
    // `亮点` 不在这里跳过：它是更新弹窗顶部的高亮导读（`changelog.mjs` 解析成
    // `highlights`，`update-release-notes.mjs` 也只剥 用户摘要/技术细节 类小节）。
    // 此前它在这个集合里，写进 [Unreleased] 的亮点会被整段丢掉——v0.3.0 只能发版后
    // 手工补一笔，而 tag 里没有，更新弹窗读 tag 那份 CHANGELOG 就永远拿不到亮点。
    const skipSec = new Set([
      "用户摘要", "技术", "说明", "Highlights",
    ]);
    // 开发者小节（技术细节 / 实现说明 / 开发者）**不在这里跳过**：它们要留在 CHANGELOG
    // 的版本段里（关于页也读同一份），「不进更新弹窗」那件事由 `update-release-notes.mjs`
    // 自己按小节名过滤。此前把 技术细节 也塞进上面这个集合，后果是 [Unreleased] 整段被删、
    // 开发记录一条没进版本段 —— v0.2.0 发版前的 27 条技术细节就是这样丢的。
    const secRe = /###\s+([^\n]+)\n([\s\S]*?)(?=\n###\s+|\n##\s+|$)/g;
    let m;
    let collected = 0;
    while ((m = secRe.exec(body))) {
      const name = m[1].trim();
      if (skipSec.has(name)) continue;
      const items = m[2]
        .split("\n")
        .map((l) => l.match(/^\s*[-*]\s+(.*)$/))
        .filter(Boolean)
        .map((x) => `- ${x[1].trim()}`);
      if (items.length) {
        if (!sections[name]) sections[name] = [];
        sections[name].push(...items);
        collected += items.length;
      }
    }
    // 🔴 硬闸：找到了 [Unreleased] 段却一条条目都没解析出来，说明是格式/换行把解析
    // 搞坏了（历史上就是 CRLF）。此时若继续往下走，下面 replace 会把整段删掉、
    // 条目一条不进新版本段 —— 静默丢数据，远比直接失败糟糕。
    if (collected === 0) {
      console.error(
        "\x1b[31m[RELEASE ERROR]\x1b[0m 找到 ## [Unreleased] 但没解析出任何条目，" +
          "已中止以免把该段整段删掉。请检查换行符（CRLF）与条目格式（每行必须是 `- xxx`）。",
      );
      process.exit(1);
    }
    changelog = changelog.replace(unrelMatch[0] + "\n", "");
    unrelCollected = collected;
    console.log(
      `\x1b[32m[5/8]\x1b[0m 已消费并归档 ## [Unreleased]（并入 ${collected} 条）`,
    );
  }
  // 有手写条目就只用手写条目（`sections` 已由上面填好），否则回退到 git log 草稿。
  if (!unrelCollected) {
    for (const [name, items] of Object.entries(draft)) if (items.length) sections[name] = items;
    console.log(
      `\x1b[33m[5/8]\x1b[0m [Unreleased] 无条目，改用 ${logEntries.length} 条 git log 标题当草稿`,
    );
  }

  // 小节顺序固定成「亮点 → 新增 → 变更 → 修复 → 优化 → 安全 → 其它（技术细节 等）」，
  // 不跟 `[Unreleased]` 里的书写顺序走：那段是边写边补的，顺序通常很乱。
  // 亮点排最前，紧跟 `### 更新摘要`，与关于页「本版亮点」的阅读顺序一致。
  const SECTION_ORDER = ["亮点", "新增", "变更", "修复", "优化", "安全"];
  const rank = (name) => {
    const i = SECTION_ORDER.indexOf(name);
    return i < 0 ? SECTION_ORDER.length : i;
  };
  const sectionLines = Object.entries(sections)
    .filter(([, items]) => items.length)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([name, items]) => `### ${name}\n${items.join("\n")}`)
    // 用两个 \n：单个 \n 会让下一个 "###" 紧贴上一条列表项，Markdown 渲染成一整段。
    .join("\n\n");
  const newBlock = `## [${next}] - ${todayISO()}\n\n### 更新摘要\n${summary}\n\n${
    sectionLines || fallbackSections
  }\n\n`;
  // 必须插到第一个「版本段标题」（## [x.y.z]）之前，而非第一个 # 行（# Changelog 大标题）之后——
  // 否则新段会被排在文件头描述与首个版本段之间，解析器按 ## [x.y.z] 分段时它既不属于任何版本、也不被 git 正确纳入。
  const firstVer = changelog.match(/^##\s+\[/m);
  if (firstVer && firstVer.index !== undefined) {
    changelog = changelog.slice(0, firstVer.index) + newBlock + changelog.slice(firstVer.index);
  } else {
    changelog = changelog.replace(/(^#.*\n)/, `$1\n${newBlock}`);
  }
  fs.writeFileSync(CHANGELOG_PATH, changelog, "utf-8");
  console.log(`\x1b[32m[5/8]\x1b[0m CHANGELOG.md 插入 [${next}] 段`);

  // 6. 插入 README 版本历史行
  let readme = readTextNormalized(README_PATH);
  // 🔴 R1：README 没有版本历史表时，replace 是静默 no-op——一路打印"插入版本行"成功，
  // 直到第 8 步 git 漏纳检查才以"README 未纳入暂存"这个误导性错误 exit 1。
  // 干净克隆（未手工补表的用户）100% 命中。改为插入前显式校验表存在。
  const TABLE_RE = /(\n\| v[\d.]+\s*\|)/;
  if (!TABLE_RE.test(readme)) {
    console.error(
      "\x1b[31m[RELEASE ERROR]\x1b[0m README.md 找不到版本历史表（形如 `| v1.2.3 | 摘要 |` 的行）。\n" +
        "发版脚本靠这张表记录版本摘要，表缺失时**不会**静默跳过。\n" +
        "修复：在 README 的「版本历史」小节补表头（| 版本 | 摘要 | + 分隔行）与一行现有版本。",
    );
    process.exit(1);
  }
  const readmeRow = `| v${next} | ${summary} |`;
  // 重复版本行检查：next 已在表里说明这个版本发过（或表没更新），再插就是重复行。
  if (new RegExp(`\\|\\s*v${next.replace(/\./g, "\\.")}\\s*\\|`).test(readme)) {
    console.error(
      `\x1b[31m[RELEASE ERROR]\x1b[0m README 版本历史表里已存在 v${next} 行（这个版本发过了？）`,
    );
    process.exit(1);
  }
  const readmeBefore = readme;
  readme = readme.replace(TABLE_RE, `\n${readmeRow}$1`);
  if (readme === readmeBefore) {
    console.error("\x1b[31m[RELEASE ERROR]\x1b[0m README 版本行插入失败（replace 未生效，格式变过？）");
    process.exit(1);
  }
  fs.writeFileSync(README_PATH, readme, "utf-8");
  console.log(`\x1b[32m[6/8]\x1b[0m README.md 插入版本行`);

  // 7. 重新生成 changelog.generated.ts
  run(`node ${path.join(__dirname, "gen-changelog.mjs")}`, DESKTOP);
  console.log(`\x1b[32m[7/8]\x1b[0m 已重新生成 changelog.generated.ts`);

  // 8. git add + commit + push + tag
  // tag 预检（Y10）：本地 tag 已存在时 `git tag` 会失败——但那一刻 commit 和 push
  // 都已经完成，CI 已被触发，留下"版本号发了、tag 没打上"的半完成状态。
  // 预检放在 commit **之前**，失败时没有任何东西被推出去。
  try {
    execSync(`git rev-parse -q --verify refs/tags/${tagName}`, { cwd: ROOT, stdio: "pipe" });
    console.error(
      `\x1b[31m[RELEASE ERROR]\x1b[0m 本地 tag ${tagName} 已存在（这个版本发过了？）。\n` +
        `如确需重发：git tag -d ${tagName} && git push origin :refs/tags/${tagName}`,
    );
    process.exit(1);
  } catch {
    // 本地不存在 = 正常路径
  }
  // 远端 tag 也查一遍（clone 后没 fetch tags 的机器上，本地没有远端可能有）。
  // 查不到不阻断（离线/无 origin 权限时不该卡住发版），push tag 时会暴露。
  try {
    const remoteTag = execSync(`git ls-remote --tags origin refs/tags/${tagName}`, {
      cwd: ROOT,
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (remoteTag) {
      console.error(
        `\x1b[31m[RELEASE ERROR]\x1b[0m 远端 origin 上已有 tag ${tagName}。\n` +
          `如确需重发：git push origin :refs/tags/${tagName}`,
      );
      process.exit(1);
    }
  } catch {
    // 无法访问 origin：交给 push tag 环节暴露
  }
  const files = [
    "desktop/src-tauri/Cargo.toml",
    "desktop/src-tauri/Cargo.lock",
    "desktop/src-tauri/tauri.conf.json",
    "desktop/package.json",
    "CHANGELOG.md",
    "README.md",
    "desktop/src/lib/changelog.generated.ts",
  ];
  run(`git add ${files.map((f) => `"${f}"`).join(" ")}`);
  // 防漏纳：确认 7 个发版文件都已进入暂存区（CHANGELOG 写入异常时 git add 会静默跳过）。
  // 注意：不能用 `git status --porcelain` 判空——git add 之后这些文件在 porcelain 里
  // 显示为已暂存（首列 M），输出必然非空，会误判为漏纳而中止。改查暂存区文件清单。
  const staged = execSync("git diff --cached --name-only", { cwd: ROOT, stdio: "pipe" })
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = files.filter((f) => !staged.includes(f));
  if (missing.length) {
    console.error(
      `\x1b[31m[RELEASE ERROR]\x1b[0m 以下发版文件未被 git 纳入暂存区，已中止以免漏发：\n${missing.join("\n")}`,
    );
    process.exit(1);
  }
  run(`git commit -m "chg: 发版 v${next}"`);
  console.log(`\x1b[32m[8/8]\x1b[0m 已 commit 发版 v${next}`);

  const wantPush = YES || (await ask("确认 push main 并打 tag v" + next + " ? (y/N)", "")) === "y";
  if (!wantPush) {
    console.log("\x1b[33m已 commit，未 push/tag。\x1b[0m 手动执行：");
    console.log(`  git push origin main && git tag v${next} && git push origin v${next}`);
    return;
  }
  // 第 1 步刚跑完全量 15 项（≈12 分钟），这里再让 pre-push 跑一遍是纯重复，
  // 而且 main 与 tag 是两次 push ⇒ 24 分钟白等。所以显式告诉钩子「已验过」。
  // 这不是绕过门禁：门禁就在上面第 1 步，失败的话根本走不到这行。
  const PUSH_ENV = { NCFORGE_PUSH_GATE: "0" };
  run(`git push origin main`, ROOT, true, PUSH_ENV);
  run(`git tag ${tagName}`);
  run(`git push origin ${tagName}`, ROOT, true, PUSH_ENV);
  console.log(`\x1b[32m✅ 发版 ${tagName} 完成，CI 正在构建 Windows 包（约 28 分钟）。\x1b[0m`);
  // mac 默认不发（见文件头说明）：把"要 mac 时敲什么"直接打出来，省得回头翻 workflow。
  console.log(`\x1b[36m   需要 macOS 包（+约 26 分钟，别重推 tag）：\x1b[0m`);
  console.log(`   gh workflow run build.yml --ref ${tagName} -f with_macos=true`);

  if (NO_MIRROR) {
    console.log(`\x1b[33m[--no-mirror] 跳过 Gitee 镜像。\x1b[0m 等 CI 出完 Release 后手动跑（别忘——v0.2.0 就是忘在这）：`);
    console.log(`   NO_PROXY=gitee.com npm run mirror:gitee -- ${tagName}`);
    return;
  }
  await autoMirror(tagName);
}

// ── 第 9 步：等 Release 出来，自动跑 Gitee 镜像 ──────────────────────────────
// 背景：更新器三个端点里 Gitee 是国内用户的兜底源（gh-pages 404、github.com 常超时），
// 镜像没补的话老版本用户永远收不到更新提示（v0.2.0 实测）。所以默认自动跑。

function resolveGithubRepo() {
  const url = execSync("git remote get-url origin", { cwd: ROOT, stdio: "pipe" }).toString().trim();
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) throw new Error(`无法从 git remote 推断 GitHub 仓库（${url || "空"}）`);
  return `${m[1]}/${m[2]}`;
}

/** token：环境变量优先，其次 gitignore 的 .gitee-token（与 mirror-gitee.mjs 同一套解析）。 */
function findGiteeToken() {
  const env = (process.env.GITEE_TOKEN || "").trim();
  if (env) return env;
  for (const p of [path.join(ROOT, ".gitee-token"), path.join(DESKTOP, ".gitee-token")]) {
    try {
      const t = fs.readFileSync(p, "utf-8").split(/\r?\n/)[0].trim();
      if (t) return t;
    } catch {
      /* 文件不存在 */
    }
  }
  return "";
}

/** 每 60s 探一次 Release：已发布且更新清单与安装包齐全才就绪。超时返回 false。 */
async function waitForReleaseAssets(tagName, timeoutMin = 45) {
  const ghRepo = resolveGithubRepo();
  const deadline = Date.now() + timeoutMin * 60_000;
  console.log(`\x1b[35m[9] 等待 GitHub Release ${tagName} 出全产物（校验更新清单及安装包，最长 ${timeoutMin} 分钟）…\x1b[0m`);
  while (Date.now() < deadline) {
    try {
      const out = execSync(`gh release view ${tagName} -R ${ghRepo} --json isDraft,assets`, {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf-8",
      });
      const rel = JSON.parse(out);
      const names = (rel.assets || []).map((a) => a.name);
      if (!rel.isDraft && names.includes("updater.json")) {
        const manifest = JSON.parse(execFileSync("gh", [
          "release", "download", tagName, "-R", ghRepo, "--pattern", "updater.json", "--output", "-",
        ], { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }));
        const windows = manifest.platforms?.["windows-x86_64"];
        const hasMac = Boolean(manifest.platforms?.["darwin-aarch64"]);
        if (manifest.version === tagName.slice(1) && windows?.url &&
            (!hasMac || manifest.platforms["darwin-aarch64"].url) &&
            releaseReadiness(manifest, rel.assets, { wantMac: hasMac }).ready) return true;
      }
    } catch {
      /* Release 还没建出来（CI 还在跑），等下一轮 */
    }
    await new Promise((r) => setTimeout(r, 60_000));
    process.stdout.write(".");
  }
  return false;
}

/**
 * 镜像之前的核对：把「门禁绿没绿」与「产物齐没齐」分开报。
 *
 * 为什么要有这一步：tag 推的 CI 里 frontend job 会跑但**不阻断**出包（见 build.yml
 * 里 frontend 的注释），所以「Release 出全产物」不等于「门禁全绿」。v0.5.0 就是
 * 产物齐全、run 标红，谁也没注意，直到手动补 mac 才发现 309 行的 ResultTable。
 *
 * 查不到只警告、不退出：核对失败不该挡住镜像（镜像才是这一步的活）。
 */
async function reportRunOutcome(tagName) {
  const ghRepo = resolveGithubRepo();
  try {
    const list = JSON.parse(
      execFileSync("gh", ["run", "list", "-R", ghRepo, "--workflow", "build.yml", "-L", "30", "--json", "databaseId,headBranch,createdAt"], {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf-8",
      }),
    );
    // head_branch 对 tag 触发的 run 就是 tag 名；同名可能有多条（重发），取最新。
    const mine = list
      .filter((r) => r.headBranch === tagName)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (!mine.length) throw new Error(`找不到 ${tagName} 的构建 run`);

    const runId = mine[0].databaseId;
    const view = JSON.parse(
      execFileSync("gh", ["run", "view", String(runId), "-R", ghRepo, "--json", "jobs"], { cwd: ROOT, stdio: "pipe", encoding: "utf-8" }),
    );
    const result = summarizeRunJobs(view.jobs || []);
    const { level, title, hints } = describeVerdict(result);
    const color = level === "ok" ? "\x1b[32m" : level === "warn" ? "\x1b[33m" : "\x1b[31m";
    const mark = level === "ok" ? "✅" : level === "warn" ? "⚠️ " : "❌";

    console.log(`\x1b[35m[门禁核对]\x1b[0m run ${runId} -R ${ghRepo}`);
    for (const j of [...result.gates, ...result.builds]) {
      const icon = j.conclusion === "success" ? "✅" : j.conclusion === "skipped" ? "⏭ " : "❌";
      console.log(`   ${icon} ${formatJobLine(j)}`);
    }
    console.log(`${color}${mark} [结论] ${title}\x1b[0m`);
    for (const h of hints) console.log(`   ${h}`);
    return result;
  } catch (e) {
    console.log(`\x1b[33m[门禁核对] 跳过（${e.message || e}）。手动核：gh run view <id> --json jobs\x1b[0m`);
    return null;
  }
}

async function autoMirror(tagName) {
  const ghRepo = resolveGithubRepo();
  if (!(await waitForReleaseAssets(tagName))) {
    console.error(
      `\x1b[31m[GITEE MIRROR ERROR]\x1b[0m 等了 45 分钟 Release 还没出全（CI 挂了或很慢）。\n` +
        `发版本身已完成；镜像请手动补（可先查 CI：gh run list -R ${ghRepo} -L 3）：\n` +
        `  NO_PROXY=gitee.com npm run mirror:gitee -- ${tagName}`,
    );
    process.exit(1);
  }
  // 门禁红不挡镜像（产物是好的，用户能正常升级）；但**产物没出全必须挡**——
  // 残缺的 Release 镜像到 Gitee 会被当成「已同步」，老版本用户反而收到半套更新。
  const outcome = await reportRunOutcome(tagName);
  if (outcome && (outcome.verdict === "build-missing" || outcome.verdict === "both-bad")) {
    console.error(
      `\x1b[31m[GITEE MIRROR ERROR]\x1b[0m 产物没出全，先不镜像（残缺镜像会被后续对账当成"已同步"）。\n` +
        `修好再补：node scripts/reship.mjs ${tagName} --full\n` +
        `出齐之后只补镜像：node scripts/reship.mjs ${tagName} --mirror-only`,
    );
    process.exit(1);
  }

  const token = findGiteeToken();
  if (!token) {
    console.log(`\x1b[33m[9] 未找到 GITEE_TOKEN（环境变量或 .gitee-token 都没有）。\x1b[0m CI Release 已就绪，手动跑：`);
    console.log(`   NO_PROXY=gitee.com npm run mirror:gitee -- ${tagName}`);
    return;
  }
  console.log(`\x1b[35m[9] Release 已就绪，自动跑 Gitee 镜像（NO_PROXY=gitee.com）…\x1b[0m`);
  try {
    execSync(`node ${JSON.stringify(path.join(__dirname, "mirror-gitee.mjs"))} ${tagName}`, {
      cwd: DESKTOP,
      stdio: "inherit",
      env: { ...process.env, GITEE_TOKEN: token, NO_PROXY: "gitee.com", no_proxy: "gitee.com" },
    });
    console.log(`\x1b[32m✅ Gitee 镜像完成，更新器兜底源已是 ${tagName}。\x1b[0m`);
  } catch {
    console.error(
      `\x1b[31m[GITEE MIRROR ERROR]\x1b[0m 镜像脚本失败（发版本身已成功）。\n` +
        `重跑是幂等的（已上传附件会跳过）：\n` +
        `  NO_PROXY=gitee.com npm run mirror:gitee -- ${tagName}`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\x1b[31m[RELEASE ERROR]\x1b[0m ${e.message || e}`);
  // Y8：中途失败（门禁红 / git 操作失败）时工作区已留下半截改动，用户最需要的是
  // "怎么收拾"。不给指引的话，常见后果是带着改了一半的版本文件继续开发。
  console.error(
    "\n\x1b[33m恢复指引：\x1b[0m 本次发版可能已改动部分文件（Cargo.toml / CHANGELOG.md / README.md / changelog.generated.ts 等）。\n" +
      "  · 放弃本次发版：git checkout -- .   （会丢弃所有未提交改动，先 git status 确认没有别的工作成果）\n" +
      "  · 保留改动手工处理：git status 查看后自行决定去留\n" +
      "  · 已 commit 但 push 失败：git log --oneline -3 确认后重试 push",
  );
  process.exit(1);
});
