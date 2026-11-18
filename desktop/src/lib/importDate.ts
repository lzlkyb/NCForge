/**
 * 日期列的解析格式：推断 + 歧义判定。
 *
 * **为什么需要**：`sql_export::literal` 只认 ISO 连字符（`2026-11-17`），其余一律退成
 * 字符串交给 Oracle 隐式转换，按 NLS 口径报 ORA-01861；更糟的是 `02/03/2026` 这类
 * 值会被**静默**解析成另一个日期。国内 Excel 导出的默认格式恰好就是斜杠。
 *
 * **为什么不猜**：`01/02/2026` 同时满足「日/月/年」与「月/日/年」，任何自动选择都是在
 * 二选一地赌。所以推断只负责给出候选，歧义时必须由人确认；也**不做按表持久化**——
 * 同名列下个月的导出格式可能来自另一个系统，记住上次的选择等于把静默错误自动化。
 *
 * 键与后端 `sql_export::preset_fmt` 的白名单一一对应：前端只传键，格式串永远不出前端。
 */

export interface DatePreset {
  /** 传给后端的键（`preset_fmt` 认这个）。 */
  id: string;
  /** 给用户看的样例，比 `YYYY/MM/DD` 更好认。 */
  sample: string;
  /** 必须整串匹配。 */
  re: RegExp;
  /** 捕获组 → 月/日是否落在合法区间（不查 2 月 30 日，那种让数据库报更准）。 */
  valid: (m: RegExpMatchArray) => boolean;
}

const monthDay = (mo: string, d: string) => +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31;

export const DATE_PRESETS: DatePreset[] = [
  { id: "iso", sample: "2026-11-17", re: /^(\d{4})-(\d{2})-(\d{2})$/, valid: (m) => monthDay(m[2], m[3]) },
  { id: "iso-ts", sample: "2026-11-17 09:30:00", re: /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/, valid: (m) => monthDay(m[2], m[3]) },
  { id: "slash", sample: "2026/11/17", re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, valid: (m) => monthDay(m[2], m[3]) },
  { id: "slash-ts", sample: "2026/11/17 09:30:00", re: /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/, valid: (m) => monthDay(m[2], m[3]) },
  { id: "dot", sample: "2026.11.17", re: /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/, valid: (m) => monthDay(m[2], m[3]) },
  { id: "compact", sample: "20261117", re: /^(\d{4})(\d{2})(\d{2})$/, valid: (m) => monthDay(m[2], m[3]) },
  { id: "compact-ts", sample: "20261117093000", re: /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, valid: (m) => monthDay(m[2], m[3]) },
  // 日/月 与 月/日 共用同一个形状，靠值域区分：`25/12/2026` 只可能是日/月，
  // 而 `01/02/2026` 两者都成立 —— 这正是必须停下来问人的那一类。
  { id: "dmy-slash", sample: "17/11/2026", re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, valid: (m) => +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12 },
  { id: "mdy-slash", sample: "11/17/2026", re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, valid: (m) => +m[1] >= 1 && +m[1] <= 12 && +m[2] <= 31 },
  { id: "dmy-dash", sample: "17-11-2026", re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, valid: (m) => +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12 },
  { id: "cn", sample: "2026年11月17日", re: /^(\d{4})年(\d{1,2})月(\d{1,2})日$/, valid: (m) => monthDay(m[2], m[3]) },
];

export type DateGuess =
  /** 不是日期形状（或不一致）：不指定格式，按原值走。 */
  | { kind: "none" }
  /** 唯一确定，可直接用。 */
  | { kind: "ok"; id: string }
  /** 多个候选都成立，必须由人选。 */
  | { kind: "ambiguous"; ids: string[] };

/**
 * 按样本推断该列的日期格式。
 *
 * 只接受「所有非空样本都被这一个候选命中」的情况：混进一个 `N/A` 就退回 `none`，
 * 因为那种列本来就需要人看一眼。
 */
export function guessDateFormat(samples: string[]): DateGuess {
  const vals = samples.map((s) => s.trim()).filter((s) => s !== "");
  if (vals.length === 0) return { kind: "none" };
  const hits = DATE_PRESETS.filter((p) =>
    vals.every((v) => {
      const m = v.match(p.re);
      return !!m && p.valid(m);
    }),
  );
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1) return { kind: "ok", id: hits[0].id };
  return { kind: "ambiguous", ids: hits.map((h) => h.id) };
}

/** 目标列是不是日期类型（决定这一行要不要显示格式选择）。 */
export function isDateColumn(type: string): boolean {
  return /^DATE$/i.test(type.trim()) || /^TIMESTAMP/i.test(type.trim());
}

/** 预设 id → 给人看的样例；id 不在表里返回 `null`。 */
export function presetSample(id: string): string | null {
  return DATE_PRESETS.find((p) => p.id === id)?.sample ?? null;
}
