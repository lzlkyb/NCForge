import {
  baseName,
  countLines,
  remapPath,
  type Eol,
  type FileContent,
  type TextEncoding,
} from "./workspace";
import { isStubSource, jdtDisplayName } from "./langConvert";
import type { TabMeta } from "./workspaceSession";

/**
 * 标签页的纯函数部分：从文件内容/`jdt://` 地址造标签、路径覆盖判断、保存后的状态更新。
 *
 * 从 `useFileSession` 搬出来是为了让它回到「单文件 300 行」的体量门禁内——而这几段
 * 本来就是纯数据变换（不碰 state、不调后端），放在 hook 里只是被同一个生命周期绑着。
 * 搬出来还顺带能单测：`coversPath` 判错的后果是「目录改名后标签没跟着走」。
 */

/**
 * 加一个标签。`preview` 时顶替掉现有的预览标签（没改动才替换）。
 * 返回新数组与被顶替的路径（调用方要关掉它的 model）。
 */
export function addTab(
  tabs: TabMeta[],
  meta: TabMeta,
  preview: boolean,
): { tabs: TabMeta[]; dropped: string | null } {
  if (!preview) return { tabs: [...tabs, meta], dropped: null };
  const next = { ...meta, preview: true };
  const i = tabs.findIndex((t) => t.preview && !t.dirty && !t.eolChanged);
  if (i < 0) return { tabs: [...tabs, next], dropped: null };
  const out = tabs.slice();
  out[i] = next;
  return { tabs: out, dropped: tabs[i].path };
}

/** 把预览标签固定下来。 */
export function pinTab(tabs: TabMeta[], path: string): TabMeta[] {
  return tabs.map((t) => (t.path === path && t.preview ? { ...t, preview: false } : t));
}

/** 「关闭其他 / 右侧 / 已保存」：只关没有未保存改动的；返回要关的路径与因未保存而保留的个数。 */
export function pickClosable(
  tabs: TabMeta[],
  want: (t: TabMeta, index: number) => boolean,
): { close: string[]; kept: number } {
  const hit = tabs.filter(want);
  const close = hit.filter((t) => !t.dirty && !t.eolChanged).map((t) => t.path);
  return { close, kept: hit.length - close.length };
}

/** 从磁盘读到的内容造一个标签。`readOnly` 的两种原因见 `TabMeta.readOnlyReason`。 */
export function tabMetaFromDisk(path: string, c: FileContent): TabMeta {
  const reason = !c.lossless ? "lossy" : c.eol === "MIXED" ? "mixed" : null;
  return {
    path,
    name: baseName(path),
    encoding: c.encoding,
    hasBom: c.hasBom,
    eol: c.eol,
    mtimeMs: c.mtimeMs,
    dirty: false,
    eolChanged: false,
    readOnly: reason !== null,
    readOnlyReason: reason,
    // 与编辑器同口径：Monaco 把 \r\n、\r、\n 都当一次换行，
    // 用 split("\n") 会漏掉孤立 \r，大文件提示与行跳转就对不齐了。
    lines: countLines(c.text),
  };
}

/**
 * jar 内的类（jdt.ls 给的 `jdt://` 地址）：永远是只读标签。
 * `virtual` 区分「真源码」与「签名的 stub」——stub 里是方法签名而不是实现，
 * 不标出来用户会当成代码找不到。
 */
export function tabMetaFromJdt(uri: string, text: string): TabMeta {
  return {
    path: uri,
    name: jdtDisplayName(uri),
    encoding: "UTF-8",
    hasBom: false,
    eol: "LF",
    mtimeMs: 0,
    dirty: false,
    eolChanged: false,
    readOnly: true,
    readOnlyReason: null,
    lines: countLines(text),
    virtual: isStubSource(text) ? "stub" : "source",
  };
}

/**
 * 该路径或它下面的某个文件（目录改名/删除时）是否受影响。
 * 比较前统一小写：Windows 路径大小写不敏感，`C:\A` 与 `c:\a` 是同一个目录。
 */
export function coversPath(path: string, base: string): boolean {
  const p = path.toLowerCase();
  const b = base.toLowerCase();
  return p === b || p.startsWith(`${b}\\`);
}

/**
 * 保存成功后的标签状态。
 *
 * `converted = true` 表示这次是「转为 UTF-8 保存」：文件不再含写不回去的字符，
 * 编辑器要顺势解锁（`readOnly` / `readOnlyReason` 清掉），否则用户会看到
 * 「保存成功了但编辑器还是只读」。
 */
export function applySaved(
  tabs: TabMeta[],
  path: string,
  next: { mtimeMs: number; encoding: TextEncoding; hasBom: boolean; converted: boolean },
): TabMeta[] {
  return tabs.map((t) =>
    t.path === path
      ? {
          ...t,
          mtimeMs: next.mtimeMs,
          eolChanged: false,
          encoding: next.encoding,
          hasBom: next.hasBom,
          readOnly: next.converted ? false : t.readOnly,
          readOnlyReason: next.converted ? null : t.readOnlyReason,
        }
      : t,
  );
}

/** 换行统一后的标签（`unifyEol` 用）：混合换行变成单一换行后文件可写。 */
export function applyUnifiedEol(tabs: TabMeta[], path: string, eol: Eol): TabMeta[] {
  return tabs.map((t) =>
    t.path === path ? { ...t, eol, eolChanged: true, readOnly: false, readOnlyReason: null } : t,
  );
}

/**
 * 改名后的标签：路径与显示名跟着走，`dirty` 等状态原样保留——
 * 内容还在 model 里，只是挪了个位置。
 */
export function renameTabs(tabs: TabMeta[], oldPath: string, newPath: string): TabMeta[] {
  return tabs.map((t) => {
    const next = remapPath(t.path, oldPath, newPath);
    return next === t.path ? t : { ...t, path: next, name: baseName(next) };
  });
}
