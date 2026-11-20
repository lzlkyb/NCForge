import type { DbConn } from "./dbApi";
import { favoriteKey, listFavorites } from "./dbFavorites";
import { connectionKey } from "./dbResultContext";
import { sqlMatchQuality } from "./sqlAssistRanking";
import { recordSqlUsage, sqlUsageKey, sqlUsageRank, sqlUsageScope, usageSnapshot } from "./sqlUsage";

export type SearchObject = { name: string; kind: string };
const tableKinds = new Set(["TABLE", "VIEW", "MATERIALIZED VIEW"]);
export const isTableObject = (object: SearchObject) => tableKinds.has((object.kind ?? "TABLE").toUpperCase());
const objectKey = (object: SearchObject) => isTableObject(object)
  ? sqlUsageKey(object.name.toLowerCase())
  : sqlUsageKey(object.name.toLowerCase(), undefined, `object:${object.kind}`);

export function rememberDbObject(conn: DbConn | null, schema: string | undefined, object: SearchObject) {
  if (conn) recordSqlUsage(sqlUsageScope(connectionKey(conn), schema), objectKey(object), "accept");
}

export function rankedDbFavorites(conn: DbConn | null, schema: string | undefined) {
  const defaultSchema = conn?.defaultSchema || conn?.user;
  return new Set(conn ? listFavorites().filter(item => item.connId === conn.id &&
    (!schema || (item.schema ?? defaultSchema)?.toUpperCase() === schema.toUpperCase()))
    .map(item => favoriteKey(item.connId, item.kind, item.name, item.otype)) : []);
}

export function rankDbObjects<T extends SearchObject>(objects: readonly T[], query: string, names: Readonly<Record<string, string>>,
  conn: DbConn | null, schema?: string, limit = 80): (T & { zh: string })[] {
  const prefix = query.trim().toLowerCase(), words = prefix ? prefix.split(/\s+/) : [], now = Date.now();
  const scope = conn ? sqlUsageScope(connectionKey(conn), schema) : null;
  const history = scope ? usageSnapshot(scope) : {};
  const favorites = rankedDbFavorites(conn, schema);
  return objects.flatMap((object, index) => {
    const zh = names[object.name.toLowerCase()] ?? "";
    let quality = 0;
    for (const word of words) {
      const match = sqlMatchQuality(word, object.name, zh);
      if (match === 9) return [];
      quality += match;
    }
    const key = objectKey(object);
    const table = isTableObject(object);
    return [{ object, index, zh, quality, usage: scope && history[key] ? sqlUsageRank(scope, key, now) : 0,
      favorite: favorites.size > 0 && favorites.has(favoriteKey(conn!.id, table ? "table" : "object", object.name, table ? undefined : object.kind)) }];
  }).sort((a, b) => a.quality - b.quality || Number(b.favorite) - Number(a.favorite)
    || b.usage - a.usage || a.index - b.index).slice(0, limit).map(({ object, zh }) => ({ ...object, zh }));
}
