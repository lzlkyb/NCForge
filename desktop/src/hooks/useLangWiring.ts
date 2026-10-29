import { useEffect, useRef } from "react";
import { ensureLang, initLang, setNavHandler } from "../lib/lang";

/**
 * 把代码智能接到文件页：
 * - 挂载时初始化一次（订阅后端事件，幂等）；
 * - 切到 .java 文件时确保其所在模块有语言服务；
 * - 登记「跳转目标怎么打开」：F12 / Ctrl+点击落在另一个文件或 jar 内的类时由文件页切标签。
 */
export function useLangWiring({
  activePath,
  openAt,
  openJdt,
}: {
  activePath: string | null;
  openAt: (path: string, line: number) => Promise<void>;
  openJdt: (uri: string, line: number) => Promise<void>;
}) {
  useEffect(() => {
    void initLang();
  }, []);

  useEffect(() => {
    if (activePath) ensureLang(activePath);
  }, [activePath]);

  // 回调存 ref、handler 只登记一次：这两个回调每次渲染都是新身份，
  // 挂在 effect 依赖上等于每渲染一次就「注销 → 重设」，异步的跳转回调落在
  // 注销那一拍里就会被静默丢掉（表现是点了 F12 什么都没发生）。
  const jumpRef = useRef({ openAt, openJdt });
  jumpRef.current = { openAt, openJdt };

  useEffect(() => {
    setNavHandler((t) => {
      const { openAt: at, openJdt: toJdt } = jumpRef.current;
      if (t.kind === "file") void at(t.path, t.line);
      else void toJdt(t.uri, t.line);
    });
    return () => setNavHandler(null);
  }, []);
}
