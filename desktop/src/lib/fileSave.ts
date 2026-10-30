import { getText, markSaved } from "./editorStore";
import { baseName, writeFile, type Eol, type TextEncoding } from "./workspace";

/**
 * 保存一个文件到磁盘：**模块级、不依赖 React**。
 *
 * 为什么从 `useFileSave` 里拆出来：退出流程（`lib/quitGuard.ts`）是模块级代码，
 * 只在 `App` 挂载时执行一次，拿不到 hook 闭包里的 `tabs`。如果不抽这一层，
 * 「退出时保存全部」就得把写盘逻辑再抄一份——两份实现迟早会在
 * 「转 UTF-8 不写 BOM」「冲突检查」这类细节上漂移。
 *
 * 这里只管「写盘 + 把 model 标记为已保存」。标签数组的回写
 * （`tabSession.applySaved`）留在调用方：那段需要 React 侧的最新 tabs。
 */

/** 保存所需的标签元数据子集。传 `TabMeta` 也可以，它包含这几个字段。 */
export interface SaveTarget {
  path: string;
  encoding: TextEncoding;
  hasBom: boolean;
  eol: Eol;
  /** 读取时记下的修改时间，用于检测「磁盘已被别的程序改过」。 */
  mtimeMs: number;
}

export interface SaveOptions {
  /** 跳过异地修改检查（用户在冲突提示里选了「覆盖保存」）。 */
  force?: boolean;
  /** 换编码保存（「转成 UTF-8 保存」）。 */
  encodingOverride?: TextEncoding;
}

export interface SaveResult {
  /** 写盘后的新修改时间，回写标签用。 */
  mtimeMs: number;
  encoding: TextEncoding;
  hasBom: boolean;
  /** 这次是换编码写的，调用方据此清掉只读标记（见 `tabSession.applySaved`）。 */
  converted: boolean;
}

/**
 * 写盘并标记已保存。失败时抛错，由调用方按错误类型分类
 * （`isConflictError` / `isUnencodableError`）。
 *
 * 并发由调用方保证：编辑器侧靠 `useFileSave` 的 `savingRef`，退出流程是单次串行。
 */
export async function saveOne(tab: SaveTarget, opts: SaveOptions = {}): Promise<SaveResult> {
  const text = getText(tab.path);
  if (text === undefined) {
    // 标签还在但 model 已经没了：与其静默返回让调用方以为保存成功，不如明确报错
    throw new Error(`编辑器里没有 ${baseName(tab.path)} 的内容`);
  }
  const encoding = opts.encodingOverride ?? tab.encoding;
  // 转 UTF-8 时不写 BOM：BOM 是「原来是 UTF-8 带 BOM」这个事实的延续，
  // 转换后的文件不该凭空多出三个字节。
  const hasBom = opts.encodingOverride === "UTF-8" ? false : tab.hasBom;
  const mtimeMs = await writeFile({
    path: tab.path,
    text,
    encoding,
    hasBom,
    eol: tab.eol,
    expectedMtimeMs: opts.force ? null : tab.mtimeMs,
  });
  // 先记账再返回：退出流程不看 React 状态，靠这里把 model 从「未保存」里摘出来，
  // 否则紧接着再查一遍还会认为它是脏的。
  markSaved(tab.path);
  return { mtimeMs, encoding, hasBom, converted: !!opts.encodingOverride };
}
