import { monaco } from "./monacoSetup";

/**
 * SQL 标签的 Monaco model：一个标签一个，切标签只换 model（撤销栈、光标都留着）。
 * URI 里带标签 id，补全时靠它找到这个标签用的是哪个连接。
 */

const SCHEME = "ncforge-sql";
const models = new Map<string, monaco.editor.ITextModel>();

export function sqlModel(tabId: string, initial: string): monaco.editor.ITextModel {
  let m = models.get(tabId);
  if (!m || m.isDisposed()) {
    m = monaco.editor.createModel(initial, "sql", monaco.Uri.from({ scheme: SCHEME, path: `/${tabId}.sql` }));
    models.set(tabId, m);
  }
  return m;
}

export function tabIdOfModel(model: monaco.editor.ITextModel): string | null {
  if (model.uri.scheme !== SCHEME) return null;
  return model.uri.path.replace(/^\//, "").replace(/\.sql$/, "");
}

export function disposeSqlModel(tabId: string) {
  models.get(tabId)?.dispose();
  models.delete(tabId);
}
