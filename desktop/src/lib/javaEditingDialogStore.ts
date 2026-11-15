import { useSyncExternalStore } from "react";
import type { monaco } from "./monacoSetup";

export interface ImportChoice { simple: string; names: { name: string; source: string; library: boolean }[]; }
export interface JavaImportRequest {
  editor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
  version: number;
  epoch: number;
  path: string;
  choices: ImportChoice[];
  notes: string[];
}
type DialogState = { kind: "imports"; request: JavaImportRequest } | { kind: "templates" } | null;
let dialog: DialogState = null;
const listeners = new Set<() => void>();
export function showJavaEditingDialog(next: DialogState): void { dialog = next; listeners.forEach(listener => listener()); }
export function getJavaEditingDialog(): DialogState { return dialog; }
export function useJavaEditingDialog(): DialogState { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getJavaEditingDialog, getJavaEditingDialog); }
