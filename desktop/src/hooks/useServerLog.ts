import { useCallback, useEffect, useRef, useState } from "react";
import { serverLog } from "../lib/server";
import { appendChunk, emptyLogState, type LogLine, type LogState } from "../lib/serverLog";

/**
 * 服务日志的增量轮询。
 *
 * 抽成 hook 的原因有两个：面板组件要同时管过滤、跟随、换行、复制，
 * 再塞进拉取逻辑会突破「单文件 8 个 useState+useEffect」的体量门禁；
 * 而这套 offset/in-flight 逻辑本身与渲染无关，单独看懂它更容易。
 *
 * `inFlight` 不是可有可无的：日志文件在慢盘上读一次可能超过 500ms，
 * 两个请求都拿着同一个 offset，第二批内容会重复插进列表。
 *
 * `epochRef` 同理：点启动会换一代日志（后端把旧文件轮转成 .1），
 * 而上一代的拉取请求可能还在路上。它回来时若直接落笔，旧内容会插进新一代，
 * offset 还会被旧文件的长度带偏——新一代的头几行就永远对不上了。
 */
export function useServerLog(active: boolean, generation: number) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef(0);
  const stateRef = useRef<LogState>(emptyLogState());
  const inFlight = useRef(false);
  /** 日志「代」：reset（换一代 / 用户清空）时 +1，在途回来对不上号就整份丢弃。 */
  const epochRef = useRef(0);

  const tick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const epoch = epochRef.current;
    try {
      const chunk = await serverLog(offsetRef.current);
      // 对不上号 = 这趟是上一代日志的：内容、偏移都不能要
      if (epoch !== epochRef.current) return;
      offsetRef.current = chunk.offset;
      if (chunk.text) {
        stateRef.current = appendChunk(stateRef.current, chunk.text);
        setLines(stateRef.current.lines);
      }
      setError(null);
    } catch (e) {
      // 轮询每 0.5 秒一次，失败时弹 toast 会刷屏；把原因留在面板上
      if (epoch !== epochRef.current) return;
      setError(String(e));
    } finally {
      inFlight.current = false;
      // 换代发生在在途期间：新一代的第一次拉取被 inFlight 挡掉了，在这里补上。
      // 不补的话，停止状态下（没有 interval）新日志一屏都不会出现。
      if (epoch !== epochRef.current) void tick();
    }
  }, []);

  /** 从零重读（换一代日志、或用户清空日志之后）。 */
  const reset = useCallback(() => {
    offsetRef.current = 0;
    stateRef.current = emptyLogState();
    epochRef.current += 1;
    setLines([]);
  }, []);

  // 换一代（点启动）：后端已把旧日志轮转成 .1，这里跟着从头读
  useEffect(() => {
    reset();
    void tick();
  }, [generation, reset, tick]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => void tick(), 500);
    return () => window.clearInterval(id);
  }, [active, tick]);

  // 停止后补拉尾部。服务崩掉时，最后的堆栈往往写在「最后一次轮询」到「进程消失」
  // 之间——active 一关就停轮询，那段永远看不见，而排查崩溃偏偏只看那段。
  // 两拍：立刻一拍（进程可能还在 flush），第一拍**读完之后**再等 800ms 一拍
  // （落盘慢的机器）。第二拍不能做成固定定时：第一拍还没回来时它会被 inFlight
  // 整个挡掉，慢盘上等于没有第二拍。
  const wasActive = useRef(active);
  useEffect(() => {
    const prev = wasActive.current;
    wasActive.current = active;
    if (!prev || active) return;
    let cancelled = false;
    void (async () => {
      await tick();
      await new Promise((r) => window.setTimeout(r, 800));
      if (!cancelled) await tick();
    })();
    return () => {
      cancelled = true;
    };
  }, [active, tick]);

  return { lines, error, reset };
}
