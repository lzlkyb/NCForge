import { Icon } from "../ui/icon";
import {
  toggleCompactPackages,
  toggleRevealOnOpen,
  useCompactPackages,
  useRevealOnOpen,
} from "../../lib/treeViewPrefs";
import { toggleDirectSwitch, useDirectSwitch } from "../../lib/projectSwitchPref";

/**
 * 文件树的视图选项，默认开：
 * - 自动定位：右边打开文件时，左边展开并滚到那一行（对标 IDEA Autoscroll to Source）。
 *   显式的「在文件树中显示」不受这个开关影响，随时可用。
 * - 压缩中间包：单链目录合成一行（对标 IDEA Compact Middle Packages / Eclipse Flat）。
 *
 * 「跨工程直接切换」默认**关**：跨工程打开会关掉全部标签、重启 jdt.ls，首次要点确认。
 * 放在同一排是为了让「不弹确认」这个隐式行为有个看得见的开关。
 */
export function TreeViewOptions() {
  const compact = useCompactPackages();
  const reveal = useRevealOnOpen();
  const direct = useDirectSwitch();
  return (
    <>
      <button
        type="button"
        className="wb-icon-btn"
        aria-pressed={reveal}
        aria-label="自动定位"
        title={
          reveal
            ? "自动定位：打开文件时在文件树里展开并滚到该行（点击关闭）"
            : "自动定位已关闭：打开文件不再自动展开文件树（点击开启）"
        }
        onClick={toggleRevealOnOpen}
      >
        <Icon name="target" size={14} />
      </button>
      <button
        type="button"
        className="wb-icon-btn"
        aria-pressed={compact}
        aria-label="压缩中间包"
        title={
          compact
            ? "压缩中间包：单链目录合成一行（点击改为逐层显示）"
            : "逐层显示目录（点击改为压缩中间包）"
        }
        onClick={toggleCompactPackages}
      >
        <Icon name="package" size={14} />
      </button>
      <button
        type="button"
        className="wb-icon-btn"
        aria-pressed={direct}
        aria-label="跨工程直接切换"
        title={
          direct
            ? "跨工程打开文件时直接切换工作区，不再确认（点击恢复确认）"
            : "跨工程打开文件时先确认：会关闭全部标签并重建索引（点击改为直接切换）"
        }
        onClick={toggleDirectSwitch}
      >
        <Icon name="external" size={14} />
      </button>
    </>
  );
}
