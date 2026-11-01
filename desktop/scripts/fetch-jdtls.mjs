#!/usr/bin/env node
/**
 * 准备开发期 / 发版打包用的 jdt.ls（`src-tauri/resources/jdtls/`）。
 *
 * 为什么不直接把它提交进仓库：裁剪后仍约 55MB，每次升版都要在 git 历史里留一份。
 * 改为构建前按固定版本 + SHA-256 拉取并解压，仓库里只留一个占位 README（让 tauri 的 resources 映射在没拉取时也不报错）。
 *
 * 版本锁在 0.57.0：它是最后一个支持 Java 8 运行的版本（NC 自带的是 ufjdk 1.8），升版会直接起不来。
 *
 * 用途变更（方案 B，资源外置）：jdtls **不再打进安装包**（bundle.resources 已移除，
 * 安装包从 63.8MB 砍到 ~8MB），改为发版时由 pack-resources.mjs 打成资源 zip 按需分发。
 * 所以本脚本从 prebuild 钩子移除，只剩两个入口：
 *   - 开发期手动：`npm run jdtls:fetch`（代码智能需要本地有这份目录）
 *   - 发版打包：pack-resources.mjs 在检测到目录缺失时自动调用
 *
 * 用法：
 *   node scripts/fetch-jdtls.mjs            已就绪则跳过
 *   node scripts/fetch-jdtls.mjs --force    重新解压裁剪
 * 环境变量：
 *   NCFORGE_JDTLS_TARBALL      直接指定本地已下载的 tar.gz（离线 / 内网机器用），同样要校验 SHA-256
 *   NCFORGE_JAVA_DEBUG_VSIX    直接指定本地的 vscode-java-debug 0.35.0 vsix（离线机器用），同样要校验 SHA-256
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
import { gunzipIfNeeded, readZipEntry } from "./lib/zip-read.mjs";

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
 * 调试器：java-debug 0.32.0，最后一个声明 `JavaSE-1.8` 的运行期构建（0.35.0 起要 Java 11）。
 * 它作为 OSGi bundle 由 jdt.ls 通过 `initializationOptions.bundles` 加载，注册
 * `vscode.java.startDebugSession`，之后的 DAP 会话由工作台自己连。
 *
 * 为什么从 VSIX 里拆：java-debug 没有独立发布物（GitHub 无 release 资产，Maven Central 也没有），
 * 唯一官方分发渠道就是 vscode-java-debug 扩展包。0.35.0 的包里带的正是 0.32.0。
 * 两个哈希都钉死：vsix 保证下载完整，jar 保证解出来的是我们验过的那一份。
 *
 * 注意 vsix 有两种字节形态：Marketplace 原始下发是 gzip（1f 8b），而 Node 的 fetch
 * 会按 Content-Encoding 自动解压成 zip（PK）。两者是同一份内容的两种封装，所以校验
 * 统一在「解掉 gzip 之后」做——否则换个 HTTP 客户端就校验失败（已实际踩到）。
 */
const DEBUG_JAR = "com.microsoft.java.debug.plugin-0.32.0.jar";
const DEBUG_DIR = "java-debug";
const DEBUG_VSIX_FILE = "vscode-java-debug-0.35.0.vsix";
const DEBUG_VSIX_URL =
  "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/vscjava/vsextensions/vscode-java-debug/0.35.0/vspackage";
/** 解开 gzip 之后的 zip 哈希（gzip 形态每次下载会因头部时间戳而不同，不能用来校验）。 */
const DEBUG_VSIX_SHA256 = "a7440aad8b223fe03c3614e8890adc50e77a93acedfd859a81ff47776a9b5a07";
const DEBUG_JAR_SHA256 = "b0702c8b16295dbe61c4b874fc8741a2de497da984a5fdce2d211a69acba96c0";

/**
 * 只裁掉「其它平台」的插件。`config_win/config.ini` 里的 osgi.bundles 只列 Windows 的平台片段，
 * linux / macOS 的 jar 根本不会被安装，删掉是安全的。别的插件（m2e、gradle、ant …）看着用不到，
 * 但 `org.eclipse.jdt.ls.core` 在 Require-Bundle 里依赖它们，不能删。
 */
const OTHER_PLATFORM = /(linux|macosx|cocoa|gtk)/i;

function sha256(data) {
  return createHash("sha256")
    .update(Buffer.isBuffer(data) ? data : readFileSync(data))
    .digest("hex");
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

async function obtainVsix() {
  const given = process.env.NCFORGE_JAVA_DEBUG_VSIX;
  const path = given || join(CACHE, DEBUG_VSIX_FILE);
  if (!existsSync(path)) {
    if (given) throw new Error(`NCFORGE_JAVA_DEBUG_VSIX 指向的文件不存在：${given}`);
    mkdirSync(CACHE, { recursive: true });
    console.log(`下载 java-debug 0.32.0（${DEBUG_VSIX_URL}）`);
    const res = await fetch(DEBUG_VSIX_URL);
    if (!res.ok) {
      throw new Error(
        `下载失败：HTTP ${res.status}。可在能上网的机器上下载后，用 NCFORGE_JAVA_DEBUG_VSIX 指定。`,
      );
    }
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const zip = gunzipIfNeeded(readFileSync(path));
  const got = sha256(zip);
  if (got !== DEBUG_VSIX_SHA256) {
    throw new Error(`vsix SHA-256 不匹配（${path}）\n  期望 ${DEBUG_VSIX_SHA256}\n  实际 ${got}`);
  }
  return zip;
}

/**
 * 把 java-debug 的 jar 放到 `<jdtls>/java-debug/`。
 *
 * 不放进 `plugins/`：那是 equinox 自己按 config.ini 装配的目录，塞进去会被当成
 * 平台 bundle 参与启动解析；jdt.ls 的 `bundles` 参数是运行时 install，位置随意。
 */
async function ensureJavaDebug() {
  const dest = join(TARGET, DEBUG_DIR, DEBUG_JAR);
  if (existsSync(dest) && sha256(dest) === DEBUG_JAR_SHA256) return dest;
  const jar = readZipEntry(await obtainVsix(), `server/${DEBUG_JAR}`);
  const got = sha256(jar);
  if (got !== DEBUG_JAR_SHA256) {
    throw new Error(`java-debug jar SHA-256 不匹配\n  期望 ${DEBUG_JAR_SHA256}\n  实际 ${got}`);
  }
  mkdirSync(join(TARGET, DEBUG_DIR), { recursive: true });
  writeFileSync(dest, jar);
  console.log(`java-debug 0.32.0 已准备好→ ${dest}`);
  return dest;
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
    // 语言服务在、调试 jar 不在（旧版资源包）：只补它，不重下 55MB
    await ensureJavaDebug();
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
    await ensureJavaDebug();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`准备 jdt.ls 失败：${e.message}`);
  process.exit(1);
});
