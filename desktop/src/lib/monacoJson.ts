import type * as Monaco from "monaco-editor";

/**
 * JSON 的轻量着色（只高亮，不带语言服务 worker）。
 *
 * 为什么不用 Monaco 自带的 json：0.52 里它在 `vs/language/json`，是带 worker
 * 的完整语言服务（校验/补全），与壳子「只引基础语言、getWorker 只给 EditorWorker」
 * 的纪律冲突——引了它，json worker 会拿到错误的 EditorWorker。NC 工程里的
 * JSON 是接口配置，看一眼结构就够，校验不是这一层的事。
 *
 * 键名走 keyword 色（主题里映射主色），与字符串值区分；容忍 // 与块注释
 * （现场配置常是 JSONC 写法），不做合法性判定。
 */
let wired = false;
export function registerJsonLanguage(monaco: typeof Monaco): void {
  if (wired) return;
  wired = true;
  monaco.languages.register({ id: "json", extensions: [".json"], aliases: ["JSON"] });
  monaco.languages.setLanguageConfiguration("json", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"]],
    autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: '"', close: '"', notIn: ["string"] }],
    surroundingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: '"', close: '"' }],
  });
  monaco.languages.setMonarchTokensProvider("json", {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "keyword"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
        [/\b(?:true|false|null)\b/, "keyword"],
        [/[{}[\],:]/, "delimiter"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@block"],
        [/\s+/, "white"],
      ],
      block: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });
}