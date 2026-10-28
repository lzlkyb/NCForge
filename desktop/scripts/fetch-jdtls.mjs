#!/usr/bin/env node
/**
 * 准备打进安装包的 jdt.ls（`src-tauri/resources/jdtls/`）。
 *
 * 为什么不直接把它提交进仓库：裁剪后仍约 55MB，每次升版都要在 git 历史里留一份。
 * 改为构建前按固定版本 + SHA-256 拉取并解压，仓库里只留一个占位 README（让 tauri 的 resources 映射在没拉取时也不报错）。
 *
 * 版本锁在 0.57.0：它是最后一个支持 Java 8 运行的版本（NC 自带的是 ufjdk 1.8），升版会直接起不来。
 *
 * 用法：
 *   node scripts/fetch-jdtls.mjs            已就绪则跳过
 *   node scripts/fetch-jdtls.mjs --force    重新解压裁剪
 * 环境变量：
 *   NCFORGE_JDTLS_TARBALL  直接指定本地已下载的 tar.gz（离线 / 内网机器用），同样要校验 SHA-256
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TARGET = join(ROOT, "src-tauri", "resources", "jdtls");
const CACHE = join(ROOT, ".cache", "jdtls");

const VERSION = "0.57.0-202006172108";
const FILE = `jdt-language-server-${VERSION}.tar.gz`;
const DOWNLOAD_URL = `https://download.eclipse.org/jdtls/milestones/0.57.0/${FILE}`;
const SHA256 = "897e4499bb7992edb6ad453039aa8fe6f4fc9b41aa99ae18b49bfae2d73573fb";
/** 写进目标目录的标记：版本 + 裁剪规则版本。改了裁剪规则要把后面的数字 +1。 */
const MARKER = `${VERSION}+prune1`;

/**
 * 只裁掉「其它平台」的插件。`config_win/config.ini` 里的 osgi.bundles 只列 Windows 的平台片段，
 * linux / macOS 的 jar 根本不会被安装，删掉是安全的。别的插件（m2e、gradle、ant …）看着用不到，
 * 但 `org.eclipse.jdt.ls.core` 在 Require-Bundle 里依赖它们，不能删。
 */
const OTHER_PLATFORM = /(linux|macosx|cocoa|gtk)/i;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function obtainTarball() {
  const given = process.env.NCFORGE_JDTLS_TARBALL;
  const path = given || join(CACHE, FILE);
  if (!existsSync(path)) {
    if (given) throw new Error(`NCFORGE_JDTLS_TARBALL 指向的文件不存在：${given}`);
    mkdirSync(CACHE, { recursive: true });
    console.log(`下载 ${DOWNLOAD_URL}`);
    const res = await fetch(DOWNLOAD_URL);
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}。可手工下载后用 NCFORGE_JDTLS_TARBALL 指定。`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const got = sha256(path);
  if (got !== SHA256) {
    throw new Error(`SHA-256 不匹配（${path}）\n  期望 ${SHA256}\n  实际 ${got}`);
  }
  return path;
}

/** 递归复制。`skipTop` 只作用于第一层（插件本体的文件名），不该误伤插件内部的同名文件。 */
function copyDir(src, dst, skipTop = () => false) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (skipTop(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

async function main() {
  const marker = join(TARGET, ".bundled-version");
  const ready =
    existsSync(marker) &&
    readFileSync(marker, "utf8").trim() === MARKER &&
    existsSync(join(TARGET, "plugins"));
  if (ready && !process.argv.includes("--force")) {
    console.log(`jdt.ls ${VERSION} 已就绪`);
    return;
  }

  const tarball = await obtainTarball();
  const work = mkdtempSync(join(tmpdir(), "ncforge-jdtls-"));
  try {
    // Windows 10+ 自带 bsdtar，mac / Linux / CI 都有 tar。
    // 不给 tar 传任何带盘符的绝对路径：Git Bash 里的 GNU tar 会把 `D:\…` 当成远程主机 `D`（host:path），
    // 连 `-C` 的 Windows 路径也会被转义坏。所以把归档拷进临时目录，在那里用纯文件名解压到当前目录。
    const local = basename(tarball);
    copyFileSync(tarball, join(work, local));
    const r = spawnSync("tar", ["-xzf", local], { stdio: "inherit", cwd: work });
    if (r.status !== 0) throw new Error(`解压失败（tar 退出码 ${r.status}）`);

    // 清掉旧内容，但保留占位 README
    for (const name of readdirSync(TARGET)) {
      if (name !== "README.md") rmSync(join(TARGET, name), { recursive: true, force: true });
    }
    mkdirSync(TARGET, { recursive: true });
    copyDir(join(work, "plugins"), join(TARGET, "plugins"), (n) => OTHER_PLATFORM.test(n));
    // config_win 只需要原件 config.ini；运行时会拷到用户数据目录再用
    mkdirSync(join(TARGET, "config_win"), { recursive: true });
    copyFileSync(join(work, "config_win", "config.ini"), join(TARGET, "config_win", "config.ini"));
    writeFileSync(marker, `${MARKER}\n`);
    console.log(`jdt.ls ${VERSION} 已准备好→ ${TARGET}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`准备 jdt.ls 失败：${e.message}`);
  process.exit(1);
});
