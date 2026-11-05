import { getModel } from "./editorStore";
import { localDocumentOutline } from "./localDocumentOutline";
import type { FlatSymbol } from "./symbols";

type Model = NonNullable<ReturnType<typeof getModel>>;
const empty: FlatSymbol[] = [];
const cache = new WeakMap<Model, { version: number; symbols: FlatSymbol[] }>();

export function currentDocumentOutline(path: string): FlatSymbol[] {
  const model = getModel(path);
  if (!model || model.getValueLength() > 512 * 1024) return empty;
  const version = model.getVersionId();
  const previous = cache.get(model);
  if (previous?.version === version) return previous.symbols;
  const symbols = localDocumentOutline(path, model.getValue());
  cache.set(model, { version, symbols });
  return symbols;
}
