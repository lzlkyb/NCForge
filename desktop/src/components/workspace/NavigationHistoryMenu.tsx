import { Menu, MenuItem } from "../ui/Menu";
import { relativeTo } from "../../lib/compile";
import { jdtDisplayName } from "../../lib/langConvert";
import { useNav, type NavPoint } from "../../lib/navHistory";
import { baseName, dirName } from "../../lib/workspace";

function HistoryItems({ points, cursor, root, onSelect }: {
  points: readonly NavPoint[]; cursor: number; root: string; onSelect: (index: number) => void;
}) {
  return points.map((point, index) => ({ point, index })).reverse().map(({ point, index }) => {
    const name = point.jdt ? jdtDisplayName(point.path) : baseName(point.path);
    const scope = point.jdt ? "依赖库" : dirName(relativeTo(root, point.path)) || "工作区根";
    const detail = [scope, point.symbol, `第 ${point.line} 行`].filter(Boolean).join(" · ");
    return <MenuItem key={index} disabled={index === cursor} onClick={() => onSelect(index)} label={
      <span className="wb-nav-record" title={`${name} · ${detail}`}>
        <span>{name}</span><small>{detail}</small>
      </span>
    } />;
  });
}

export function NavigationHistoryMenu({ root, onSelect }: { root: string; onSelect: (index: number) => void }) {
  const { points, cursor } = useNav();
  return <Menu portal align="left" width="w-72" trigger={(open, toggle) => (
    <button type="button" className="wb-outline-btn wb-jump-history" aria-haspopup="menu" aria-expanded={open}
      disabled={points.length < 2} onClick={toggle} title="选择最近的代码跳转位置">跳转记录</button>
  )}>
    {close => <HistoryItems points={points} cursor={cursor} root={root}
      onSelect={index => { close(); onSelect(index); }} />}
  </Menu>;
}
