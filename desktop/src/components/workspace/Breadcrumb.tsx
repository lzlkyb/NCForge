import { Fragment, useEffect, useState } from "react";
import { JavaSymbolIcon } from "./JavaSymbolIcon";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { WorkspaceFileName } from "./WorkspaceFileName";
import { EditorTabTypeIcon } from "./EditorTabTypeIcon";
import { useLocalOutline } from "../../hooks/useLocalOutline";
import { isNcDeclaration, ncDeclarationLabel } from "../../lib/ncDeclarationOutline";
import { useCursor } from "../../lib/cursorStore";
import { inLangModule, navigate, useLangView } from "../../lib/lang";
import { jdtDisplayName } from "../../lib/langConvert";
import { chainAt, symbolsFor, type FlatSymbol } from "../../lib/symbols";
import type { TabMeta } from "../../lib/workspaceSession";
import { breadcrumbParts } from "../../lib/breadcrumbPath";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { toast } from "../ui/toast";

/**
 * 编辑器上方的面包屑：`模块 › 目录 › 文件 › 类 › 方法`。
 *
 * 后半段来自代码智能或本地声明解析，点击可回到声明。
 */
export function Breadcrumb({ root, active }: { root: string; active: TabMeta }) {
  const cursor = useCursor();
  const lang = useLangView();
  const [symbols, setSymbols] = useState<{ path: string; list: FlatSymbol[] } | null>(null);

  const javaPath = !active.virtual && active.path.toLowerCase().endsWith(".java") ? active.path : null;
  const nc = !active.virtual && isNcDeclaration(active.path);
  const local = useLocalOutline(nc || javaPath ? active.path : null, active.mtimeMs);
  const canAsk = !active.dirty && javaPath !== null && lang.state === "ready" && inLangModule(javaPath);
  // 保存后 mtime 变了再取一次；边打字边取太费，符号链的最后一段在保存之前可能略旧，这是有意的
  useEffect(() => {
    if (!canAsk || !javaPath) return;
    let alive = true;
    symbolsFor(javaPath, active.mtimeMs)
      .then((list) => alive && setSymbols({ path: javaPath, list }))
      .catch(() => alive && setSymbols(null));
    return () => {
      alive = false;
    };
  }, [canAsk, javaPath, active.mtimeMs, lang.settled]);

  const parts = active.virtual ? ["jar", jdtDisplayName(active.path)] : breadcrumbParts(root, active.path);
  const middle = parts.length > 3 ? parts.slice(1, -1) : [];
  const chain = chainAt(symbols && symbols.path === javaPath && canAsk ? symbols.list : local, cursor.line);

  return (
    <div className="wb-crumb" aria-label="当前位置">
      {parts.map((p, i) => (
        middle.length && i > 1 && i < parts.length - 1 ? null :
        <Fragment key={`${i}:${p}`}>
          {i > 0 && <WorkspaceGlyph name="right" size={11} className="wb-crumb-sep" />}
          {i === parts.length - 1 ? <span className="wb-crumb-file" title={p}>
            <EditorTabTypeIcon path={active.path} name={active.name} mtimeMs={active.mtimeMs} />
            <WorkspaceFileName name={p} />
          </span> : middle.length && i === 1 ? <span className="wb-crumb-middle">
            <Menu portal align="left" width="w-72" trigger={(open, toggle) => <button type="button" className="wb-icon-btn" aria-label="查看完整文件路径" title={active.path} aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="more" size={12} /></button>}>
              {close => <><p className="wb-tree-menu-note" title={active.path}>{parts.join(" / ")}</p><MenuItem label="复制完整路径" icon="copy" onClick={() => { close(); void navigator.clipboard.writeText(active.path).then(() => toast("已复制文件路径", "success"), () => toast("复制文件路径失败", "error")); }} /></>}
            </Menu>
          </span> : <span className="wb-crumb-seg" title={p}>{p}</span>}
        </Fragment>
      ))}
      {chain.map((s) => (
        <Fragment key={`${s.startLine}:${s.name}`}>
          <WorkspaceGlyph name="right" size={11} className="wb-crumb-sep" />
          <button
            type="button"
            className="wb-crumb-seg wb-crumb-sym"
            title={`跳到第 ${s.line} 行`}
            onClick={() => navigate({ kind: "file", path: active.path, line: s.line, column: s.column })}
          >
            {nc ? <span className="wb-outline-kind">{ncDeclarationLabel(s.kind)}</span> : <JavaSymbolIcon kind={s.kind} />}
            {s.name}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
