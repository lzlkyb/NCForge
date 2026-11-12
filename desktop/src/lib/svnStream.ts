import { mergeStreamedItems } from "./svnList";
import type { ChangesView } from "./svn";
import type { ScanUnit } from "./svn";

/**
 * 流式上屏的前端状态。
 *
 * 一次扫描进行中，`svn-scan-unit` 事件把已扫完模块的条目陆续送进来，在 `view` 里
 * 累加；`svnStatus` 的最终结果一到，整份换成规范视图（后端排好的序），这里清空。
 * 所以这个状态**只在扫描进行中非空**，它唯一的用途是「别让用户对着空白等」。
 */
export interface StreamState {
  /** 正在累积的扫描纪元；null = 没有流式数据。 */
  epoch: number | null;
  view: ChangesView | null;
}

export const emptyStream: StreamState = { epoch: null, view: null };

const emptyView: ChangesView = { groups: [], shown: 0, total: 0, ignored: 0 };

export type StreamAction =
  /** 收到一个模块的条目。`lastResultEpoch` 由调用方从 ref 读出后随动作传进来，reducer 保持纯函数。 */
  | { type: "unit"; unit: ScanUnit; lastResultEpoch: number }
  /** 最终结果已到达：流式缓冲区交回 query 数据。 */
  | { type: "reset" };

/**
 * 流式状态的 reducer。两条规则：
 *
 * 1. **结果已到的纪元一律不再接受**：`unit.epoch <= lastResultEpoch` 就丢弃。
 *    等号必须是这个语义：单元事件和 invoke 的最终结果走的是两条通道，同一个纪元的
 *    迟到事件完全可能落在结果之后（实测就是会）。用 `<` 会漏掉它们——已出结论的
 *    扫描又往屏幕上掺一个残缺流式视图，列表当着用户的面缩水。
 * 2. **换纪元重新开始**：正在累积的与新来的不是同一轮时（上一轮被杀、新一轮启动），
 *    丢弃已累积的部分，从这一轮重新算。
 */
export function reduceStream(state: StreamState, action: StreamAction): StreamState {
  if (action.type === "reset") return emptyStream;
  const { unit, lastResultEpoch } = action;
  if (unit.epoch <= lastResultEpoch) return state;
  const base = state.epoch === unit.epoch && state.view ? state.view : emptyView;
  return { epoch: unit.epoch, view: mergeStreamedItems(base, unit.items) };
}
