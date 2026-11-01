// 跨文件重命名。
//
// 为什么不直接用 Monaco 的 `registerRenameProvider`：Monaco 会把 WorkspaceEdit 交给它自己的
// 编辑服务，而那个服务**只认已经打开的 model**——这次重命名里没打开的文件会被静默跳过，
// 结果就是「改了一半」：调用点改名了，另一边还是旧名字，编译才炸出来。
// 所以这里自己做：先拿 jdt.ls 的完整编辑清单，给人看过「会动哪几个文件、各几处」再写；
// 打开着的走 model（可撤销、状态栏显未保存），没打开的读盘 → 改文本 → 按原编码写回。
//
// 纯函数（分组 / 应用编辑）在 `renameEdits.ts`：本文件 import 了 editorStore → Monaco，
// 单测只能碰那边。
import { flushDoc, langRequest } from "./lang";
import { findModel } from "./editorStore";
import { readFile, writeFile, type FileContent } from "./workspace";
import { captureLocalHistory } from "./localHistory";
import { applyLspEdits, groupEdits, type RenamePlan, type RenameResult } from "./renameEdits";

export type { RenameGroup, RenamePlan, RenameResult, LspTextEdit } from "./renameEdits";

/** 问 jdt.ls「把这个位置上的符号改成 newName 要动哪些地方」。 */
export async function planRename(path: string, line: number, column: number, newName: string): Promise<RenamePlan> {
  const name = newName.trim();
  if (!name) throw new Error("新名字不能为空");
  // 没发出去的修改要先同步：否则算的是改动前的文本，编辑位置会整体错位
  await flushDoc(path);
  const res = await langRequest<unknown>(
    "textDocument/rename",
    path,
    { position: { line: line - 1, character: column - 1 }, newName: name },
    20_000,
  );
  const { groups, skipped } = groupEdits(res);
  if (groups.length === 0 && skipped.length === 0) {
    throw new Error("代码智能没有给出可改的位置（可能光标没停在符号上）");
  }
  return { newName: name, groups, skipped };
}

/**
 * 执行重命名。
 *
 * 打开着的文件改 model（进撤销栈、变成未保存状态，由用户决定什么时候存）；
 * 没打开的读盘改写原编码写回。两条路的区别**要让人看得见**：返回值分别计数，
 * 界面据此提示「N 个文件已写入，M 个在编辑器里未保存」。
 *
 * 两处安全设计（都是事故换来的）：
 * 1. **先预检再动手**：要写盘的文件全部先读一遍，任何一个编码无法无损往返就
 *    整体中止，一个字节都不写。边改边查会留下「改了一半」的中间态，而用户重试时
 *    按旧文本算出的编辑会套到已经改过的文件上——那才是真损坏。
 * 2. **写盘前归档本地历史**：改名是工程级写操作，进不了编辑器的撤销栈，
 *    出事只能靠本地历史退回改名前的那一版。
 */
export async function applyRenamePlan(plan: RenamePlan): Promise<RenameResult> {
  // ── 预检：读全部待写盘的文件（内容复用，执行时不再读第二次）──
  const disk = new Map<string, FileContent>();
  for (const g of plan.groups) {
    const m = findModel(g.path);
    if (m && !m.isDisposed()) continue; // 编辑器里的走 model，不读盘
    const c = await readFile(g.path);
    if (!c.lossless) {
      throw new Error(
        `${g.path} 的编码无法无损往返，已中止（没有写入任何文件）。请先把它转成 UTF-8 再改名。`,
      );
    }
    disk.set(g.path.toLowerCase(), c);
  }

  // ── 执行 ──
  let written = 0;
  let inEditor = 0;
  for (const g of plan.groups) {
    const model = findModel(g.path);
    if (model && !model.isDisposed()) {
      // 排序交给 Monaco：它按 range 自己处理先后，不需要我们先倒序
      model.applyEdits(
        g.edits.map((e) => ({
          range: {
            startLineNumber: e.range.start.line + 1,
            startColumn: e.range.start.character + 1,
            endLineNumber: e.range.end.line + 1,
            endColumn: e.range.end.character + 1,
          },
          text: e.newText,
          forceMoveMarkers: true,
        })),
      );
      inEditor += 1;
      continue;
    }
    const c = disk.get(g.path.toLowerCase());
    if (!c) continue; // 预检时已经读过一遍，这里不可能缺
    const text = applyLspEdits(c.text, g.edits);
    if (text === c.text) continue;
    // 归档失败不挡住改名：历史是兜底，为主功能让路
    await captureLocalHistory(g.path).catch(() => null);
    // expectedMtimeMs 用读到的值：中途被别的程序改过就报 CONFLICT，而不是覆盖别人的改动
    await writeFile({ path: g.path, text, encoding: c.encoding, hasBom: c.hasBom, eol: c.eol, expectedMtimeMs: c.mtimeMs });
    written += 1;
  }
  return { written, inEditor };
}
