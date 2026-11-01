import { useState, type HTMLAttributes } from "react";
import { ViewActivityContext, useViewActive } from "../../lib/viewActivity";

/** 首次访问才挂载，离开仅隐藏；表单草稿和滚动位置属于原来的 DOM。 */
export function ActivityPanel({ active, children, className = "", ...props }: HTMLAttributes<HTMLDivElement> & { active: boolean }) {
  // visited 用 state 而不是 render 期写 ref：React 可能丢弃未提交的渲染，
  // ref 却已经被改掉——面板会以「访问过」的身份挂载出空内容。
  // 渲染期 setState 是 React 官方的「随 props 调整 state」写法，会立即重渲染。
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  const parentActive = useViewActive();
  if (!visited) return null;
  return (
    <ViewActivityContext.Provider value={active && parentActive}>
      <div {...props} hidden={!active} style={{ ...props.style, display: active ? undefined : "none" }} className={className}>
        {children}
      </div>
    </ViewActivityContext.Provider>
  );
}
