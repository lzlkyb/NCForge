/**
 * zip-store.mjs 单测（node:test 范式，同 check-motion.mjs）。
 *
 * 覆盖两类风险：
 *  1. **结构正确性**——手写 zip 头，一个字段写错 Rust 侧 zip crate 就整体读不了
 *     （生产表现：全体用户下载后全部 signature/corrupt 失败）。这里逐字段断言。
 *  2. **互操作性**——Windows 10+ 自带 bsdtar 能读我们写的 zip（CI 同为 Windows runner），
 *     列目录 + 取内容双向验证。GNU tar 不支持 zip 格式，该用例仅在 win32 跑。
 *  3. **可重现性**——同样输入两次构建字节完全相等（版本号取 sha 前 12 位，依赖这一点）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { buildZip, zipEntriesFromDir } from "./zip-store.mjs";

function readEntry(zip, index) {
  // EOCD 在尾部：comment 长度固定 0，直接定位。
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50, "EOCD 签名");
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  assert.ok(index < count, `EOCD 声明 ${count} 条，目标下标 ${index} 越界`);

  // 中央目录是变长记录：固定头 46 字节 + 文件名（本 writer 不写 extra/comment）。
  // 逐条累加定位，不能按固定 46 跨步——第二条起会全部错位。
  let cd = cdOffset;
  for (let i = 0; i < index; i++) {
    assert.equal(zip.readUInt32LE(cd), 0x02014b50, `第 ${i} 条中央目录签名`);
    const nameLenAt = zip.readUInt16LE(cd + 28);
    const extraLenAt = zip.readUInt16LE(cd + 30);
    const commentLenAt = zip.readUInt16LE(cd + 32);
    cd += 46 + nameLenAt + extraLenAt + commentLenAt;
  }
  assert.equal(zip.readUInt32LE(cd), 0x02014b50, "中央目录签名");
  const nameLen = zip.readUInt16LE(cd + 28);
  const extraLen = zip.readUInt16LE(cd + 30);
  const commentLen = zip.readUInt16LE(cd + 32);
  const crc = zip.readUInt32LE(cd + 16);
  const size = zip.readUInt32LE(cd + 24);
  const localOffset = zip.readUInt32LE(cd + 42);
  const name = zip.toString("utf8", cd + 46, cd + 46 + nameLen);
  assert.equal(extraLen, 0, "不写 extra 字段");
  assert.equal(commentLen, 0, "不写 comment 字段");

  // 校验 CD 自身大小一致（CD 结尾 = EOCD 起点）
  assert.equal(cdOffset + cdSize, eocd, "中央目录大小与 EOCD 位置自洽");

  const local = localOffset;
  assert.equal(zip.readUInt32LE(local), 0x04034b50, "本地文件头签名");
  assert.equal(zip.readUInt16LE(local + 6), 0x0800, "UTF-8 文件名标志位");
  assert.equal(zip.readUInt16LE(local + 8), 0, "store 模式");
  assert.equal(zip.readUInt32LE(local + 14), crc, "本地头 CRC 与 CD 一致");
  assert.equal(zip.readUInt32LE(local + 18), size, "本地头大小与 CD 一致");
  const localNameLen = zip.readUInt16LE(local + 26);
  const localExtraLen = zip.readUInt16LE(local + 28);
  assert.equal(localNameLen, nameLen, "本地头与 CD 名长一致");
  assert.equal(localExtraLen, 0, "本地头不写 extra");
  const dataStart = local + 30 + localNameLen;
  const data = zip.subarray(dataStart, dataStart + size);
  return { name, crc, size, data };
}

test("单文件 roundtrip：结构字段与 CRC 全部正确", () => {
  const payload = Buffer.from("fake-jar-bytes", "utf8");
  const zip = buildZip([{ name: "ecj-3.17.jar", data: payload }]);
  const e = readEntry(zip, 0);
  assert.equal(e.name, "ecj-3.17.jar");
  assert.equal(e.size, payload.length);
  assert.equal(e.crc, crc32(payload) >>> 0);
  assert.deepEqual(e.data, payload);
});

test("目录条目在前、UTF-8 名、空文件", () => {
  const zip = buildZip([
    { name: "plugins", dir: true },
    { name: "plugins/中文 目录", dir: true },
    { name: "plugins/中文 目录/a.jar", data: Buffer.from("A") },
    { name: "plugins/empty.txt", data: Buffer.alloc(0) },
  ]);
  assert.equal(readEntry(zip, 0).name, "plugins/");
  assert.equal(readEntry(zip, 1).name, "plugins/中文 目录/");
  assert.equal(readEntry(zip, 2).name, "plugins/中文 目录/a.jar");
  assert.deepEqual(readEntry(zip, 2).data, Buffer.from("A"));
  assert.equal(readEntry(zip, 3).name, "plugins/empty.txt");
  assert.equal(readEntry(zip, 3).size, 0);
});

test("可重现：同样输入两次构建字节完全相等", () => {
  const entries = [
    { name: "plugins", dir: true },
    { name: "plugins/b.jar", data: Buffer.from("BBB") },
    { name: "plugins/a.jar", data: Buffer.from("AAA") },
  ];
  assert.deepEqual(buildZip(entries), buildZip(entries));
});

test("zipEntriesFromDir：递归 + 排序确定 + skip 生效", () => {
  const root = mkdtempSync(join(tmpdir(), "zipstore-"));
  try {
    writeFileSync(join(root, "b.txt"), "B");
    writeFileSync(join(root, "README.md"), "占位");
    mkdirSync(join(root, "sub", "deep"), { recursive: true });
    writeFileSync(join(root, "sub", "a.txt"), "A");
    writeFileSync(join(root, "sub", "deep", "c.txt"), "C");

    const entries = zipEntriesFromDir(root, (rel) => rel === "README.md");
    const names = entries.map((e) => e.name);
    assert.ok(!names.includes("README.md"), "skip 的条目不应出现");
    // 目录条目全部排在文件前，且各自字典序
    const firstFile = names.findIndex((n) => !n.endsWith("/"));
    const lastDir = names.map((n) => n.endsWith("/")).lastIndexOf(true);
    assert.ok(lastDir < firstFile, "目录条目应在文件之前");
    assert.deepEqual(names, ["sub/", "sub/deep/", "b.txt", "sub/a.txt", "sub/deep/c.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// GNU tar（Git Bash 自带，常在 PATH 里优先）不支持 zip 格式。Windows 10+ 的
// bsdtar 在 %SystemRoot%\System32\tar.exe。CI 与开发机都是 Windows runner，
// 用系统 tar；找不到就 skip（结构自校验用例已覆盖格式正确性）。
function findBsdtar() {
  if (process.platform !== "win32") return null;
  const sysTar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return existsSync(sysTar) ? sysTar : null;
}

test("bsdtar 互操作：列目录 + 取内容", { skip: findBsdtar() ? false : "未找到 System32 bsdtar" }, () => {
  const tarBin = findBsdtar();
  const dir = mkdtempSync(join(tmpdir(), "zipstore-interop-"));
  const zipPath = join(dir, "probe.zip");
  try {
    writeFileSync(zipPath, buildZip([
      { name: "plugins", dir: true },
      { name: "plugins/ecj-3.17.jar", data: Buffer.from("jar-bytes") },
      { name: "escape.txt", data: Buffer.from("top-level") },
    ]));

    // 不给 tar 传带盘符的绝对路径：tar（含 bsdtar）会把 `D:\…` 当成远程主机 `D`
    // （host:path 语法），报 "Cannot connect to D"。同 fetch-jdtls.mjs 的坑，
    // 用 cwd + 纯文件名绕过。
    const list = spawnSync(tarBin, ["-tf", "probe.zip"], { encoding: "utf8", cwd: dir });
    assert.equal(list.status, 0, `tar -tf 失败：${list.stderr}`);
    // bsdtar 在 Windows 上按 CRLF 输出，先按 \r?\n 切开再比对
    const lines = list.stdout.trim().split(/\r?\n/);
    assert.ok(lines.some((l) => l.endsWith("plugins/ecj-3.17.jar")), `列出条目应含 jar：${lines}`);
    assert.ok(lines.includes("escape.txt"), `列出条目应含顶层文件：${lines}`);

    const cat = spawnSync(tarBin, ["-xOf", "probe.zip", "plugins/ecj-3.17.jar"], { encoding: "buffer", cwd: dir });
    assert.equal(cat.status, 0, `tar -xOf 失败：${cat.stderr}`);
    assert.deepEqual(cat.stdout, Buffer.from("jar-bytes"), "取回内容应与写入一致");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
