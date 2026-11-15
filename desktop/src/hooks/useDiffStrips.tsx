/**
 * 在只读对比的新侧插入「改动块标注条」（view zone + React portal）。
 *
 * - 只加在新侧编辑器：Monaco 0.52 的对比对齐会把用户自己加的 view zone 算进去（computeRangeAlignment 读
 *   两侧的 whitespace），旧侧会自动补等高的空白；单栏内联模式下本来就只有新侧。
 * - 换模型（切文件 / 内容变了）时 view zone 随旧视图一起没了，所以以 `tick`（每次 setModel 自增）为依赖重加。
 * - `suppressMouseDown`：点条上的按钮不让编辑器抢焦点 / 移光标，按钮的 click 照常触发。
 * - 位置与高度没变时不重建 zone（否则每次审一块都要闪一下），只通过 portal 更新内容。
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface StripSpec {
  key: string;
  /** 新侧行号，条插在这一行之后（0 = 文件最前面）。 */
  afterLine: number;
  height: number;
  node: ReactNode;
}

interface ZoneHost {
  changeViewZones?: (cb: (acc: { addZone(z: object): string; removeZone(id: string): void }) => void) => void;
}
interface DiffHost { getModifiedEditor?: () => ZoneHost }

export function useDiffStrips(editor: DiffHost | null, tick: number, specs: readonly StripSpec[]): ReactNode {
  const [hosts, setHosts] = useState<ReadonlyMap<string, HTMLElement>>(() => new Map());
  const layout = specs.map((s) => `${s.key}@${s.afterLine}:${s.height}`).join("|");
  useEffect(() => {
    const ed = editor?.getModifiedEditor?.();
    if (!ed?.changeViewZones || !specs.length) {
      setHosts((prev) => (prev.size ? new Map() : prev));
      return;
    }
    const ids: string[] = [];
    const next = new Map<string, HTMLElement>();
    ed.changeViewZones((acc) => {
      for (const s of specs) {
        const dom = document.createElement("div");
        dom.className = "vc-strip-zone";
        ids.push(acc.addZone({ afterLineNumber: s.afterLine, heightInPx: s.height, domNode: dom, suppressMouseDown: true }));
        next.set(s.key, dom);
      }
    });
    setHosts(next);
    return () => {
      // 卸载时编辑器可能已先一步销毁（它的 effect 声明在前、先清理），那时 zone 已随视图一起没了
      try { ed.changeViewZones?.((acc) => ids.forEach((id) => acc.removeZone(id))); } catch { /* 已销毁 */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- specs 每次渲染是新数组，用 layout 代表位置与高度变化
  }, [editor, tick, layout]);
  return <>{specs.map((s) => { const el = hosts.get(s.key); return el ? createPortal(s.node, el, s.key) : null; })}</>;
}
