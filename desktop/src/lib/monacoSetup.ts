// Monaco 编辑器初始化：只引入编辑器核心 + NC 用得到的语言，不走 CDN，不带 TS/JSON/CSS 的语言服务 worker。
// 语言智能（补全/跳转/诊断）由之后 M4 的 jdt.ls 提供，这里只负责显示与编辑。
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/editor.all";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { getStoredTheme, type Theme } from "./theme";
import { getTableLookup } from "./tableLookup";
import { OPEN_TABLE_COMMAND, buildTableHover } from "./tableHover";
import { openTableInDb } from "./openTableFromHover";

self.MonacoEnvironment = {
  // 只有基础 worker（diff / 单词补全等），所有 label 共用。
  getWorker: () => new EditorWorker(),
};

/** 读一个 `--xxx: H S% L%` 形式的 CSS 变量，转成 `#rrggbb`（Monaco 主题只认十六进制）。 */
function tokenHex(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = raw.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (!m) return "#808080";
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const THEME_NAME = "nc-forge";

/** 用壳子的真实 token 重建 Monaco 主题；切换浅/深色后需要再调一次。 */
export function applyMonacoTheme(theme: Theme): void {
  const bg = tokenHex("--card");
  const fg = tokenHex("--foreground");
  const muted = tokenHex("--muted-foreground");
  const border = tokenHex("--border");
  const primary = tokenHex("--primary");
  const accent = tokenHex("--accent");
  const strip = (hex: string) => hex.slice(1);
  monaco.editor.defineTheme(THEME_NAME, {
    base: theme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: strip(primary) },
      { token: "string", foreground: strip(tokenHex("--success-ink")) },
      { token: "comment", foreground: strip(muted), fontStyle: "italic" },
      { token: "type", foreground: strip(tokenHex("--warning-ink")) },
      { token: "number", foreground: strip(tokenHex("--destructive-ink")) },
    ],
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      "editorLineNumber.foreground": muted,
      "editorLineNumber.activeForeground": fg,
      "editor.lineHighlightBackground": accent + "99",
      "editorCursor.foreground": primary,
      "editorIndentGuide.background1": border,
      "editorWidget.background": bg,
      "editorWidget.border": border,
      "editorSuggestWidget.background": bg,
      "editorSuggestWidget.border": border,
      "scrollbarSlider.background": border + "99",
    },
  });
  monaco.editor.setTheme(THEME_NAME);
}

let themeWired = false;
let hoverWired = false;
let cmdWired = false;

/**
 * 悬停卡片里那个「在数据库中打开」链接的信任白名单。
 *
 * **不要写成 `isTrusted: true`**：那等于允许卡片里的任意 `command:` 链接执行任意
 * 命令（内容一旦被拼脏就是一条提权路径）。给数组时 Monaco 只放行列出的命令
 * （`markdownRenderer.js` 的 `toAllowCommandsOption`）。
 */
const HOVER_TRUSTED = { enabledCommands: [OPEN_TABLE_COMMAND] };

/**
 * 注册「在数据库中打开」命令。
 *
 * 坑：`run` 的签名是 `(accessor, ...args)`，**第一个参数是服务访问器**，命令参数
 * 从第二个开始。写成 `run: (table) => …` 会拿到一个对象，表现就是"点了没反应"。
 */
function wireTableCommand(): void {
  if (cmdWired) return;
  cmdWired = true;
  monaco.editor.addCommand({
    id: OPEN_TABLE_COMMAND,
    run: (_accessor, table?: unknown) => {
      if (typeof table === "string" && table) void openTableInDb(table);
    },
  });
}

/**
 * 在 Java 文件里悬停表名，显示这张表的字段。
 *
 * 几点取舍：
 * - 只在**字符串字面量里**生效：`String pam_equip` 这种 Java 标识符不该弹表结构。
 * - 只认「词本身是表名」：`e.pk_used_status` 里的别名 `e` 全工作区可能指一百张表，
 *   解析它需要整段 SQL 的上下文，这里不做（会误报）。
 * - 内容用 Markdown 表格：Monaco 的浮层只吃得下 Markdown/文本，做不出自定义卡片。
 *   内容怎么拼由 `tableHover.buildTableHover` 负责（可单测），这里只做适配。
 */
function wireTableHover(): void {
  if (hoverWired) return;
  hoverWired = true;
  monaco.languages.registerHoverProvider("java", {
    provideHover: async (model, position) => {
      const lookup = getTableLookup();
      if (!lookup) return null;
      const line = model.getLineContent(position.lineNumber);
      const hit = await buildTableHover(line, position.column, lookup);
      if (!hit) return null;
      return {
        range: new monaco.Range(
          position.lineNumber,
          hit.start + 1,
          position.lineNumber,
          Math.max(hit.end, hit.start + 1),
        ),
        // isTrusted 只放行我们自己的命令：卡片正文是拼出来的 Markdown，
        // 给 true 就等于让里面任何 `command:` 链接都能执行
        contents: [{ value: hit.markdown, isTrusted: HOVER_TRUSTED }],
      };
    },
  });
}

/** 首次使用前调用：建主题并跟随壳子的 `themechange` 事件。幂等。 */
export function initMonaco(): typeof monaco {
  if (!themeWired) {
    themeWired = true;
    applyMonacoTheme(getStoredTheme());
    // 事件在 applyTheme 里的 class 切换之后发出，此时 getComputedStyle 读到的已是新主题的变量。
    window.addEventListener("themechange", (e) => applyMonacoTheme((e as CustomEvent<Theme>).detail));
  }
  wireTableHover();
  wireTableCommand();
  return monaco;
}

export { monaco };
