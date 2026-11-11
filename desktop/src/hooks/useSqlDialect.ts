import { useDbSelector } from "../lib/dbStore";
import { sqlLanguageOf } from "../lib/sqlFormat";
import { useSqlFormatPrefs } from "../lib/sqlFormatPrefs";

/** Keep highlighting and formatting on the same connection/manual dialect without remounting Monaco. */
export function useSqlDialect(id: string | undefined, byTab = false) {
  const url = useDbSelector(s => {
    const connId = byTab ? s.tabs.find(tab => tab.id === id)?.connId : id;
    return connId ? s.rt[connId]?.info?.url ?? s.conns.find(conn => conn.id === connId)?.url ?? "" : "";
  });
  const prefs = useSqlFormatPrefs();
  return sqlLanguageOf(url, prefs);
}
