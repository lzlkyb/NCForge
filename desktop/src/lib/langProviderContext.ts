import { pathOfModel } from "./editorStore";
import { flushDoc, inLangModule, langReady } from "./lang";
import { toLspPosition, type LspPosition } from "./langConvert";
import type { monaco } from "./monacoSetup";
import { toast } from "../components/ui/toast";

let lastSyncErrorAt = -Infinity;

export interface Ctx {
  path: string;
  position: LspPosition;
}

/** 所有语义请求都先同步最新文档，等待期间切换模块或销毁模型则取消。 */
export async function context(
  model: ReturnType<typeof monaco.editor.createModel>,
  pos: { lineNumber: number; column: number },
): Promise<Ctx | null> {
  const path = pathOfModel(model);
  if (!path || !langReady() || !inLangModule(path)) return null;
  try { await flushDoc(path); }
  catch (error) {
    if (Date.now() - lastSyncErrorAt >= 60_000) {
      lastSyncErrorAt = Date.now();
      toast(`代码智能未能同步最新编辑，请稍后重试（${String(error)}）`, "warning");
    }
    return null;
  }
  if (!langReady() || !inLangModule(path) || model.isDisposed()) return null;
  return { path, position: toLspPosition(pos.lineNumber, pos.column) };
}
