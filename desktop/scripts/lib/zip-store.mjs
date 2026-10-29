/**
 * zip-store.mjs —— 最小 zip 写入器（store 无压缩模式，零依赖）。
 *
 * 为什么不用 archiver/fflate：资源包内容是 jar（本身已是 deflate），store 模式
 * 再压一遍收益接近零，却要为 ~30KB 的依赖引入一条 npm install 失败面
 * （CI 的 ECONNRESET 前科）。zip 的 store 子集格式很小，自己写更可控。
 *
 * 为什么写死 1980 时间戳：**同样输入必须产出同样字节**。资源版本号取 zip 的
 * SHA-256 前 12 位（内容寻址），写当前时间会让每次打包产出不同 sha，
 * 「内容没变但版本变了 ⇒ 全体用户重下」。
 *
 * 兼容性约定（Rust 侧 zip crate 消费）：
 *  - 目录显式成条目（path/ 结尾），文件条目带 unix mode 的 external attrs；
 *  - 文件名 UTF-8 + flag bit 11，中文/空格安全；
 *  - 无 zip64：单个包 < 4GB，jdtls 54MB 远低于门槛。
 */

import { crc32 } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** DOS 时间戳固定 1980-01-01 00:00:00（zip 纪元），保证可重现构建。 */
const DOS_TIME = 0;
const DOS_DATE = 0x21;

/** version made by：unix（3）+ spec 3.0。external attrs 带 unix mode，解压端能还原权限。 */
const VERSION_MADE_BY = (3 << 8) | 20;

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value >>> 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}

/**
 * 生成 zip 字节。
 *
 * @param {{ name: string; data?: Buffer; dir?: boolean }[]} entries
 *   name 用正斜杠相对路径；dir: true 时 name 应以 "/" 结尾（自动补齐）。
 *   目录条目必须排在它的文件之前（调用方排序）。
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (buf) => {
    chunks.push(buf);
    offset += buf.length;
  };

  for (const entry of entries) {
    const isDir = Boolean(entry.dir);
    const name = isDir && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
    const nameBuf = Buffer.from(name, "utf8");
    const data = isDir ? Buffer.alloc(0) : (entry.data ?? Buffer.alloc(0));
    const crc = crc32(data) >>> 0;
    const externalAttrs = isDir ? ((0o040755 << 16) | 0x10) >>> 0 : ((0o0100644 << 16) | 0x20) >>> 0;
    const localOffset = offset;

    // Local file header（version needed 20 = 2.0，store 模式最低要求）
    push(
      Buffer.concat([
        u32(SIG_LOCAL),
        u16(20),
        u16(0x0800), // general purpose bit 11：文件名是 UTF-8
        u16(0), // method: stored
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(crc),
        u32(data.length), // compressed size（store 模式 = 原大小）
        u32(data.length), // uncompressed size
        u16(nameBuf.length),
        u16(0), // extra length
        nameBuf,
      ]),
    );
    if (data.length) push(data);

    central.push({
      nameBuf,
      crc,
      size: data.length,
      localOffset,
      externalAttrs,
    });
  }

  const centralOffset = offset;
  for (const c of central) {
    push(
      Buffer.concat([
        u32(SIG_CENTRAL),
        u16(VERSION_MADE_BY),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(c.crc),
        u32(c.size),
        u32(c.size),
        u16(c.nameBuf.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk number start
        u16(0), // internal attrs
        u32(c.externalAttrs),
        u32(c.localOffset),
        c.nameBuf,
      ]),
    );
  }
  const centralSize = offset - centralOffset;

  // End of central directory
  push(
    Buffer.concat([
      u32(SIG_EOCD),
      u16(0), // disk number
      u16(0), // disk with central dir
      u16(central.length),
      u16(central.length),
      u32(centralSize),
      u32(centralOffset),
      u16(0), // comment length
    ]),
  );

  return Buffer.concat(chunks);
}

/**
 * 把一个目录树拍平成 buildZip 的 entries（目录条目在前，排序确定 ⇒ 输出可重现）。
 *
 * @param {string} rootDir 目录根
 * @param {(relPath: string) => boolean} [skip] 跳过的相对路径（如占位 README）
 */
export function zipEntriesFromDir(rootDir, skip = () => false) {
  const files = [];
  const dirs = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const full = join(abs, name);
      const rel = relative(rootDir, full).split(sep).join("/");
      if (skip(rel)) continue;
      if (statSync(full).isDirectory()) {
        dirs.push({ name: `${rel}/`, dir: true });
        walk(full);
      } else {
        files.push({ name: rel, data: readFileSync(full) });
      }
    }
  };
  walk(rootDir);
  // 目录按路径字典序在前，文件同理——整体确定性 ⇒ 同样输入产出同样字节。
  dirs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [...dirs, ...files];
}
