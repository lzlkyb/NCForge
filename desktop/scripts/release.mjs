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
 *   npm run release -- --patch --skip-tests  # 跳过 cargo test + clippy 门禁（不推荐）
 *
 * 流程（自动）：
 *   1. 计算新版本号 → 只改 Cargo.toml（唯一真源）
 *   2. 调 sync-version：同步 tauri.conf.json + package.json（Cargo.lock 由 cargo 更新）
 *   3. 在 CHANGELOG.md 顶部插新版本段（更新摘要交互填写；变更列表由 git log 自动分类生成草稿）
 *   4. 在 README 版本历史表插行
 *   5. 重新生成 changelog.generated.ts
 *   6. cargo test + cargo clippy --no-default-features 门禁（不过不提交）
 *   7. git add 相关文件 → commit → push origin main → tag vX.Y.Z → push tag
 *
 * 设计要点：
 *   - 版本号只动 Cargo.toml 一处，其余全自动同步（治愈"漏改版本号"）。
 *   - 非 TTY 环境（无 --yes）只准备到 commit，不 push/tag，避免误发。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

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
const SKIP_TESTS = hasFlag("--skip-tests");
let bumpType = null;
let explicitVersion = getOpt("--version");
if (hasFlag("--patch")) bumpType = "patch";
else if (hasFlag("--minor")) bumpType = "minor";
else if (hasFlag("--major")) bumpType = "major";
if (!bumpType && !explicitVersion) bumpType = "patch"; // 默认 patch

// ── 工具函数 ──
function run(cmd, cwd = ROOT, inherit = true) {
  console.log(`\x1b[35m$ ${cmd}\x1b[0m  (cwd: ${path.relative(ROOT, cwd) || "."})`);
  return execSync(cmd, { cwd, stdio: inherit ? "inherit" : "pipe" });
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
    console.log(`  1. Cargo.toml version: ${current} → ${next}`);
    console.log("  2. node scripts/sync-version.mjs（同步 tauri.conf.json + package.json）");
    console.log(`  3. CHANGELOG.md 顶部插入 ## [${next}] - ${todayISO()} 段`);
    console.log("  4. README.md 版本历史表插入行");
    console.log("  5. node scripts/gen-changelog.mjs（重新生成 changelog.generated.ts）");
    if (!SKIP_TESTS) console.log("  6. cargo test + cargo clippy --no-default-features 门禁");
    else console.log("  6. [--skip-tests] 仅 cargo check --no-default-features 保底");
    console.log(`  7. semver/tag 预检 → git add 版本文件+CHANGELOG+README+generated.ts → commit → push → tag ${tagName} → push tag`);
    return;
  }

  // 1. bump Cargo.toml（唯一真源）
  let cargoTxt = fs.readFileSync(CARGO_PATH, "utf-8");
  cargoTxt = cargoTxt.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`);
  fs.writeFileSync(CARGO_PATH, cargoTxt, "utf-8");
  console.log(`\x1b[32m[1/7]\x1b[0m Cargo.toml → ${next}`);

  // 2. 同步其余文件
  run(`node ${path.join(__dirname, "sync-version.mjs")}`, DESKTOP);
  console.log(`\x1b[32m[2/7]\x1b[0m 已同步 tauri.conf.json + package.json`);

  // 3. 收集 git log 生成变更草稿
  let logEntries = [];
  try {
    const lastTag = execSync("git describe --tags --abbrev=0", { cwd: ROOT, stdio: "pipe" })
      .toString()
      .trim();
    const log = execSync(`git log --oneline ${lastTag}..HEAD`, { cwd: ROOT, stdio: "pipe" })
      .toString()
      .trim();
    logEntries = log ? log.split("\n").map((l) => l.replace(/^[0-9a-f]+\s+/, "")) : [];
    console.log(`\x1b[32m[3/7]\x1b[0m 自 ${lastTag} 起 ${logEntries.length} 条 commit 纳入草稿`);
  } catch {
    console.log("\x1b[33m[3/7]\x1b[0m 未找到上一 tag，跳过 git log 草稿");
  }

  // 交互：更新摘要（用户向，显示在更新弹框）
  const summary =
    (await ask(`填写「更新摘要」（用户向，回车用默认）:`, `v${next} 版本更新`)) ||
    `v${next} 版本更新`;

  // 把 git log 按前缀分类成 CHANGELOG 小节草稿
  const sections = { 新增: [], 变更: [], 修复: [], 优化: [], 安全: [] };
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
    sections[sec].push(`- ${msg}`);
  }
  const fallbackSections = `### 变更\n- 见 git 提交历史`;

  // 4. 插入 CHANGELOG.md
  let changelog = readTextNormalized(CHANGELOG_PATH);

  // 消费 ## [Unreleased]：把其用户向小节并入本次发布，并从 CHANGELOG 删除该段，
  // 避免「Unreleased 永远留着 / 下次又踩」以及本次发布漏写已积累条目。
  // ⚠ 结尾那个 `$` 必须写成 `$(?![\s\S])`（真正的整串结尾）。
  // 带 `m` 标记时 `$` 匹配的是**行尾**，惰性量词 `[\s\S]*?` 会在
  // `## [Unreleased]` 这一行的行尾就停住——结果只删掉标题行、一条 `###` 项目也没收集到，
  // 整段 Unreleased 内容被孤零零留在文件抬头（不属于任何版本段），
  // 而新版本段只包含 git log 自动分类出的那几条。v2.5.0 发版时就踩上了。
  const unrelMatch = changelog.match(/^##\s+\[Unreleased\][\s\S]*?(?=\n##\s+\[|$(?![\s\S]))/m);
  if (unrelMatch) {
    const body = unrelMatch[0];
    const skipSec = new Set([
      "用户摘要", "技术", "技术细节", "说明", "实现说明", "开发者", "亮点", "Highlights",
    ]);
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
    console.log(
      `\x1b[32m[4/7]\x1b[0m 已消费并归档 ## [Unreleased]（并入 ${collected} 条）`,
    );
  }

  const sectionLines = Object.entries(sections)
    .filter(([, items]) => items.length)
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
  console.log(`\x1b[32m[4/7]\x1b[0m CHANGELOG.md 插入 [${next}] 段`);

  // 5. 插入 README 版本历史行
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
  console.log(`\x1b[32m[5/7]\x1b[0m README.md 插入版本行`);

  // 6. 重新生成 changelog.generated.ts
  run(`node ${path.join(__dirname, "gen-changelog.mjs")}`, DESKTOP);
  console.log(`\x1b[32m[6/7]\x1b[0m 已重新生成 changelog.generated.ts`);

  // 7. 门禁：cargo test + clippy
  // cargo test 必须 --no-default-features：notifications feature 会拉入 GUI DLL
  // 导致 test 二进制 0xc0000139（与 CI/pre-push 钩子保持一致）
  if (!SKIP_TESTS) {
    console.log("\x1b[35m[门禁] cargo test --no-default-features\x1b[0m");
    run("cargo test --no-default-features", path.join(DESKTOP, "src-tauri"));
    console.log("\x1b[35m[门禁] cargo clippy --no-default-features\x1b[0m");
    run("cargo clippy --no-default-features", path.join(DESKTOP, "src-tauri"));
  } else {
    // --skip-tests 跳的是"慢门禁"（test/clippy），不是"不编译"：check 只要几十秒，
    // 却能拦住拼写错误/类型错误这类一发版就红的事。留个保底。
    console.log("\x1b[35m[门禁] --skip-tests：跳过 test/clippy，仍跑 cargo check 保底\x1b[0m");
    run("cargo check --no-default-features", path.join(DESKTOP, "src-tauri"));
  }

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
  console.log(`\x1b[32m[7/7]\x1b[0m 已 commit 发版 v${next}`);

  const wantPush = YES || (await ask("确认 push main 并打 tag v" + next + " ? (y/N)", "")) === "y";
  if (!wantPush) {
    console.log("\x1b[33m已 commit，未 push/tag。\x1b[0m 手动执行：");
    console.log(`  git push origin main && git tag v${next} && git push origin v${next}`);
    return;
  }
  run(`git push origin main`);
  run(`git tag ${tagName}`);
  run(`git push origin ${tagName}`);
  console.log(`\x1b[32m✅ 发版 ${tagName} 完成，CI 正在构建。\x1b[0m`);
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
