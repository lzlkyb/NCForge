import { useEffect } from "react";
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

  useEffect(() => {
    setNavHandler((t) => {
      if (t.kind === "file") void openAt(t.path, t.line);
      else void openJdt(t.uri, t.line);
    });
    return () => setNavHandler(null);
  }, [openAt, openJdt]);
}
