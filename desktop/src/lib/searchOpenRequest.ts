/** Searches share the file tree's project-switch and JAR opening pipeline. */
export type SearchOpenRequest =
  | { kind: "library"; hit: import("./libraryFiles").LibraryHit }
  | { kind: "file"; path: string; line: number; column?: number }
  | { kind: "jar"; jar: string; className: string; line: number; source: boolean };
const pending: SearchOpenRequest[] = [];
const listeners = new Set<(request: SearchOpenRequest) => void>();
export function requestSearchOpen(request: SearchOpenRequest): void {
  if (listeners.size) listeners.forEach(listener => listener(request));
  else { pending.push(request); if (pending.length > 8) pending.shift(); }
}
export function subscribeSearchOpen(listener: (request: SearchOpenRequest) => void): () => void {
  listeners.add(listener);
  for (const request of pending.splice(0)) listener(request);
  return () => { listeners.delete(listener); };
}
