import { currentDocumentOutline } from "./documentOutlineModel";
import { captureNavOrigin, recordNavJump, type NavPoint } from "./navHistory";
import { chainAt } from "./symbols";

function withSymbol(point: NavPoint): NavPoint {
  return { ...point, symbol: chainAt(currentDocumentOutline(point.path), point.line).slice(-1)[0]?.name };
}

export function captureFileJumpOrigin(): NavPoint | null {
  const point = captureNavOrigin();
  return point ? withSymbol(point) : null;
}

export function recordFileJump(origin: NavPoint | null, target: NavPoint): void {
  recordNavJump(origin, withSymbol(target));
}
