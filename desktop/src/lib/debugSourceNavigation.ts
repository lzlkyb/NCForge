import type { DebugTarget } from "./debug";
import { getSession } from "./workspaceSession";
import { workspaceEpoch } from "./workspaceEpoch";

const pending = new Map<DebugTarget, { seq: number; path: string | null; epoch: number; consumed: boolean }>();
/** A paused frame can arrive after the user has already moved to another source file. */
export function prepareDebugSourceNavigation(target: DebugTarget, seq: number): void {
  pending.set(target, { seq, path: getSession().activePath, epoch: workspaceEpoch(), consumed: false });
}
export function claimDebugSourceNavigation(target: DebugTarget, seq: number): boolean {
  const request = pending.get(target);
  if (!request || request.seq !== seq || request.consumed) return false;
  request.consumed = true;
  return request.epoch === workspaceEpoch() && request.path === getSession().activePath;
}
