import { Icon } from "../ui/icon";
import { MenuItem } from "../ui/Menu";
import {
  toggleCompactPackages,
  usePackageView,
  toggleNcStructure,
  useCompactPackages,
  useNcStructure,
} from "../../lib/treeViewPrefs";
import { toggleDirectSwitch, useDirectSwitch } from "../../lib/projectSwitchPref";
import { useNcComponents } from "../../hooks/useNcComponents";

/**
 * 文件树的低频视图选项；自动定位作为高频开关常驻树标题栏。
 * 「压缩中间包」默认开：单链目录合成一行（对标 IDEA Compact Middle Packages / Eclipse Flat）。
 *
 * 「跨工程直接切换」默认**关**：跨工程打开会关掉全部标签、重启 jdt.ls，首次要点确认。
 * 与其他设置收在同一菜单，勾选状态明确展示这个隐式行为。
 *
 * 「NC 结构视图」默认**关**，且**只在 manifest.xml 登记了业务组件时可用**：
 * 它把 `bill/src/public` 这类源码根从 `src` 层里提上来，靠的是 NC 的业务组件登记表；
 * 没有登记表的工程点了也不会有任何变化，所以这里直接置灰并说明原因，不做「点了没反应」。
 */
export function TreeViewOptions({ root, onClose }: { root?: string; onClose: () => void }) {
  const compact = useCompactPackages();
  const direct = useDirectSwitch();
  const packageView = usePackageView();
  const nc = useNcStructure();
  // 只看当前工作区这一份：别的工程有没有登记，不影响这里能不能用
  const { bcNames } = useNcComponents(root ? [root] : [], false);
  const ncReady = bcNames.size > 0;
  return (
    <>
      <MenuItem label="压缩中间包" checked={compact} trailing={compact ? <Icon name="check" size={16} /> : undefined}
        onClick={() => { toggleCompactPackages(); onClose(); }} />
      <MenuItem label="NC 结构视图" checked={nc} trailing={nc ? <Icon name="check" size={16} /> : undefined}
        disabled={!ncReady || packageView} onClick={() => { toggleNcStructure(); onClose(); }} />
      {(!ncReady || packageView) && <p className="wb-tree-menu-note">{packageView ? "切换文件视图后可使用 NC 结构" : "当前工程未登记 NC 业务组件"}</p>}
      <MenuItem label="跨工程直接切换" checked={direct} trailing={direct ? <Icon name="check" size={16} /> : undefined}
        onClick={() => { toggleDirectSwitch(); onClose(); }} />
      <p className="wb-tree-menu-note">跨工程切换会关闭当前标签并重建代码索引。</p>
    </>
  );
}
