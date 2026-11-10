import { useCallback, useEffect, useRef, useState } from "react";
import { dbApi, type SessionRow } from "../lib/dbApi";
import { friendlyDbError } from "../lib/db";
import { useAppHidden } from "../lib/appVisibility";
import { beginOperation } from "../lib/operations";
import { dbTaskSpec } from "../lib/dbOperations";

/**
 * 自动刷新间隔。10 秒够看清「谁锁了谁」，也是共用库上 `v$session` + `v$locked_object`
 * 能长期开着的节奏——之前 5 秒在切走页面后仍在查，等于白给数据库加压。
 */
const REFRESH_MS = 10_000;

/**
 * 会话与锁的取数与轮询。`visible: false`（所在文档标签被盖住）或窗口不可见时停轮询：
 * 抽屉是 store 级状态、切标签不关，看不见还在隔 10 秒查 `v$session` 是纯浪费。
 *
 * 切换连接时用 `generation` 作废旧请求：旧连接的结果晚到也不能显示在新连接名下。
 */
export function useSessionList(connId: string, visible: boolean) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [granted, setGranted] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const lock = useRef(false);
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const load = useCallback(async (observed = true) => {
    if (lock.current) return;
    const token = generation.current;
    lock.current = true;
    setLoading(true);
    const task = observed ? beginOperation(dbTaskSpec(`sessions:${connId}`, "读取数据库会话与锁", connId, "会话诊断")) : null;
    try {
      const r = await dbApi.sessions(connId);
      if (token !== generation.current) { task?.finish("cancelled", "会话面板已切换连接"); return; }
      setRows(r.rows ?? []);
      // 后端没给 granted 时按「有」处理：老 jar 的返回里没这个字段
      setGranted(r.granted !== false);
      setErr(null);
      setAt(Date.now());
      task?.finish("success", r.granted === false ? "会话已读取；账号无权读取完整锁信息" : `已读取 ${r.rows?.length ?? 0} 个会话`);
    } catch (e) {
      if (token !== generation.current) { task?.finish("cancelled", "会话面板已关闭或切换"); return; }
      task?.finish("failed", "会话查询失败，返回数据库会话面板查看原因");
      setErr(friendlyDbError(e));
      setRows(null);
    } finally {
      if (token === generation.current) { lock.current = false; setLoading(false); }
    }
  }, [connId]);

  useEffect(() => {
    invalidate();
    lock.current = false;
    setRows(null);
    setErr(null);
    void load();
    return invalidate;
  }, [load, invalidate]);

  const appHidden = useAppHidden();
  const paused = !auto || appHidden || !visible;
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => void load(false), REFRESH_MS);
    return () => clearInterval(t);
  }, [paused, load]);

  return { rows, granted, err, at, loading, auto, setAuto, load };
}
