/**
 * 大文件降级阈值。
 *
 * 几千行的文件会增加编辑器着色、折叠与小地图的开销，因此降低这些显示成本。
 * 补全**不关闭**，但「输入即弹」会关掉：2026-11-15 用 `npm run test:editor-gaps`
 * 在 6003 行的类上实测，热态补全 p50 是 1165 ms（同一探针里普通文件是 10~58 ms），
 * 自动弹出会让每敲一个字都卡一秒。`.` 触发与 Ctrl+Space 仍可用，手动要还是能给。
 *
 * 主编辑器与分屏共用这一份，避免两处各写一个数字后慢慢分叉。
 */
export const LARGE_FILE_LINES = 2000;

/**
 * 字节阈值：2 MB。
 *
 * 为什么行数之外还要看字节：行数只对「正常的源码」有效，而 NC 现场会打开这些东西——
 * 单行几万字符的报文 XML、一整年堆在一起的 SQL 脚本、导出的日志切片。它们行数可能
 * 只有几百，却能把 tokenize 与语法高亮拖住：Monaco 按行切块，但一行太长时单个
 * token 就要走完整套正则，输入法等宽字符更贵。
 *
 * 两个阈值取「或」：任一超了就算大文件（见 `isHeavyFile`）。
 */
export const LARGE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 这个标签要不要走大文件降级。
 *
 * 传结构化类型而不是 `TabMeta`：`largeFile` 只关心两个数，不引 `workspaceSession`
 * 可以让它保持零依赖，测试也不用造一整个标签。
 */
export function isHeavyFile(meta: { lines: number; bytes: number }): boolean {
  return meta.lines > LARGE_FILE_LINES || meta.bytes > LARGE_FILE_BYTES;
}
