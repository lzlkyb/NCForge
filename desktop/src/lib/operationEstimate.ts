export interface OperationEstimate {
  minSeconds: number;
  maxSeconds: number;
  validUntil: number;
}

type Sample = { done: number; at: number };

/** Measure progress within one phase and one total. A quiet stream cannot keep an ETA alive. */
export function createOperationEstimator() {
  let scope: string | undefined;
  let samples: Sample[] = [];
  let estimate: OperationEstimate | undefined;
  return (phase: string, done: number, total: number | null | undefined, at = Date.now()): OperationEstimate | undefined => {
    const next = `${phase}:${total}`;
    const last = samples[samples.length - 1];
    if (next !== scope || (last && (done < last.done || at - last.at >= 4_000))) {
      scope = next;
      samples = [];
      estimate = undefined;
    }
    if (total == null || !Number.isFinite(total) || !Number.isFinite(done) || done < 0 || done >= total) {
      samples = [];
      return estimate = undefined;
    }
    const previous = samples[samples.length - 1];
    if (previous && at - previous.at < 1_000) return estimate;
    samples = [...samples.slice(-5), { done, at }];
    if (samples.length < 4 || at - samples[0].at < 5_000) return estimate = undefined;
    const rates = samples.slice(1).map((sample, i) =>
      (sample.done - samples[i].done) / ((sample.at - samples[i].at) / 1000));
    const min = Math.min(...rates), max = Math.max(...rates);
    if (min <= 0 || max > min * 2) return estimate = undefined;
    const remaining = total - done;
    return estimate = {
      minSeconds: Math.floor(remaining / max / 5) * 5,
      maxSeconds: Math.ceil(remaining / min / 5) * 5,
      validUntil: at + 4_000,
    };
  };
}

export function estimateText(estimate: OperationEstimate | undefined, now = Date.now()): string | undefined {
  if (!estimate || estimate.validUntil <= now) return undefined;
  let { minSeconds: min, maxSeconds: max } = estimate;
  let unit = "秒";
  if (max >= 120) {
    min = Math.floor(min / 60);
    max = Math.ceil(max / 60);
    unit = "分钟";
  }
  return min === 0 ? `预计还需不到 ${max} ${unit}` : `预计还需约 ${min === max ? max : `${min}–${max}`} ${unit}`;
}
