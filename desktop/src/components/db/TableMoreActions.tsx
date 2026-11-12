import { useState } from "react";
import { Icon } from "../ui/icon";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { newConsole } from "../../lib/dbActions";

/** 表页右上「更多」：导出 / 导入 / 新查询。状态留在这里，表页本体就不必再挂一个菜单 state。 */
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
    <>
      <button
        type="button"
        className="dbx-btn ghost dbx-more-actions"
        title="表操作：导出 INSERT、从文件导入、在控制台查询"
        aria-label="更多表操作"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({
            x: r.left,
            y: r.bottom + 4,
            items: [
              { label: "导出 INSERT", icon: "download", disabled, onSelect: onExport },
              { label: "从文件导入", icon: "upload", disabled, onSelect: onImport },
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
        表操作
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
