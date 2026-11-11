/**
 * 搜索页的表单控制：范围/组件切换 + 搜索框键盘。
 *
 * 从 `tabs/SearchTab` 拆出：那个文件贴着 300 行上限，而这些都是与渲染无关的
 * 表单逻辑（操作 `searchStore`、解释键盘事件），放这里也能离开组件单测。
 * 「为什么换范围要清结果」的理由在 `lib/searchStore::applySearchScope` 上。
 */
import { useCallback } from "react";

import {
  applySearchScope,
  type SearchForm,
  type SearchScope,
} from "../lib/searchStore";

export function useSearchControls(handlers: {
  form: SearchForm;
  /** 离开编辑态：换范围后编辑预览里的行号只对旧结果有效。 */
  leaveEditing: () => void;
  run: () => void;
  clearQuery: () => void;
}) {
  const { form, leaveEditing, run, clearQuery } = handlers;

  const pickScope = useCallback(
    (scope: SearchScope, component: string | null) => {
      leaveEditing();
      applySearchScope(scope, component);
    },
    [leaveEditing],
  );

  const changeScope = useCallback(
    (scope: SearchScope) => {
      if (scope === form.scope) return;
      pickScope(scope, form.component);
    },
    [form, pickScope],
  );

  /** 从菜单里点了一个组件：切到组件范围（`component` 记住，切回来不用重选）。 */
  const pickComponent = useCallback(
    (name: string) => {
      if (name === form.component && form.scope === "component") return;
      pickScope("component", name);
    },
    [form, pickScope],
  );

  const onSearchKey = useCallback(
    (e: React.KeyboardEvent) => {
      // 组词的 Enter/Esc 留给输入法；部分 WebView 结束组词时仍用 229 标记。
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      if (e.key === "Enter") {
        e.preventDefault();
        run();
      } else if (e.key === "Escape") {
        e.preventDefault();
        clearQuery();
      }
    },
    [run, clearQuery],
  );

  return { changeScope, pickComponent, onSearchKey };
}
