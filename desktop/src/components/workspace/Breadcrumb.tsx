import { Fragment, useEffect, useState } from "react";
import { Icon } from "../ui/icon";
import { useCursor } from "../../lib/cursorStore";
import { inLangModule, navigate, useLangView } from "../../lib/lang";
import { jdtDisplayName } from "../../lib/langConvert";
import { chainAt, fetchSymbols, kindLetter, type FlatSymbol } from "../../lib/symbols";
import type { TabMeta } from "../../lib/workspaceSession";

/** 路径相对工作区根。不在根下就退回全路径。 */
function segmentsOf(root: string, path: string): string[] {
  const r = root.replace(/[\\/]+$/, "");
  const rel = path.toLowerCase().startsWith(`${r.toLowerCase()}\\`) ? path.slice(r.length + 1) : path;
  return rel.split(/[\\/]/).filter(Boolean);
}

/**
 * 编辑器上方的面包屑：`模块 › 目录 › 文件 › 类 › 方法`。
 *
 * 前半段是路径，后半段是光标所在的符号链（来自 jdt.ls 的 documentSymbol）。代码智能没就绪、或文件不在
 * 语言服务覆盖的模块里时只显示路径。点符号段跳到该符号。
 */
export function Breadcrumb({ root, active }: { root: string; active: TabMeta }) {
  const cursor = useCursor();
  const lang = useLangView();
  const [symbols, setSymbols] = useState<{ path: string; list: FlatSymbol[] } | null>(null);

  const javaPath = !active.virtual && active.path.toLowerCase().endsWith(".java") ? active.path : null;
  const canAsk = javaPath !== null && lang.state === "ready" && inLangModule(javaPath);
  // 保存后 mtime 变了再取一次；边打字边取太费，符号链的最后一段在保存之前可能略旧，这是有意的
  useEffect(() => {
    if (!canAsk || !javaPath) return;
    let alive = true;
    fetchSymbols(javaPath)
      .then((list) => alive && setSymbols({ path: javaPath, list }))
      .catch(() => alive && setSymbols(null));
    return () => {
      alive = false;
    };
  }, [canAsk, javaPath, active.mtimeMs, lang.settled]);

  const parts = active.virtual ? ["jar", jdtDisplayName(active.path)] : segmentsOf(root, active.path);
  const chain = symbols && symbols.path === javaPath && canAsk ? chainAt(symbols.list, cursor.line) : [];

  return (
    <div className="wb-crumb" aria-label="当前位置">
      {parts.map((p, i) => (
        <Fragment key={`${i}:${p}`}>
          {i > 0 && <Icon name="chevronRight" size={11} className="wb-crumb-sep" />}
          <span className={i === parts.length - 1 ? "wb-crumb-seg wb-crumb-file" : "wb-crumb-seg"}>{p}</span>
        </Fragment>
      ))}
      {chain.map((s) => (
        <Fragment key={`${s.startLine}:${s.name}`}>
          <Icon name="chevronRight" size={11} className="wb-crumb-sep" />
          <button
            type="button"
            className="wb-crumb-seg wb-crumb-sym"
            title={`跳到第 ${s.line} 行`}
            onClick={() => javaPath && navigate({ kind: "file", path: javaPath, line: s.line, column: s.column })}
          >
            <span className="wb-crumb-k">{kindLetter(s.kind)}</span>
            {s.name}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
