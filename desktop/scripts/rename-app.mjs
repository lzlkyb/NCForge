#!/usr/bin/env node
/**
 * rename-app.mjs
 * 一键把壳子改成你的应用：产品标识在仓库里散落十余处，手工改必漏
 * （漏一处的典型症状：托盘 tooltip 还叫 MyApp、CI 找不到 exe、updater 404、
 *  Rust 编译不过——包名一改 crate 名就从 desktop_app_shell 变成新名，源码里的
 *  use desktop_app_shell::* 不改直接 E0432）。
 * 本脚本把它们一次改齐，复制壳子后的第一步就是跑它。
 *
 * 用法：
 *   node scripts/rename-app.mjs <app-name> [--repo owner/repo] [--identifier com.example.app] [--display "显示名"]
 *
 *   <app-name>    kebab-case 短名，同时是 Cargo 包名（= exe 名）与 npm 包名，如 my-tool
 *   --repo        GitHub owner/repo；给了就同步 about.ts 仓库地址与 updater 端点占位符
 *   --identifier  反向域名 bundle id；不给则默认 com.example.<app-name>
 *   --display     给人看的名字（窗口标题/托盘/关于卡片）；不给则由短名推导（my-tool → My Tool）
 *
 * 改了哪些文件（各文件内全部出现处）：
 *   src-tauri/Cargo.toml        name（同时决定 exe 名 → CI 的 exe 路径随之改）
 *   src-tauri/tauri.conf.json   productName / identifier / 窗口 title / updater endpoints（给了 --repo 时）
 *   package.json(+ -lock.json)  name
 *   src-tauri/src/branding.rs   APP_DISPLAY_NAME（托盘 tooltip 经 format! 运行时绑定）
 *   src-tauri/src 与 tests 下所有 .rs   crate 名 desktop_app_shell → 下划线形式（不改编译不过）
 *   src/lib/about.ts            APP_INFO.name / author / repoUrl / description
 *   index.html / motion-preview.html / scripts/build-design-preview.mjs   标题里的显示名
 *   src/design-preview/main.tsx   预览页品牌区/页脚显示名 + 壳子目录名与 exe 进程名
 *   scripts/generate-updater-json.mjs   更新说明默认文案里的显示名 + FALLBACK owner/repo
 *   README.md / CLAUDE.md / LICENSE    根文档大标题与版权行的壳子名
 *   ../.github/workflows/build.yml      exe 名 / zip 前缀 / artifact 名
 *
 * 存储键不在此列：windowState/appearance 的 localStorage key 与更新历史的协议标记
 * 都由 APP_SLUG / 通用标记动态推导，改名自动跟随（见 lib/about.ts 的 APP_SLUG）。
 *
 * 替换是子串级的（build.yml 的 desktop-app-shell_${VERSION}_xxx.zip 这类复合名也要换）。
 * 幂等靠增量模式：已改名过的仓库重跑时，已是目标状态的替换对逐对跳过——
 * 「补 --repo 重跑」不会把 myshell-app-macos 二次替换成 mymyshell-app-macos。
 *
 * 脚本**不会**做（也必须你做）的事：
 *   1. icons/ 换图标（现在用的是壳子占位图）
 *   2. `npx tauri signer generate` 生成更新签名密钥对：公钥填 tauri.conf.json 的
 *      plugins.updater.pubkey，私钥存 GitHub secret TAURI_SIGNING_PRIVATE_KEY（见 README）
 *   3. Cargo.lock / package-lock.json 若已存在，跑 cargo check / npm install 让锁文件跟上新包名
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");          // desktop/
const REPO_ROOT = path.resolve(ROOT, "..");          // 仓库根

const OLD_SLUG = "desktop-app-shell";
const OLD_DISPLAY = "MyApp";
const OLD_OWNER = "your-name";
const OLD_REPO = "your-app";

function fail(msg) {
  console.error(`\x1b[31m[RENAME ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`\x1b[36m[RENAME]\x1b[0m ${msg}`);
}
function success(msg) {
  console.log(`\x1b[32m[RENAME OK]\x1b[0m ${msg}`);
}

// ── 解析参数 ──
const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith("--")) {
  console.error("用法: node scripts/rename-app.mjs <app-name> [--repo owner/repo] [--identifier com.example.app] [--display \"显示名\"]");
  process.exit(1);
}
const slug = args[0];
let repoArg = null;
let identifier = null;
let display = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--repo") repoArg = args[++i];
  else if (args[i] === "--identifier") identifier = args[++i];
  else if (args[i] === "--display") display = args[++i];
  else fail(`未知参数: ${args[i]}`);
}

// ── 校验 ──
// kebab-case 且合法 Cargo 包名：小写字母/数字/连字符，不以数字或连字符开头，
// 不以连字符结尾。Cargo 包名还会变成 exe 名与 Windows 服务/防火墙规则名，宁严勿宽。
if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug)) {
  fail(`app-name "${slug}" 不合法：需为 kebab-case 小写短名（如 my-tool），且不能以数字开头`);
}
let owner = null;
let repoName = null;
if (repoArg) {
  const m = repoArg.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) fail(`--repo 需为 owner/repo 格式，收到: ${repoArg}`);
  owner = m[1];
  repoName = m[2];
}
if (!identifier) identifier = `com.example.${slug}`;
// 显示名：不给就从短名推导（my-tool → My Tool）
if (!display) {
  display = slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

if (slug === OLD_SLUG) {
  fail(`新名字与壳子当前名相同（${OLD_SLUG}），无需改名`);
}

info(`短名(slug):    ${OLD_SLUG} → ${slug}`);
info(`显示名:        ${OLD_DISPLAY} → ${display}`);
info(`identifier:    com.example.shell → ${identifier}`);
if (repoArg) info(`仓库:          ${owner}/${repoName}`);

// ── 替换引擎 ──
// 子串替换（build.yml 的 desktop-app-shell_${VERSION}_xxx.zip 这类复合名也要换）。
// 幂等靠「增量模式」：仓库已改名过时（Cargo.toml 的 name 已不是壳子名），
// 已是目标状态的替换对逐对跳过——官方建议的「补 --repo 重跑」不会把
// myshell-app-macos 二次替换成 mymyshell-app-macos。首次改名不走该闸，
// 避免新名与文件既有内容撞车（如 slug 取名 app 撞上 apple-darwin）被误跳。
const cargoTomlPath = path.join(REPO_ROOT, "desktop/src-tauri/Cargo.toml");
const ALREADY_RENAMED = fs.existsSync(cargoTomlPath)
  && !fs.readFileSync(cargoTomlPath, "utf-8").includes(`name = "${OLD_SLUG}"`);
if (ALREADY_RENAMED) {
  // 已改名仓库重跑的正经姿势是「补 --repo」；若换了 slug，替换对旧值全部落空，
  // 只能留下半新半旧的仓库——明确拒绝并指路，好过 critical 断言那句误导人的
  // 「格式变过？请手工核对」。
  const currentName = fs.readFileSync(cargoTomlPath, "utf-8").match(/^name = "([^"]+)"/m)?.[1];
  if (currentName && currentName !== slug) {
    fail(`仓库已改名为 "${currentName}"，与本次的 "${slug}" 不同。本脚本的同 slug 重跑只用于补 --repo 等信息；想换名字请重新复制一份壳子再跑。`);
  }
  info("检测到仓库已改名过：进入增量模式，已是目标状态的替换对将跳过。");
}

function applyReplacements(relPath, pairs, { optional = false, critical = [] } = {}) {
  const abs = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(abs)) {
    if (optional) {
      info(`  ⊘ ${relPath}（不存在，跳过）`);
      return 0;
    }
    fail(`找不到文件: ${relPath}（脚本与目录结构不匹配？）`);
  }
  let content = fs.readFileSync(abs, "utf-8");
  let total = 0;
  const details = [];
  const skipped = [];
  for (const [from, to] of pairs) {
    if (!from) continue; // 允许传空串表示"本项未配置，跳过"
    const count = content.split(from).length - 1;
    if (count === 0) {
      skipped.push(from); // 旧值不在：无需改，或格式漂移（critical 断言会兜底）
      continue;
    }
    if (ALREADY_RENAMED && content.includes(to)) {
      skipped.push(from); // 增量模式幂等闸：已是目标状态
      continue;
    }
    content = content.split(from).join(to);
    total += count;
    details.push(`${from} ×${count}`);
  }
  if (total === 0) {
    info(`  = ${relPath}（${skipped.length ? `跳过 ${skipped.length} 对：已是目标状态或无需修改` : "无需修改"}）`);
  } else {
    fs.writeFileSync(abs, content, "utf-8");
    const skipNote = skipped.length ? `；跳过 ${skipped.length} 对（已是目标状态）` : "";
    success(`  ✓ ${relPath}: ${details.join(" / ")}${skipNote}`);
  }
  // 关键项改后断言：包名/exe 名/identifier 漏改不会响，只会静默地错
  for (const needle of critical) {
    if (!fs.readFileSync(abs, "utf-8").includes(needle)) {
      fail(`关键项校验失败: ${relPath} 中未找到预期值 "${needle}"（格式变过？请手工核对）`);
    }
  }
  return total;
}

// 递归替换目录下所有 .rs 文件的 crate 名（子串替换 + 增量模式幂等闸）。
// 包名 desktop-app-shell 对应的 crate 名是 desktop_app_shell（连字符变下划线）；
// 包名一改，crate 名跟着变，源码与测试里的 use desktop_app_shell::* 不同步改
// 就是 E0432——这是复制壳子后最容易踩的坑。
function applyCrateRenameToDir(relDir, from, to) {
  const abs = path.join(REPO_ROOT, relDir);
  if (!fs.existsSync(abs)) {
    info(`  ⊘ ${relDir}/（目录不存在，跳过）`);
    return;
  }
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".rs")) {
        const before = fs.readFileSync(full, "utf-8");
        if (ALREADY_RENAMED && before.includes(to)) continue; // 增量模式幂等闸
        const count = before.split(from).length - 1;
        if (count > 0) {
          fs.writeFileSync(full, before.split(from).join(to), "utf-8");
          total += 1;
          success(`  ✓ ${path.relative(REPO_ROOT, full)}: ${from} → ${to}`);
        }
      }
    }
  };
  walk(abs);
  if (total === 0) info(`  = ${relDir}/**/*.rs（已是目标状态或无需修改）`);
}

info("开始改写产品标识：");

// 1. Cargo.toml：包名 = exe 名。critical 断言防「没匹配上但假装成功」
//    （包名漏改 = exe 名不变，build.yml 有显式检查会红，属响亮失败，仍断言双保险）。
applyReplacements("desktop/src-tauri/Cargo.toml", [
  [`name = "${OLD_SLUG}"`, `name = "${slug}"`],
], { critical: [`name = "${slug}"`] });

// 2. tauri.conf.json：productName / identifier / 窗口标题 / updater 端点。
//    endpoints 只有给了 --repo 才动；没给则保持 YOUR-USER 占位符并在结尾提醒。
//    critical：productName/identifier 漏改不会响，只会让安装目录、窗口标题、bundle id
//    静默地错——这两项写回后必须验证新值在文件里。
applyReplacements("desktop/src-tauri/tauri.conf.json", [
  [`"productName": "${OLD_SLUG}"`, `"productName": "${slug}"`],
  [`"identifier": "com.example.shell"`, `"identifier": "${identifier}"`],
  [`"title": "${OLD_DISPLAY}"`, `"title": "${display}"`],
  ...(repoArg
    ? [
        [`https://YOUR-USER.github.io/YOUR-REPO/updater.json`, `https://${owner}.github.io/${repoName}/updater.json`],
        [`https://github.com/YOUR-USER/YOUR-REPO/releases/latest/download/updater.json`, `https://github.com/${owner}/${repoName}/releases/latest/download/updater.json`],
      ]
    : []),
], { critical: [`"productName": "${slug}"`, `"identifier": "${identifier}"`] });

// 3. package.json（+ 锁文件若已存在）。
applyReplacements("desktop/package.json", [
  [`"name": "${OLD_SLUG}"`, `"name": "${slug}"`],
]);
applyReplacements("desktop/package-lock.json", [
  [`"${OLD_SLUG}"`, `"${slug}"`],
], { optional: true });

// 4. branding.rs：显示名（三条托盘 tooltip 经 format! 运行时绑定 APP_DISPLAY_NAME，
// 无需逐条替换——2026-10-27 从手抄文案改成 format! 拼接后这里只剩一个替换点）。
applyReplacements("desktop/src-tauri/src/branding.rs", [
  [OLD_DISPLAY, display],
]);

// 5. about.ts：显示名 / 作者 / 仓库地址 / 描述。
applyReplacements("desktop/src/lib/about.ts", [
  [`name: "${OLD_DISPLAY}"`, `name: "${display}"`],
  [`description: "基于 ${OLD_SLUG} 的桌面应用"`, `description: "${display} —— 一个桌面应用"`],
  ...(repoArg
    ? [
        [`author: "${OLD_OWNER}"`, `author: "${owner}"`],
        [`repoUrl: "https://github.com/${OLD_OWNER}/${OLD_REPO}"`, `repoUrl: "https://github.com/${owner}/${repoName}"`],
      ]
    : []),
]);

// 6. 三处 HTML/脚本标题里的显示名 + design-preview 里的壳子目录名/进程名。
applyReplacements("desktop/index.html", [[OLD_DISPLAY, display]]);
applyReplacements("desktop/motion-preview.html", [[OLD_DISPLAY, display]]);
applyReplacements("desktop/scripts/build-design-preview.mjs", [[OLD_DISPLAY, display]]);
// design-preview 预览页：品牌区/页脚的显示名 + "复制"卡片的 cp 示例与"应用进程"
// 卡片里的 exe 名。两类都要换：只换 slug 会留下满页 "MyApp"（showcase 门面）。
applyReplacements("desktop/src/design-preview/main.tsx", [
  [OLD_DISPLAY, display],
  [OLD_SLUG, slug],
], { optional: true });

// 7. Rust crate 名：Cargo.toml 的 name 决定 lib/bin 的 crate 名（连字符→下划线），
//    main.rs 的 use desktop_app_shell::*、两个集成测试的 use 语句都必须同步，否则 E0432。
const OLD_CRATE = OLD_SLUG.replace(/-/g, "_");
const NEW_CRATE = slug.replace(/-/g, "_");
info(`Rust crate 名: ${OLD_CRATE} → ${NEW_CRATE}`);
applyCrateRenameToDir("desktop/src-tauri/src", OLD_CRATE, NEW_CRATE);
applyCrateRenameToDir("desktop/src-tauri/tests", OLD_CRATE, NEW_CRATE);

// 8. generate-updater-json.mjs：更新说明默认文案 + FALLBACK owner/repo。
//    FALLBACK 只在 CI 外手动跑 updater:generate 时兜底（CI 有 GITHUB_REPOSITORY env）。
applyReplacements("desktop/scripts/generate-updater-json.mjs", [
  [`MyApp v\${version}`, `${display} v\${version}`],
  ...(repoArg
    ? [
        [`["${OLD_OWNER}", "${OLD_REPO}"]`, `["${owner}", "${repoName}"]`],
      ]
    : []),
]);

// 9. CI：exe 名（Cargo 包名变了，构建产物路径跟着变）、zip 前缀、artifact 名。
applyReplacements(".github/workflows/build.yml", [
  [OLD_SLUG, slug],
  ["shell-macos", `${slug}-macos`],
  ["shell-windows", `${slug}-windows`],
]);

// 10. 仓库根文档的壳子身份：README 大标题 / CLAUDE.md 大标题 / LICENSE 版权行。
//     这三处不在桌面目录内，但同样是「壳子名没改干净」的可见残留。
//     带 `# `/`Copyright ` 前缀做锚，不会误伤 README/CLAUDE.md 里作为复制示例的
//     `cp -r desktop-app-shell my-app`（那正是演示「从壳子复制」，保留旧名才对）。
applyReplacements("README.md", [
  [`# ${OLD_SLUG}`, `# ${display}`],
]);
applyReplacements("CLAUDE.md", [
  [`# ${OLD_SLUG} 项目开发规则`, `# ${display} 项目开发规则`],
]);
applyReplacements("LICENSE", [
  [`Copyright (c) 2026 ${OLD_SLUG} contributors`, `Copyright (c) 2026 ${owner ?? slug} contributors`],
]);

// ── 收尾提醒 ──
console.log("");
info("改名完成。还剩几件脚本不能替你做、但发版前必须做的事：");
let todoNo = 0;
console.log(`  ${++todoNo}. 换图标：desktop/src-tauri/icons/（现在还是壳子占位图）`);
console.log(`  ${++todoNo}. 生成更新签名密钥对（自动更新的命脉）：`);
console.log("       npx tauri signer generate -w ~/.tauri/" + slug + ".key");
console.log("     公钥 → desktop/src-tauri/tauri.conf.json 的 plugins.updater.pubkey");
console.log("     私钥 → GitHub 仓库 secret TAURI_SIGNING_PRIVATE_KEY（整个文件内容）");
if (!repoArg) {
  console.log(`  ${++todoNo}. 补 --repo owner/repo 重跑本脚本（改 about.ts 仓库地址 + updater 端点），`);
  console.log("     或手工改 tauri.conf.json 的 plugins.updater.endpoints（现在还是 YOUR-USER 占位符）");
}
console.log(`  ${++todoNo}. 若已存在 Cargo.lock / package-lock.json，跑 cargo check 与 npm install 让锁文件跟上新包名。`);
console.log(`  ${++todoNo}. 核对 docs/ 下的抽离方案文档：含壳子抽离过程与本机路径，公开模板前评估是否移除。`);
console.log("");
success(`${display}（${slug}）就绪。npm install && npm run tauri dev 即可看到效果。`);
