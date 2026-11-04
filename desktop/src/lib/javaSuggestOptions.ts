import type { monaco } from "./monacoSetup";

/** 类名前缀靠普通打字触发；点号、注解等仍交给语义 provider 的触发字符。 */
export const javaSuggestOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  wordBasedSuggestions: "currentDocument",
  quickSuggestions: { other: "on", comments: "off", strings: "off" },
  quickSuggestionsDelay: 100,
  suggestOnTriggerCharacters: true,
  suggest: { showClasses: true, showMethods: true, showInterfaces: true },
};
