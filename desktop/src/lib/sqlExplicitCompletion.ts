import type { monaco } from "./monacoSetup";

export type SqlCompletionItem = monaco.languages.CompletionItem & { ncforgeExplicit?: true };

/** A generated edit can be accepted only after the user chooses it in the list. */
export function sqlExplicit<T extends monaco.languages.CompletionItem>(item: T): T & { ncforgeExplicit: true } {
  return { ...item, ncforgeExplicit: true };
}
