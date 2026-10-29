import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  dbConnect,
  dbDefaults,
  dbDisconnect,
  dbQuery,
  dbTables,
  friendlyDbError,
  parseDbError,
  precheckSql,
  type DbConnectResult,
  type QueryResult,
} from "../lib/db";

/**
 * 数据库页的会话状态：连接、查询、表名缓存。
 *
 * **不自动连接**是刻意的：一进页面就连库，进的是测试库还好，万一 prop.xml 指着生产，
 * 就成了「点开一个标签页就多了一个生产会话」。这里要求点一次「连接」。
 *
 * 只读不靠这个 hook 保证——语句白名单、只读事务、执行后 rollback 都在 Java 桥里。
 */
export function useDbSession() {
  const qc = useQueryClient();

  const defaults = useQuery({
    queryKey: ["db-defaults"],
    queryFn: dbDefaults,
    staleTime: 10_000,
    retry: false,
  });

  const [conn, setConn] = useState<DbConnectResult | null>(null);
  const [connError, setConnError] = useState<unknown>(null);
  const [connecting, setConnecting] = useState(false);
  /** 需要用户手输密码（首次，或 DPAPI 解不开）。 */
  const [askPassword, setAskPassword] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  /**
   * run 的在途标记。`running` state 驱动按钮文字，这个 ref 挡连按——
   * Ctrl+Enter 连按两次时，两个事件处理器可能拿着同一次渲染的闭包，
   * 里面的 `running` 都还是 false，只有 ref 是同步置位的。
   */
  const runningRef = useRef(false);

  // 表名列表只为两件事：表结构计数、以及「表名写错」时给相近建议
  const tables = useQuery({
    queryKey: ["db-tables"],
    queryFn: dbTables,
    enabled: conn !== null,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const connect = async (password?: string) => {
    setConnecting(true);
    setConnError(null);
    try {
      const c = await dbConnect(password);
      setConn(c);
      setAskPassword(false);
      setQueryError(null);
      void qc.invalidateQueries({ queryKey: ["db-tables"] });
      return true;
    } catch (e) {
      const { code } = parseDbError(e);
      if (code === "need-password") setAskPassword(true);
      setConnError(e);
      return false;
    } finally {
      setConnecting(false);
    }
  };

  const run = async (sql: string, maxRows: number, timeoutSec: number) => {
    // 在途期间后续调用直接放行掉：两个 dbQuery 并发时，finally 会把先结束的
    // 那个的 running 置 false（另一个还在飞），结果页还会被先发后回的响应
    // 覆盖成旧数据。按钮 disabled 挡得住鼠标，Ctrl+Enter 不过按钮。
    if (runningRef.current) return;
    const bad = precheckSql(sql);
    if (bad) {
      setQueryError(`sql|${bad}`);
      setResult(null);
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setQueryError(null);
    try {
      const r = await dbQuery(sql, maxRows, timeoutSec);
      setResult(r);
    } catch (e) {
      setQueryError(typeof e === "string" ? e : String(e));
      setResult(null);
      // 连不上 / 认证失效时，连接胶囊不能继续显示「已连接」
      const { code } = parseDbError(e);
      if (code === "unreachable" || code === "auth") setConn(null);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const disconnect = async () => {
    try {
      await dbDisconnect();
    } finally {
      setConn(null);
      setResult(null);
      setQueryError(null);
      void qc.invalidateQueries({ queryKey: ["db-tables"] });
    }
  };

  return {
    defaults,
    conn,
    connError,
    connecting,
    askPassword,
    setAskPassword,
    tables,
    result,
    queryError,
    setQueryError,
    running,
    connect,
    run,
    disconnect,
    friendly: friendlyDbError,
  };
}
