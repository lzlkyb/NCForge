import { createSessionStore, useSessionStore } from "./sessionStore";

export type LevelFilter = "all" | "warn" | "error";

/**
 * 服务页日志面板的会话态（P2-9）：级别 / 关键字过滤 + 跟随 / 自动换行。
 *
 * 排查问题的常见动线：服务页看日志 → 文件页改代码 → 回来看新日志。过滤器
 * 一丢，回来面对 4000 行从头翻。日志正文（useServerLog）不归这里管——
 * 那是轮询数据，有独立的 generation 生命周期。
 */
export interface LogPanelForm {
  level: LevelFilter;
  keyword: string;
  follow: boolean;
  wrap: boolean;
}

export const logPanelStore = createSessionStore<LogPanelForm>({
  level: "all",
  keyword: "",
  follow: true,
  wrap: false,
});

export const useLogPanelForm = (): LogPanelForm => useSessionStore(logPanelStore);
