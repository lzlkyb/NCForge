import { useState } from "react";
import { Icon } from "../ui/icon";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { newConsole } from "../../lib/dbActions";

/**
 * 表页右上：导出 / 导入是每天要用的，做成常驻按钮，一次点击直达；结构对比、搬运、
 * 控制台查询几个月才用一次，收进「更多」。
 *
 * 三枚按钮由外层 `<span className="dbx-obj-actions">` 包住整体粘在右端：这条标签栏
 * 是隐藏滚动条的横向容器（CSS 见 db-console.css），不粘的话窗口一窄就被推出可见区。
 */
export function TableMoreActions({
  connId,
  table,
  disabled,
  onExport,
  onImport,
  onStructDiff,
  onMove,
}: {
  connId: string;
  table: string;
  disabled: boolean;
  onExport: () => void;
  onImport: () => void;
  onStructDiff: () => void;
  onMove: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  return (
    <span className="dbx-obj-actions">
      <button
        type="button"
        className="dbx-btn"
        disabled={disabled}
        title="导出 INSERT 脚本"
        onClick={onExport}
      >
        <Icon name="download" size={12} />
        导出
      </button>
      <button
        type="button"
        className="dbx-btn"
        disabled={disabled}
        title="从 CSV / JSON / XLSX 文件导入数据"
        onClick={onImport}
      >
        <Icon name="upload" size={12} />
        导入
      </button>
      <button
        type="button"
        className="dbx-btn ghost"
        aria-label="更多表操作"
        aria-haspopup="menu"
        title="更多表操作：结构对比、搬运、控制台查询"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({
            x: r.left,
            y: r.bottom + 4,
            items: [
              // 结构对比要读对方库，跟表数据状态无关，所以不受 disabled 限制
              { label: "与另一张表对比结构", icon: "columns", onSelect: onStructDiff },
              // 搬到另一个库也是「读这张表 + 写目标库」，不受当前表数据状态限制
              { label: "搬运到另一张表", icon: "arrowRight", onSelect: onMove },
              {
                label: "在控制台查询",
                icon: "terminal",
                onSelect: () => void newConsole(connId, `select * from ${table} where rownum <= 100`),
              },
            ],
          });
        }}
      >
        <Icon name="more" size={15} />
        更多
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </span>
  );
}
