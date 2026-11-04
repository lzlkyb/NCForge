import { Icon } from "../ui/icon";
import type { Appearance } from "../../lib/appearance";
import type { UiDensity } from "../../lib/uiDensity";
import type { Theme } from "../../lib/theme";
import "../../settings-previews.css";

export function AppearancePreview({ theme, density, appearance }: {
  theme: Theme; density: UiDensity; appearance: Appearance;
}) {
  return <figure className="settings-appearance-preview" data-theme={theme}
    data-density={density} data-material={appearance} aria-label="工作台外观预览">
    <figcaption>工作台预览 <span>随当前选择变化</span></figcaption>
    <div className="appearance-preview-window" aria-hidden="true">
      <div className="appearance-preview-chrome"><b>NCForge</b><span>NC 开发工作台</span></div>
      <div className="appearance-preview-body">
        <div className="appearance-preview-nav"><span className="selected"><Icon name="file" size={13} />文件</span><span>数据库</span><span>设置</span></div>
        <div className="appearance-preview-document"><div className="appearance-preview-tab">Demo.java</div>
          <pre><span>public class</span> Demo {"{"}{"\n"}{"    "}<span>public void</span> execute() {"{"}{"\n"}{"        "}System.out.println("NCForge");{"\n"}{"    }\n}"}</pre>
        </div>
      </div>
    </div>
  </figure>;
}
