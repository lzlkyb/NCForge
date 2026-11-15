import { listCommands } from "../../lib/commandRegistry";
import { closePalette } from "../../lib/paletteStore";
import { baseName } from "../../lib/workspace";

export function PaletteSymbolTools({ path, methodsOnly, onMethodsOnly }: {
  path: string | null; methodsOnly: boolean; onMethodsOnly: () => void;
}) {
  const pin = listCommands().find(command => command.id === "editor.outlinePin");
  return <div className="qp-symbol-tools">
    <span title={path ?? undefined}>{path ? baseName(path) : "当前文件"}</span>
    {path && /\.java$/i.test(path) && <button type="button" className="qp-symbol-action" aria-pressed={methodsOnly} onClick={onMethodsOnly}>只看方法</button>}
    <button type="button" className="qp-symbol-action" disabled={!pin} onClick={() => { if (!pin) return; pin.run(); closePalette(); }}>固定到侧栏</button>
  </div>;
}
