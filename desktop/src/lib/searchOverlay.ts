// 搜索 overlay 的数据源：把「未保存的 Monaco model」交给搜索后端。
//
// 为什么单独一个文件而不写进 `lib/search.ts`：`editorStore` 顶部就 import 了 Monaco，
// 而 `lib/search.ts` 被一批 jsdom 组件测试直接 import。放进 search.ts 等于给这些
// 测试塞一个 Monaco（jsdom 下会直接抛错）。这里用「注册 provider」把依赖挡在
// 代码工作台的延迟加载路径上：没有编辑文件时不提前加载 Monaco。

import { forEachDirtyModel } from "./editorStore";
import { setOverlayProvider, type OverlayDoc } from "./search";
import { getSession } from "./workspaceSession";

/** 单个未保存文件的上限：超过就不传，避免每次敲键都搬一份大文本过 IPC。 */
const MAX_DOC_CHARS = 200_000;
/** 总量上限（dirty 文件通常个位数，这里是防止极端情况拖慢每次搜索）。 */
const MAX_TOTAL_CHARS = 4_000_000;

/** 绝对路径 → 工作区相对路径（`/` 分隔）；不在工作区内返回 `null`。 */
function toWorkspaceRel(path: string, root: string): string | null {
  const p = path.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p.length <= r.length + 1) return null;
  if (p.slice(0, r.length).toLowerCase() !== r.toLowerCase()) return null;
  if (p[r.length] !== "/") return null;
  return p.slice(r.length + 1);
}

// Weak keys avoid retaining closed editor models or their cached text.
const textCache = new WeakMap<object, { version: number; text: string; revision: string }>();

function collect(): OverlayDoc[] {
  const root = getSession().root;
  if (!root) return [];
  const docs: OverlayDoc[] = [];
  let budget = MAX_TOTAL_CHARS;
  forEachDirtyModel((abs, model) => {
    if (budget <= 0) return;
    const rel = toWorkspaceRel(abs, root);
    if (!rel) return;
    if (model.getValueLength() > Math.min(MAX_DOC_CHARS, budget)) return;
    const version = model.getVersionId();
    let cached = textCache.get(model);
    if (!cached || cached.version !== version) {
      cached = { version, text: model.getValue(), revision: crypto.randomUUID() };
      textCache.set(model, cached);
    }
    const text = cached.text;
    if (text.length > MAX_DOC_CHARS || text.length > budget) return;
    budget -= text.length;
    docs.push({ path: rel, text, revision: cached.revision });
  });
  return docs;
}

/** 代码工作台加载时注册。收集发生在搜索时，重复调用安全。 */
export function installSearchOverlay(): void {
  setOverlayProvider(collect);
}
