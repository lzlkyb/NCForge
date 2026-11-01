/**
 * zip-read.mjs —— 极简 zip 读取器 + gzip 探测（零依赖）。
 *
 * 用途只有一个：从 VS Code 的 `.vsix` 里取出单个文件（java-debug 的 jar）。
 * 不引入 npm 包、也不调系统 `unzip`：Git Bash 常常没有 unzip，Windows 的 bsdtar
 * 又会被 Git Bash 里的 GNU tar 遮住。Node 自带 zlib，把中央目录走一遍就够。
 *
 * 只支持 store(0) / deflate(8)、不支持 zip64：VSIX 两万多条目录也到不了 4GB。
 */

import { gunzipSync, inflateRawSync } from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** gzip 头是 1f 8b：Marketplace 下发的 vsix 是 gzip 包着的 zip，浏览器/curl 都不会替你解。 */
export function gunzipIfNeeded(buf) {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
}

/**
 * 取出名字以 `suffix` 结尾的第一个条目。
 *
 * `suffix` 用结尾匹配而不是全等：VSIX 里是 `extension/server/xxx.jar`，不同版本的
 * 顶层目录名可能不叫 extension。
 */
export function readZipEntry(zip, suffix) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 0xffff; i -= 1) {
    if (zip.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip（找不到 EOCD）");
  let count = zip.readUInt16LE(eocd + 10);
  let off = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(off) !== SIG_CENTRAL) throw new Error("zip 中央目录损坏");
    const method = zip.readUInt16LE(off + 10);
    const compSize = zip.readUInt32LE(off + 20);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const localOff = zip.readUInt32LE(off + 42);
    const name = zip.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    if (name.endsWith(suffix)) {
      if (zip.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error("zip 本地头损坏");
      const start =
        localOff + 30 + zip.readUInt16LE(localOff + 26) + zip.readUInt16LE(localOff + 28);
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`不支持的 zip 压缩方式 ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`压缩包里没有 ${suffix}`);
}
