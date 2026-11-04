import { useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/icon";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { friendlyDbError, thousands } from "../../lib/db";
import { dbApi, type DbObject, type TableInfo } from "../../lib/dbApi";
import { newConsole, openTable, refreshMeta } from "../../lib/dbActions";
import { favoriteKey, toggleFavorite, useAllFavorites, type FavoriteKind } from "../../lib/dbFavorites";
import { openTableTab, useConnRt } from "../../lib/dbStore";
import { toast } from "../ui/toast";
import { copyText } from "../../lib/utils";
import { FavStar, TableRow } from "./ConnTableRow";

/** 真实库里上万张表是常态，一次全铺会让侧栏卡死：每组只渲染前 N 条，靠筛选收敛。 */
const LIMIT = 200;
const NO_NAMES: Record<string, string> = {};

/**
 * 非表对象的分组。`PACKAGE BODY` / `TYPE BODY` 不单列——点开同名 PACKAGE 时，
 * 源码页会把规范与实现按 `user_source.type` 分成两段一起显示。
 */
const OBJ_GROUPS: { label: string; types: string[]; icon: "package" | "file" | "activity" | "external" }[] = [
  { label: "包", types: ["PACKAGE"], icon: "package" },
  { label: "过程", types: ["PROCEDURE"], icon: "file" },
  { label: "函数", types: ["FUNCTION"], icon: "file" },
  { label: "触发器", types: ["TRIGGER"], icon: "activity" },
  { label: "序列", types: ["SEQUENCE"], icon: "activity" },
  { label: "同义词", types: ["SYNONYM"], icon: "external" },
  { label: "类型", types: ["TYPE"], icon: "package" },
];

/** 一个已连上的连接下面的对象：收藏 / 表 / 视图。展开表看字段。 */
export function ConnObjects({ connId, filter }: { connId: string; filter: string }) {
  const rt = useConnRt(connId);
  const favItems = useAllFavorites();
  const favKeys = useMemo(
    () =>
      new Set(
        favItems
          .filter((f) => f.connId === connId)
          .map((f) => favoriteKey(f.connId, f.kind, f.name, f.otype)),
      ),
    [favItems, connId],
  );
  const isFav = (kind: FavoriteKind, name: string, otype?: string) =>
    favKeys.has(favoriteKey(connId, kind, name, otype));
  const [groups, setGroups] = useState<Record<string, boolean>>({ TABLE: true, VIEW: false, obj: false });
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [objs, setObjs] = useState<DbObject[] | null>(null);
  const [objErr, setObjErr] = useState<string | null>(null);
  const names = rt.ncNames ?? NO_NAMES;

  // 非表对象按需读：包/过程/序列加起来可能上百条，但不像表那样一进连接就要看
  useEffect(() => {
    setObjs(null);
    setObjErr(null);
    if (rt.status !== "connected") return;
    let alive = true;
    dbApi.objects(connId).then(
      (r) => alive && setObjs(r.objects),
      (e) => {
        if (!alive) return;
        setObjs([]);
        setObjErr(friendlyDbError(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [connId, rt.status]);

  const matched = useMemo(() => {
    const all = rt.tables ?? [];
    if (!filter) return all;
    return all.filter((t) => t.name.toLowerCase().includes(filter) || (names[t.name.toLowerCase()] ?? "").includes(filter));
  }, [rt.tables, filter, names]);

  /** 对象按类型分组；`filter` 命中名字就留下。 */
  const objSections = useMemo(
    () =>
      OBJ_GROUPS.map((g) => ({
        ...g,
        list: (objs ?? []).filter(
          (o) => g.types.includes(o.type) && (!filter || o.name.toLowerCase().includes(filter)),
        ),
      })).filter((g) => g.list.length > 0),
    [objs, filter],
  );

  if (rt.tablesLoading && !rt.tables) return <p className="dbx-tree-note">读取对象…</p>;

  const tableMenu = (t: TableInfo, x: number, y: number) => {
    const lower = t.name.toLowerCase();
    const fav = isFav("table", t.name);
    setMenu({
      x,
      y,
      items: [
        { label: "打开数据", icon: "database", onSelect: () => void openTable(connId, t.name, "data") },
        { label: "查看结构", icon: "info", onSelect: () => void openTable(connId, t.name, "struct") },
        { label: "查看 DDL", icon: "file", onSelect: () => void openTable(connId, t.name, "ddl") },
        { label: "新建查询", icon: "terminal", separator: true, onSelect: () => void newConsole(connId, `select * from ${lower} where rownum <= 100`) },
        { label: "复制表名", icon: "copy", onSelect: () => void copyText(lower, () => toast(`已复制 ${lower}`, "success"), (e) => toast(`复制失败：${e}`, "error")) },
        { label: fav ? "取消收藏" : "收藏", icon: "star", onSelect: () => toggleFavorite(connId, "table", t.name) },
      ],
    });
  };

  const objMenu = (o: DbObject, x: number, y: number) => {
    const lower = o.name.toLowerCase();
    const fav = isFav("object", o.name, o.type);
    setMenu({
      x,
      y,
      items: [
        { label: "打开源码", icon: "file", onSelect: () => openTableTab(connId, o.name, "source", o.type) },
        { label: "复制名称", icon: "copy", onSelect: () => void copyText(lower, () => toast(`已复制 ${lower}`, "success"), (e) => toast(`复制失败：${e}`, "error")) },
        { label: fav ? "取消收藏" : "收藏", icon: "star", separator: true, onSelect: () => toggleFavorite(connId, "object", o.name, o.type) },
      ],
    });
  };

  const sections: { key: string; label: string; list: TableInfo[] }[] = [
    { key: "TABLE", label: "表", list: matched.filter((t) => t.kind === "TABLE") },
    { key: "VIEW", label: "视图", list: matched.filter((t) => t.kind === "VIEW") },
  ];

  return (
    <div style={{ paddingLeft: 10 }}>
      {rt.status === "connected" && rt.tablesAt && (
        <div className="dbx-tree-note" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>表结构读取于 {new Date(rt.tablesAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
          <button type="button" className="dbx-lk" onClick={() => void refreshMeta(connId)}>
            刷新
          </button>
        </div>
      )}
      {sections.map((s) => {
        const isOpen = groups[s.key] || (!!filter && s.list.length > 0);
        return (
          <div key={s.key}>
            <button type="button" className="dbx-sgroup" onClick={() => setGroups({ ...groups, [s.key]: !groups[s.key] })}>
              <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={11} />
              {s.label}
              <span className="dbx-cnt">{thousands(s.list.length)}</span>
            </button>
            {isOpen && s.list.slice(0, LIMIT).map((t) => (
              <TableRow
                key={`${s.key}:${t.name}`}
                connId={connId}
                table={t}
                zh={names[t.name.toLowerCase()]}
                fav={isFav("table", t.name)}
                onToggleFav={() => toggleFavorite(connId, "table", t.name)}
                onMenu={tableMenu}
              />
            ))}
            {isOpen && s.list.length > LIMIT && <p className="dbx-tree-note">只显示前 {LIMIT} 张，继续输入关键字缩小范围</p>}
          </div>
        );
      })}
      {rt.status === "connected" && (
        <div>
          <button type="button" className="dbx-sgroup" onClick={() => setGroups({ ...groups, obj: !groups.obj })}>
            <Icon name={groups.obj ? "chevronDown" : "chevronRight"} size={11} />
            其它对象
            <span className="dbx-cnt">{thousands((objs ?? []).length)}</span>
          </button>
          {groups.obj && !objs && <p className="dbx-tree-note" style={{ paddingLeft: 25 }}>读取对象…</p>}
          {groups.obj && objErr && <p className="dbx-tree-note" style={{ paddingLeft: 25 }}>读不到其它对象：{objErr}</p>}
          {groups.obj && objs && objSections.length === 0 && !objErr && (
            <p className="dbx-tree-note" style={{ paddingLeft: 25 }}>这个账号下没有包 / 过程 / 序列等对象</p>
          )}
          {groups.obj &&
            objSections.map((g) => (
              <div key={g.label}>
                <div className="dbx-tree-note" style={{ paddingLeft: 14 }}>{g.label} · {g.list.length}</div>
                {g.list.slice(0, LIMIT).map((o) => {
                  const fav = isFav("object", o.name, o.type);
                  return (
                    <button
                      key={`${o.type}:${o.name}`}
                      type="button"
                      className="dbx-trow"
                      style={{ paddingLeft: 25 }}
                      aria-label={`${o.name.toLowerCase()} · ${o.type}${o.status === "INVALID" ? "（失效：编译有错）" : ""}${fav ? "，已收藏" : ""}`}
                      title={`${o.name.toLowerCase()} · ${o.type}${o.status === "INVALID" ? "（失效：编译有错）" : ""}`}
                      onClick={() => openTableTab(connId, o.name, "source", o.type)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        objMenu(o, e.clientX, e.clientY);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
                        e.preventDefault();
                        const r = e.currentTarget.getBoundingClientRect();
                        objMenu(o, r.left + 12, r.bottom);
                      }}
                    >
                      <Icon name={g.icon} size={12} />
                      <span className="nm">{o.name.toLowerCase()}</span>
                      {o.status === "INVALID" && <span className="ty">失效</span>}
                      <FavStar
                        fav={fav}
                        name={o.name.toLowerCase()}
                        onToggle={() => toggleFavorite(connId, "object", o.name, o.type)}
                      />
                    </button>
                  );
                })}
                {g.list.length > LIMIT && <p className="dbx-tree-note" style={{ paddingLeft: 25 }}>只显示前 {LIMIT} 个，继续输入关键字缩小范围</p>}
              </div>
            ))}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
