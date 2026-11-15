import { useSyncExternalStore } from "react";
import { setSession } from "./workspaceSession";
export type RelationView = "references" | "calls" | "types" | "assembly";
let view: RelationView = "references";
const listeners = new Set<() => void>();
const subscribe = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
export function selectRelationView(next: RelationView) { view = next; listeners.forEach(callback => callback()); setSession({ panelOpen: true, panelTab: "relations" }); }
export const useRelationView = () => useSyncExternalStore(subscribe, () => view, () => view);
