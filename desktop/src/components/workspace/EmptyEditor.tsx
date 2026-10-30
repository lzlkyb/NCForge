import { Icon } from "../ui/icon";
import { getKeymap, paletteKeysLabel, WORKSPACE_SEARCH_KEY } from "../../lib/keymap";
import { openPalette } from "../../lib/paletteStore";
import { getRecent } from "../../lib/recentFiles";
import { baseName, dirName } from "../../lib/workspace";

/**
 * 没有打开任何文件时的编辑器空页：最近打开的文件 + 快捷键。
 * 以前只有一句「从左侧文件树打开一个文件」——不说还有别的路。
 */
export function EmptyEditor({ root, onOpen }: { root: string; onOpen: (path: string) => void }) {
  const keymap = getKeymap();
  const recent = getRecent(root).slice(0, 5);
  const rel = (p: string) => dirName(p).slice(root.length).replace(/^[\\/]+/, "");
  const keys: [string, string][] = [
    ["转到文件", paletteKeysLabel("file", keymap)],
    ["转到类型", paletteKeysLabel("type", keymap)],
    ["命令面板", paletteKeysLabel("cmd", keymap)],
    ["全工程搜索", WORKSPACE_SEARCH_KEY],
    ["切换侧栏 / 底部面板", "Ctrl+B / Ctrl+J"],
  ];
  return (
    <div className="wb-editor-empty">
      <div className="wb-empty-box">
        <h2>{baseName(root)}</h2>
        <p className="wb-empty-sub">{root}</p>
        {recent.length > 0 && (
          <>
            <div className="wb-empty-h">最近打开</div>
            {recent.map((p) => (
              <button key={p} type="button" className="wb-empty-row" onClick={() => onOpen(p)} title={p}>
                <Icon name="file" size={14} />
                <span>{baseName(p)}</span>
                <span className="wb-empty-mu">{rel(p)}</span>
              </button>
            ))}
          </>
        )}
        <div className="wb-empty-h">快捷键</div>
        {keys.map(([label, k]) => (
          <div key={label} className="wb-empty-row wb-empty-key">
            {label}
            <kbd>{k}</kbd>
          </div>
        ))}
        <button type="button" className="wb-empty-go" onClick={() => openPalette("file")}>
          <Icon name="search" size={13} />
          转到文件…
        </button>
      </div>
    </div>
  );
}
