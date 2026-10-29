import { useSyncExternalStore } from "react";

/**
 * 模块级会话态工厂（P2-9）。
 *
 * 页面按 tab 切换，`ErrorBoundary key={activeTab}` 一换 tab 就整棵子树卸载，
 * 组件里的 useState 全丢。workspaceSession（文件页）与 searchStore（搜索页）
 * 已各自手写了一份「模块级 + 订阅」；数据库页、服务页日志面板、版本控制页
 * 有同样的丢状态问题（切页回来 SQL 草稿/日志过滤器/选中项全没），这里把
 * 共同机制抽成工厂，三个页面各建一个薄 store，不再每页手抄 listeners。
 *
 * 与 useState 的关键差异：状态活在模块作用域，组件只是订阅者——卸载再挂载
 * 读到的是同一份快照。set 用 patch 合并（对象语义），逐字段比较，全等则不广播
 * （避免 `set({ keyword })` 传入同值也触发一次重渲染）。
 *
 * 为何不用 searchStore 那种「useState 初始读 + 双写」：双写漏一处就等于
 * 该字段切页即丢，且没有编译期保护。订阅式单一数据源没有这个失效模式。
 */
export interface SessionStore<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(cb: () => void): () => void;
}

export function createSessionStore<T extends object>(initial: T): SessionStore<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T>) {
      let touched = false;
      for (const k of Object.keys(patch) as (keyof T)[]) {
        if (patch[k] !== state[k]) {
          touched = true;
          break;
        }
      }
      if (!touched) return;
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/**
 * 订阅一个会话态仓库。
 *
 * 用 useSyncExternalStore 而不是 useState + useEffect 补订阅：仓库在组件卸载
 * 期间仍可能被写（异步回调、事件），重新挂载时必须**首帧**就是最新快照，
 * effect 补一次 setState 会先渲染一帧旧值。
 */
export function useSessionStore<T extends object>(store: SessionStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
