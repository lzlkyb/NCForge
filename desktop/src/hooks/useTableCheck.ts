import { useCallback, useEffect, useState } from "react";
import {
  dbCheckSources,
  dbSchemaStatus,
  dbSchemaSync,
  type SchemaStatus,
  type SourceCheck,
} from "../lib/db";

/**
 * 表结构核对的状态机。
 *
 * 抽出来是因为它有三份互相牵制的状态：缓存有没有、这次核对跑没跑、错误是什么。
 * 而且「勾选一变，上次结果就作废」这条规则容易漏——留在组件里迟早会被改坏。
 */
export function useTableCheck(files: string[]) {
  const [schema, setSchema] = useState<SchemaStatus | null>(null);
  const [result, setResult] = useState<SourceCheck | null>(null);
  const [running, setRunning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setSchema(await dbSchemaStatus());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // 勾选变了，上次的结果就对不上这一批文件了——不能拿旧结果给新的一批背书
  const fileKey = files.join("|");
  useEffect(() => {
    setResult(null);
  }, [fileKey]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await dbCheckSources(files));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
    // files 每次渲染都是新数组，用 fileKey 代替它做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      setSchema(await dbSchemaSync());
      // 工作区里表名悬停也靠这份缓存，通知它重取
      window.dispatchEvent(new Event("schemachange"));
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  return { schema, result, running, syncing, error, run, sync };
}
