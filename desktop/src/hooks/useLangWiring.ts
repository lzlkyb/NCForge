import { useEffect, useRef } from "react";
import { ensureLang, initLang, prepareLang, setNavHandler } from "../lib/lang";
import { initCompileMarkers } from "../lib/compileMarkers";
import { initSemanticTokens } from "../lib/semanticTokens";
import { getSession, useWorkspaceRoot } from "../lib/workspaceSession";

/**
 * 把代码智能接到文件页：
 * - 挂载时初始化一次（订阅后端事件，幂等）；
 * - 工作区就绪即**预热**（flat 冷导要几分钟，别等用户点第一个 .java 才开始）；
 * - 切到 .java 文件时确保其所在模块有语言服务（后端幂等，同工作区不重启）；
 * - 登记「跳转目标怎么打开」：F12 / Ctrl+点击落在另一个文件或 jar 内的类时由文件页切标签。
 */
export function useLangWiring({
  activePath,
  openAt,
  openJdt,
}: {
  activePath: string | null;
  openAt: (path: string, line: number, push?: boolean, column?: number, destination?: "left" | "right") => Promise<boolean>;
  openJdt: (uri: string, line: number, push?: boolean, column?: number, destination?: "left" | "right") => Promise<boolean>;
}) {
  useEffect(() => {
    void initLang();
    initSemanticTokens();
    // ecj 标记不依赖 jdt.ls：服务关着时它是编辑器里唯一能看到编译错误的途径
    initCompileMarkers();
  }, []);

  // 预热不看 activePath：用户先开的是 .md 或 .sql 时，代码智能同样该在后台准备好
  const root = useWorkspaceRoot();
  useEffect(() => {
    if (root) prepareLang(root);
  }, [root]);

  useEffect(() => {
    if (activePath) ensureLang(activePath);
  }, [activePath]);

  // 回调存 ref、handler 只登记一次：这两个回调每次渲染都是新身份，
  // 挂在 effect 依赖上等于每渲染一次就「注销 → 重设」，异步的跳转回调落在
  // 注销那一拍里就会被静默丢掉（表现是点了 F12 什么都没发生）。
  const jumpRef = useRef({ openAt, openJdt });
  jumpRef.current = { openAt, openJdt };

  useEffect(() => {
    setNavHandler(async (t) => {
      const { openAt: at, openJdt: toJdt } = jumpRef.current;
      const root = getSession().root;
      // The file session reads once and activates only the destination group.
      const destination = t.right ? "right" : undefined;
      const ok = await (t.kind === "file" ? at(t.path, t.line, true, t.column, destination) : toJdt(t.uri, t.line, true, t.column, destination));
      return ok && root === getSession().root;
    });
    return () => setNavHandler(null);
  }, []);
}
