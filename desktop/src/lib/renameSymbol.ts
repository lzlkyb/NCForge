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
import { getSession } from "./workspaceSession";
import { applyLspEdits, groupEdits, type RenameGroup, type RenamePlan, type RenameResult } from "./renameEdits";

export type { RenameGroup, RenamePlan, RenameResult } from "./renameEdits";

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
 * 安全设计（都是事故换来的）：
 * 1. **先校验再动手**：全部文本先在内存里应用一遍（越界/重叠直接抛错），
 *    读盘文件还要先过编码无损检查，任何一个不过就整体中止，一个字节都不写。
 * 2. **先写盘、最后改 model**：model 的 `applyEdits` 不会失败，倒过来做会出现
 *    「编辑器里改了、写盘时冲突」的半成品。
 * 3. **写盘失败回滚已写文件**：用预读的原文写回，工程不会停在「一半新名一半旧名」。
 * 4. **只读标签跳过并上报**：混合换行/编码有损的标签改得动存不进，改了反而误导。
 */
export async function applyRenamePlan(plan: RenamePlan): Promise<RenameResult> {
  const tabs = getSession().tabs;
  const readOnly = new Set(
    tabs.filter((t) => t.readOnly || t.virtual).map((t) => t.path.toLowerCase()),
  );

  // ── 预检：分类 + 在内存里应用一遍（不改任何东西）──
  interface DiskWork {
    path: string;
    content: FileContent;
    text: string;
  }
  const diskWork: DiskWork[] = [];
  const modelWork: { group: RenameGroup; model: NonNullable<ReturnType<typeof findModel>> }[] = [];
  const skippedReadOnly: string[] = [];

  for (const g of plan.groups) {
    if (readOnly.has(g.path.toLowerCase())) {
      skippedReadOnly.push(g.path);
      continue;
    }
    const model = findModel(g.path);
    if (model && !model.isDisposed()) {
      // 越界/重叠会在这里抛错；此时还没有写过任何文件
      applyLspEdits(model.getValue(), g.edits);
      modelWork.push({ group: g, model });
      continue;
    }
    const c = await readFile(g.path);
    if (!c.lossless) {
      throw new Error(
        `${g.path} 的编码无法无损往返，已中止（没有写入任何文件）。请先把它转成 UTF-8 再改名。`,
      );
    }
    const text = applyLspEdits(c.text, g.edits);
    if (text !== c.text) diskWork.push({ path: g.path, content: c, text });
  }

  // ── 执行：先写盘（失败可用原文回滚），最后改 model（不会失败）──
  const written: DiskWork[] = [];
  try {
    for (const w of diskWork) {
      // 归档失败不挡住改名：历史是兜底，为主功能让路
      await captureLocalHistory(w.path).catch(() => null);
      // expectedMtimeMs 用读到的值：中途被别的程序改过就报 CONFLICT，而不是覆盖别人的改动
      await writeFile({
        path: w.path,
        text: w.text,
        encoding: w.content.encoding,
        hasBom: w.content.hasBom,
        eol: w.content.eol,
        expectedMtimeMs: w.content.mtimeMs,
      });
      written.push(w);
    }
  } catch (e) {
    // 回滚：已经写进去的几个用预读的原文覆盖回去。
    // 这里不再校验 mtime（刚才是我们自己写的），失败也只能放弃——但错误会如实抛出。
    for (const w of written.reverse()) {
      await writeFile({
        path: w.path,
        text: w.content.text,
        encoding: w.content.encoding,
        hasBom: w.content.hasBom,
        eol: w.content.eol,
        expectedMtimeMs: null,
      }).catch(() => null);
    }
    throw e;
  }

  let inEditor = 0;
  for (const { group, model } of modelWork) {
    // 排序交给 Monaco：它按 range 自己处理先后，不需要我们先倒序
    model.applyEdits(
      group.edits.map((e) => ({
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
  }
  return { written: written.length, inEditor, skippedReadOnly };
}
