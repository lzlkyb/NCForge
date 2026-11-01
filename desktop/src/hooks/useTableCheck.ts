import { useCallback, useEffect, useRef, useState } from "react";
import {
  dbCheckSources,
  dbSchemaStatus,
  dbSchemaSync,
  friendlyDbError,
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
  /**
   * 核对请求的代数。后端核对是几十秒级的 IO，回来时勾选可能已经换了一批——
   * 旧结果/旧错误写进去就是「拿上批文件的结论给这批背书」。
   */
  const gen = useRef(0);

  const loadStatus = useCallback(async () => {
    try {
      setSchema(await dbSchemaStatus());
    } catch (e) {
      setError(friendlyDbError(e));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // 勾选变了，上次的结果就对不上这一批文件了——不能拿旧结果给新的一批背书。
  // 同时也让还在飞的核对作废：它的 finally 不该把这一批的转圈关掉（那是它自己的）。
  const fileKey = files.join("|");
  useEffect(() => {
    gen.current += 1;
    setResult(null);
    setRunning(false);
  }, [fileKey]);

  const run = useCallback(async () => {
    const my = ++gen.current;
    setRunning(true);
    setError(null);
    try {
      const r = await dbCheckSources(files);
      if (gen.current === my) setResult(r);
    } catch (e) {
      if (gen.current === my) setError(friendlyDbError(e));
    } finally {
      if (gen.current === my) setRunning(false);
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
      setError(friendlyDbError(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  return { schema, result, running, syncing, error, run, sync };
}
