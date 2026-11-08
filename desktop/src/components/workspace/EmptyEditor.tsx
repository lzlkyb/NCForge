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
        <div className="wb-empty-head">
          <div className="wb-empty-project">
            <h2>{baseName(root)}</h2>
            <p className="wb-empty-sub" title={root}>{root}</p>
          </div>
          <button type="button" className="wb-empty-go" onClick={() => openPalette("file")}>
            <Icon name="search" size={16} />
            转到文件…
          </button>
        </div>
        <div className="wb-empty-layout">
          <section className="wb-empty-section" aria-label="最近打开的文件">
            <h3 className="wb-empty-h">最近打开</h3>
            {recent.map((p) => (
              <button key={p} type="button" className="wb-empty-row wb-empty-file" onClick={() => onOpen(p)} title={p}>
                <Icon name="file" size={16} />
                <span className="wb-empty-file-meta">
                  <span className="wb-empty-name">{baseName(p)}</span>
                  <span className="wb-empty-mu">{rel(p) || "工作区根目录"}</span>
                </span>
              </button>
            ))}
            {recent.length === 0 && <p className="wb-empty-note">暂无最近文件。从左侧资源树打开文件，或使用“转到文件”。</p>}
          </section>
          <section className="wb-empty-section" aria-label="编辑器快捷键">
            <h3 className="wb-empty-h">快捷键</h3>
            {keys.map(([label, k]) => (
              <div key={label} className="wb-empty-row wb-empty-key">
                {label}
                <kbd>{k}</kbd>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
