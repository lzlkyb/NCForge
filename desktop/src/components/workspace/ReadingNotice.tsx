import type { ReactNode } from "react";
import { Icon } from "../ui/icon";

export function ReadingNotice({ summary, detail, children, dismiss }: { summary: string; detail: string; children?: ReactNode; dismiss?: () => void }) {
  return <div className="wb-banner wb-banner-summary">
    <Icon name="info" size={14} /><span>{summary}</span>
    <details><summary>详情</summary><p>{detail}</p></details>
    {children}{dismiss && <button type="button" className="wb-banner-x" title="关闭提示" aria-label="关闭提示" onClick={dismiss}><Icon name="close" size={12} /></button>}
  </div>;
}
