import type { monaco } from "./monacoSetup";
import type { SqlAssistPreview } from "./sqlAssistPreview";

export type SqlCompletionItem = monaco.languages.CompletionItem & {
  ncforgeExplicit?: true;
  ncforgeSource?: string;
  ncforgeColumnKeys?: { primary: boolean; foreign: boolean; detail: string };
  ncforgePreview?: SqlAssistPreview;
  ncforgePicker?: true;
  ncforgeApply?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
};

/** A generated edit can be accepted only after the user chooses it in the list. */
export function sqlExplicit<T extends monaco.languages.CompletionItem>(item: T): T & { ncforgeExplicit: true } {
  return { ...item, ncforgeExplicit: true };
}
