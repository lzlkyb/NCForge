#!/usr/bin/env node
/**
 * 准备「数据库 JVM 组件」所需的两样东西（`src-tauri/resources/ncdb-runtime/`）：
 *
 *   jre/      Zulu 8 JRE（不带 JavaFX）
 *   ojdbc/    Oracle JDBC 驱动 ojdbc6.jar（11.2.0.4）
 *   LICENSE-oracle.txt / LICENSE-zulu.txt
 *
 * # 为什么外置
 *
 * 只有「想让 JVM 桥在没有 NC 安装目录的机器上跑」的人才需要它，而 JRE 解压后
 * 约 97MB —— 不该让只用纯 Rust 驱动的用户也背着。与 jdtls / ecj 同一套按需
 * 分发的机制（`resource_pack`），仓库里只留 README 占位。
 *
 * # 为什么是 Java 8
 *
 * `NcDbBridge` 按 1.8 编译，NC 的中间件也是 1.8；更实际的是 **ojdbc6 的兼容面**：
 * 它在 JDK 11+ 上会碰到被移除的内部 API，而 11g 的库又只认这一代驱动。所以
 * 打包的运行时、驱动、数据库三者版本对齐在 8 / 11g。
 *
 * # 许可证
 *
 * - **Zulu 8**：Azul 发行的 OpenJDK 8 构建，GPLv2 + Classpath Exception，可再分发；
 *   包内 `LICENSE-zulu.txt` 是 Azul 分发包自带的声明。
 * - **ojdbc**：Oracle Free Use Terms and Conditions（FUTC）。允许再分发**未修改**的
 *   程序，条件是随附许可证副本、不向最终用户额外收费、不移除专有权声明。
 *   NCForge 免费分发，jar 原样打包，`LICENSE-oracle.txt` 随包发。
 *   ⚠️ 如果将来 NCForge 变成收费产品，这一条就不再成立，必须改成分发时让用户
 *   自己去 Oracle 官网下载。
 *
 * # 用法
 *
 *   node scripts/fetch-ncdb.mjs                  已就绪则跳过
 *   node scripts/fetch-ncdb.mjs --force          重新下载解压
 *   node scripts/fetch-ncdb.mjs --platform macos 交叉准备（默认按当前平台）
 *
 * 环境变量：
 *   NCFORGE_NCDB_JRE   本地 JRE zip（离线 / 内网机器），仍按平台校验 SHA-256
 *   NCFORGE_NCDB_ARCH  覆盖目标架构（`arm64` / `x64`）。CI 在 x64 runner 上打
 *                      aarch64 的 mac 包时用得上——否则会静默下错架构的 JRE。
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TARGET = join(ROOT, "src-tauri", "resources", "ncdb-runtime");
const CACHE = join(ROOT, ".cache", "ncdb");
const JRE_DIR = join(TARGET, "jre");
const OJDBC_DIR = join(TARGET, "ojdbc");

/** 写进 `jre/.fetched` 的标记：换了 JRE 版本就把这里 +1，`--force` 会重新解压。 */
const JRE_MARKER = "zulu8.98.0.111-jre8.0.512";

/**
 * 每个平台对应的 Zulu 包。SHA-256 是从 Azul CDN 下下来自己算的（官方 API 不提供），
 * 换版本时整行一起换。
 */
const ZULU = {
  "windows/x64": {
    file: "zulu8.98.0.111-ca-jre8.0.512-win_x64.zip",
    sha: "a07b4d154aebe5ea610fa6caa5bcaa2a858b3ae5c5b13d9162aa0f98675b26b1",
  },
  "macos/arm64": {
    file: "zulu8.98.0.111-ca-jre8.0.512-macosx_aarch64.zip",
    sha: "5f805656659cf9a4b65b23006f2a7e3f68d898663721412408808dd92a6f4eb2",
  },
  "macos/x64": {
    file: "zulu8.98.0.111-ca-jre8.0.512-macosx_x64.zip",
    sha: "a7df23c23c2cdb30e2a13430ffb9cf196242403482127ff47961f2812d6d479d",
  },
};

const OJDBC = {
  file: "ojdbc6-11.2.0.4.jar",
  url: "https://repo1.maven.org/maven2/com/oracle/database/jdbc/ojdbc6/11.2.0.4/ojdbc6-11.2.0.4.jar",
  sha: "e70213917b5f0d7448072836da07c709930b89dd4b0cc14a1eef814836747900",
};

function fail(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`);
}
function success(msg) {
  console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchChecked(url, dest, expected) {
  info(`下载 ${basename(dest)}`);
  const r = await fetch(url);
  if (!r.ok) fail(`${url} 返回 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = sha256(buf);
  if (got !== expected) {
    fail(`${basename(dest)} 校验失败\n  期望 ${expected}\n  实际 ${got}`);
  }
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, buf);
  success(`${basename(dest)} ${(buf.length / 1048576).toFixed(1)} MB`);
}

/**
 * 解 zip。三平台各自的现实：
 *
 * - Windows：`System32\tar.exe` 是 libarchive 的 bsdtar，**认 zip**。而 Git Bash 的
 *   `tar` 是 GNU tar，只认 tar 归档（报 `This does not look like a tar archive`）。
 *   所以这里显式用 System32 那个，不走 PATH。
 * - macOS：系统 `tar` 就是 bsdtar，但 `unzip` 更常见，统一用 `unzip`。
 * - Linux：GNU tar 不认 zip，`unzip` 是标准做法。
 *
 * 🔴 Windows 分支必须用**相对 cwd 的路径**：GNU tar 会把 `D:\...` 的冒号当远程主机，
 * 而 bsdtar 不认 GNU 的 `--force-local`。相对路径两边都安全。
 */
function unzip(zip, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const winTar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  const bsdtar = process.platform === "win32" && existsSync(winTar);
  const r = bsdtar
    ? spawnSync(winTar, ["-xf", basename(zip), "-C", basename(dest)], {
        stdio: "inherit",
        cwd: CACHE,
      })
    : spawnSync("unzip", ["-q", zip, "-d", dest], { stdio: "inherit" });
  if (r.error) fail(`解压失败：${r.error.message}`);
  if (r.status !== 0) fail(`解压失败（退出码 ${r.status}）：${zip}`);
}

/** Zulu 的包顶层只有一层 `zulu8.x.x-.../`，剥掉它让 `jre/bin/java` 直接可用。 */
function liftSingleDir(unpacked, dest) {
  const names = readdirSync(unpacked).filter((n) => n !== "__MACOSX" && n !== ".DS_Store");
  if (names.length !== 1) fail(`${unpacked} 里应当只有一个顶层目录，实际：${names.join(", ")}`);
  const inner = join(unpacked, names[0]);
  if (!statSync(inner).isDirectory()) fail(`${inner} 不是目录`);
  rmSync(dest, { recursive: true, force: true });
  renameSync(inner, dest);
}

function jreReady() {
  const marker = join(JRE_DIR, ".fetched");
  if (!existsSync(marker)) return false;
  if (readFileSync(marker, "utf8").trim() !== JRE_MARKER) return false;
  const bin = join(JRE_DIR, "bin", process.platform === "win32" ? "java.exe" : "java");
  return existsSync(bin);
}

function ojdbcReady() {
  return existsSync(join(OJDBC_DIR, "ojdbc6.jar"));
}

async function ensureJre(force, platform) {
  if (!force && jreReady()) {
    success("jre 已就绪，跳过");
    return;
  }
  const key = `${platform}/${process.env.NCFORGE_NCDB_ARCH || process.arch}`;
  const spec = ZULU[key];
  if (!spec) {
    fail(
      `没有 ${key} 的 JRE 包。已支持的组合：${Object.keys(ZULU).join("、")}。\n` +
        `  要加新平台：下载对应的 Zulu 8 JRE zip，把文件名与 SHA-256 补进本文件的 ZULU 表。`,
    );
  }
  mkdirSync(CACHE, { recursive: true });
  const cached = join(CACHE, spec.file);
  const local = process.env.NCFORGE_NCDB_JRE;
  if (local) {
    info(`用本地 JRE 包 ${local}`);
    const buf = readFileSync(local);
    const got = sha256(buf);
    if (got !== spec.sha) fail(`本地 JRE 包校验失败\n  期望 ${spec.sha}\n  实际 ${got}`);
    mkdirSync(join(cached, ".."), { recursive: true });
    copyFileSync(local, cached);
  } else if (!existsSync(cached)) {
    await fetchChecked(`https://cdn.azul.com/zulu/bin/${spec.file}`, cached, spec.sha);
  } else {
    success(`${spec.file} 已在缓存里`);
  }

  const unpacked = join(CACHE, "unpacked");
  unzip(cached, unpacked);
  liftSingleDir(unpacked, JRE_DIR);
  rmSync(unpacked, { recursive: true, force: true });
  writeFileSync(join(JRE_DIR, ".fetched"), `${JRE_MARKER}\n`);
  success(`jre 解压完成 → ${JRE_DIR}`);
}

async function ensureOjdbc(force) {
  if (!force && ojdbcReady()) {
    success("ojdbc 已就绪，跳过");
    return;
  }
  mkdirSync(OJDBC_DIR, { recursive: true });
  const cached = join(CACHE, OJDBC.file);
  if (existsSync(cached)) {
    const got = sha256(readFileSync(cached));
    if (got !== OJDBC.sha) {
      info("缓存里的驱动校验不通过，重新下载");
      rmSync(cached, { force: true });
    }
  }
  if (!existsSync(cached)) {
    await fetchChecked(OJDBC.url, cached, OJDBC.sha);
  }
  copyFileSync(cached, join(OJDBC_DIR, "ojdbc6.jar"));
  success(`ojdbc6.jar → ${OJDBC_DIR}`);
}

/**
 * 许可证副本。FUTC 要求「随附许可证」，所以这份文件必须真的进资源包，
 * 不能只写一句「见官网」。Zulu 包自带 `LICENSE` / `legal/`，随 jre 目录一起进包。
 */
function writeOjdbcLicense() {
  const text = `Oracle JDBC Driver (ojdbc6.jar, 11.2.0.4)
=================================================

本文件是随 NCForge 一起分发的 Oracle JDBC 驱动所适用的许可证说明。

该驱动按 Oracle Free Use Terms and Conditions (FUTC) 发布，全文见：
https://www.oracle.com/downloads/licenses/oracle-free-license.html

要点（以官方全文为准）：

  (b) redistribute unmodified Programs and Programs Documentation, under the
      terms of this License, provided that You do not charge Your end users
      any additional fees for the use of the Programs.

  - You include a copy of this license with any distribution by You of the
    Programs;
  - You do not remove markings or notices of either Oracle's or a licensor's
    proprietary rights from the Programs or Program Documentation;

NCForge 免费分发，驱动 jar 未经任何修改（SHA-256
${OJDBC.sha}），本文件作为许可证副本随组件包一同分发。

获取者也可以不用本组件：在「设置 → 开发 → NC 环境」配置已有的 NC 安装目录，
或把连接引擎改成「纯 Rust 驱动」，两条路都不需要本驱动。
`;
  writeFileSync(join(TARGET, "LICENSE-oracle.txt"), text);
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const plateIdx = args.indexOf("--platform");
  const platform =
    plateIdx > -1
      ? args[plateIdx + 1]
      : process.platform === "win32"
        ? "windows"
        : process.platform === "darwin"
          ? "macos"
          : "linux";

  if (platform !== process.platform.replace("win32", "windows").replace("darwin", "macos")) {
    // 交叉准备时 arch 也得跟着换，否则会拿错包；这里只允许「同 arch 换平台名」之外的显式指定，
    // 真正跨架构要连 arch 一起给，避免静默产出错误架构的 JRE。
    fail(
      `--platform ${platform} 与当前平台 ${process.platform}/${process.arch} 不一致。\n` +
        `  JRE 是平台 + 架构相关的，交叉准备请在本机跑 CI，或同时改 arch（当前不支持）。`,
    );
  }

  mkdirSync(TARGET, { recursive: true });
  // 同步部分（ojdbc 是纯 IO + 网络都在 async 里），整体用 promise 包一层
  return (async () => {
    await ensureJre(force, platform);
    await ensureOjdbc(force);
    writeOjdbcLicense();
    success(`数据库 JVM 组件已就绪：${TARGET}`);
  })();
}

main().catch((e) => fail(e?.stack || String(e)));
