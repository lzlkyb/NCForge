import type { EditorPrefs } from "../../lib/editorPrefs";
import "../../settings-previews.css";

export function EditorPreview({ prefs: p }: { prefs: EditorPrefs }) {
  // Older preference files were not range-checked; a preview must not allocate from that value.
  const indent = p.insertSpaces ? " ".repeat(Math.min(12, Math.max(1, Math.floor(Number(p.tabSize) || 4)))) : "\t";
  return <figure className="settings-editor-preview" aria-label="代码显示预览">
    <figcaption>代码预览 <span>当前字体、字号与缩进</span></figcaption>
    <div className="editor-preview-frame">
      {p.stickyScroll && <div className="editor-preview-sticky">public class Demo {"{"}</div>}
      <div className="editor-preview-body">
        <pre className="editor-preview-lines" style={{ fontSize: p.fontSize }} aria-hidden="true">1{"\n"}2{"\n"}3{"\n"}4{"\n"}5</pre>
        <pre className="editor-preview-code" style={{
          fontFamily: p.fontFamily || '"Cascadia Mono", Consolas, monospace',
          fontSize: p.fontSize, tabSize: p.tabSize, whiteSpace: p.wordWrap ? "pre-wrap" : "pre",
        }}><span className="editor-preview-keyword">public class</span> Demo {"{"}{"\n"}
          {indent}<span className="editor-preview-keyword">public void</span> execute() {"{"}{"\n"}
          {indent.repeat(2)}String message = <span className="editor-preview-string">"NC 开发工作台"</span>;{p.errorLens && <span className="editor-preview-hint"> // 未使用的变量（诊断示例）</span>}{"\n"}
          {indent}{"}"}{"\n"}{"}"}
        </pre>
        {p.minimap && <div className="editor-preview-minimap" aria-hidden="true"><i /><i /><i /><i /><i /></div>}
      </div>
    </div>
  </figure>;
}
