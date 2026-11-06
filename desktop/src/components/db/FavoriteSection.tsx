import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Icon, type IconName } from "../ui/icon";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { EnvDot } from "./EnvChips";
import { dbApi } from "../../lib/dbApi";
import { ensureConnected } from "../../lib/dbConfirm";
import { openTable } from "../../lib/dbActions";
import { openTableTab, rtOf, useDbConns, useDbRt } from "../../lib/dbStore";
import {
  favoriteKey,
  toggleFavorite,
  useAllFavorites,
  type FavoriteItem,
} from "../../lib/dbFavorites";
import { copyText } from "../../lib/utils";
import { toast } from "../ui/toast";

const OPEN_KEY = "ncforge-db-fav-open";

const OBJECT_ICON: Record<string, IconName> = {
  PACKAGE: "package",
  PROCEDURE: "file",
  FUNCTION: "file",
  TRIGGER: "activity",
  SEQUENCE: "activity",
  SYNONYM: "external",
  TYPE: "package",
};

/** 失效判断要对象清单；ConnObjects 展开时才拉，收藏区不能等它，按连接单独取一份。
 *  不做跨刷新缓存：DDL / 重连之后清单会变，缓存留着只会让失效标记一直停在旧结论。 */
const objectKey = (type: string, name: string) => `${type.toUpperCase()}\u0000${name.toUpperCase()}`;

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * 侧栏顶部跨连接收藏。
 *
 * 不要求连接已展开/已连上：点击行再按需连接；连接名和状态点一直在右侧，
 * 同名表在不同库之间也能分清。对象失效只做提示，不自动删收藏。
 */
export function FavoriteSection({ filter, onLocate }: { filter: string; onLocate: (connId: string) => void }) {
  // 收藏要按连接状态 / 表清单过滤：订连接清单 + 运行态，不订标签
  useDbRt();
  const db = { conns: useDbConns() };
  const items = useAllFavorites();
  const [open, setOpen] = useState(readOpen);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [objects, setObjects] = useState<Record<string, Set<string>>>({});
  const q = filter.trim().toLowerCase();

  const byId = useMemo(() => new Map(db.conns.map((c) => [c.id, c])), [db.conns]);
  const connOrder = useMemo(() => new Map(db.conns.map((c, i) => [c.id, i])), [db.conns]);
  const visible = items.filter((f) => byId.has(f.connId));
  const objectConns = useMemo(
    () => [...new Set(items.filter((f) => f.kind === "object" && byId.has(f.connId)).map((f) => f.connId))].sort(),
    [items, byId],
  );
  // 连接刷新（`refreshMeta`）会更新 tablesAt：把它并进依赖里，表/对象清单变了
  // 就重新取一遍对象，失效标记不会停在刷新前的结论上。
  const connectedObjectKey = objectConns
    .filter((id) => rtOf(id).status === "connected")
    .map((id) => `${id}:${rtOf(id).tablesAt ?? 0}`)
    .join("|");

  useEffect(() => {
    if (!connectedObjectKey) return;
    let alive = true;
    for (const entry of connectedObjectKey.split("|")) {
      const id = entry.split(":")[0];
      dbApi.objects(id).then(
        (r) => {
          const set = new Set(r.objects.map((o) => objectKey(o.type, o.name)));
          if (alive) setObjects((prev) => ({ ...prev, [id]: set }));
        },
        () => undefined,
      );
    }
    return () => {
      alive = false;
    };
  }, [connectedObjectKey]);

  const shown = (q
    ? visible.filter((f) => {
        const conn = byId.get(f.connId)!;
        const name = f.name.toLowerCase();
        const zh = (rtOf(f.connId).ncNames?.[name] ?? "").toLowerCase();
        return name.includes(q) || zh.includes(q) || conn.name.toLowerCase().includes(q);
      })
    : visible
  )
    .slice()
    .sort((a, b) => {
      const ai = connOrder.get(a.connId) ?? 1e9;
      const bi = connOrder.get(b.connId) ?? 1e9;
      if (ai !== bi) return ai - bi;
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      return an === bn ? (a.otype ?? "").localeCompare(b.otype ?? "") : an.localeCompare(bn);
    });

  const stale = (f: FavoriteItem): boolean => {
    const rt = rtOf(f.connId);
    if (rt.status !== "connected") return false;
    if (f.kind === "table") {
      return !!rt.tables && !rt.tables.some((t) => t.name.toUpperCase() === f.name);
    }
    if (!f.otype) return false;
    const known = objects[f.connId];
    return !!known && !known.has(objectKey(f.otype, f.name));
  };

  const openItem = (f: FavoriteItem) => {
    if (f.kind === "table") {
      void openTable(f.connId, f.name);
      return;
    }
    void ensureConnected(f.connId).then((ok) => {
      if (ok) openTableTab(f.connId, f.name, "source", f.otype);
    });
  };

  const copyName = (f: FavoriteItem) => {
    const text = f.name.toLowerCase();
    void copyText(
      text,
      () => toast(`已复制 ${text}`, "success"),
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  const menuItems = (f: FavoriteItem): ContextMenuItem[] =>
    f.kind === "table"
      ? [
          { label: "打开数据", icon: "database", onSelect: () => openItem(f) },
          { label: "查看结构", icon: "info", onSelect: () => void openTable(f.connId, f.name, "struct") },
          { label: "查看 DDL", icon: "file", onSelect: () => void openTable(f.connId, f.name, "ddl") },
          { label: "在连接中定位", icon: "target", separator: true, onSelect: () => onLocate(f.connId) },
          { label: "复制名称", icon: "copy", onSelect: () => copyName(f) },
          { label: "取消收藏", icon: "star", onSelect: () => toggleFavorite(f.connId, f.kind, f.name, f.otype) },
        ]
      : [
          { label: "打开源码", icon: "file", onSelect: () => openItem(f) },
          { label: "在连接中定位", icon: "target", separator: true, onSelect: () => onLocate(f.connId) },
          { label: "复制名称", icon: "copy", onSelect: () => copyName(f) },
          { label: "取消收藏", icon: "star", onSelect: () => toggleFavorite(f.connId, f.kind, f.name, f.otype) },
        ];

  const showMenu = (e: MouseEvent, f: FavoriteItem) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: menuItems(f) });
  };

  if (visible.length === 0 && !q) {
    if (db.conns.length === 0) return null;
    return <p className="dbx-fav-empty" title="在表或对象上点 ★，常用对象会出现在这里">点 ★ 收藏常用对象</p>;
  }
  if (shown.length === 0) return null;

  const expanded = open || !!q;
  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // 存不下就只在本次生效
    }
  };

  return (
    <div className="dbx-fav">
      <button
        type="button"
        className="dbx-sgroup"
        aria-expanded={expanded}
        title="跨连接收藏：点击收起 / 展开"
        onClick={toggleOpen}
      >
        <Icon name={expanded ? "chevronDown" : "chevronRight"} size={11} />
        收藏
        <span className="dbx-cnt">{q ? shown.length : visible.length}</span>
      </button>
      {expanded &&
        shown.map((f) => {
          const conn = byId.get(f.connId)!;
          const isStale = stale(f);
          const label = f.name.toLowerCase();
          const title = `${label}${f.kind === "object" && f.otype ? ` · ${f.otype}` : ""}${isStale ? "（对象不存在）" : ""} · ${conn.name}（${conn.user}@${conn.url}）`;
          return (
            <button
              key={favoriteKey(f.connId, f.kind, f.name, f.otype)}
              type="button"
              className="dbx-trow dbx-favrow"
              data-stale={isStale ? "" : undefined}
              title={title}
              aria-keyshortcuts="Delete"
              onClick={() => openItem(f)}
              onContextMenu={(e) => showMenu(e, f)}
              onKeyDown={(e) => {
                // 行本身是按钮：Delete/退格直接取消收藏，Shift+F10 打开完整菜单。
                if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  toggleFavorite(f.connId, f.kind, f.name, f.otype);
                  return;
                }
                if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left + 12, y: r.bottom, items: menuItems(f) });
              }}
            >
              <Icon name={f.kind === "table" ? "database" : (OBJECT_ICON[f.otype ?? ""] ?? "package")} size={12} />
              <span className="nm">{label}</span>
              <span className="dbx-fav-conn">
                <EnvDot env={conn.env} />
                {conn.name}
              </span>
            </button>
          );
        })}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
